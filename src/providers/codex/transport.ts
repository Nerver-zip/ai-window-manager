import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const MAX_STDOUT_LINE_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const SHUTDOWN_GRACE_MS = 250;

export type CodexTransportErrorCode =
  | 'AUTH_REQUIRED'
  | 'PROTOCOL_ERROR'
  | 'TIMEOUT'
  | 'EOF'
  | 'PROCESS_ERROR'
  | 'ABORTED'
  | 'TURN_FAILED';

export type CodexTransportStage =
  'initialize' | 'rate_limits_read' | 'thread_start' | 'turn_start' | 'turn_completion';

export class CodexTransportError extends Error {
  constructor(
    readonly code: CodexTransportErrorCode,
    readonly stage?: CodexTransportStage,
  ) {
    super(`Codex app-server ${code.toLowerCase().replaceAll('_', ' ')}`);
    this.name = 'CodexTransportError';
  }
}

export type CodexProcessFactory = (
  executable: string,
  args: string[],
  options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

export interface CodexAppServerClientOptions {
  executable: string;
  codexHome: string;
  requestTimeoutMs: number;
  /** Timeout for each app-server stage of a quota-consuming turn. */
  actionTimeoutMs?: number;
  spawnProcess?: CodexProcessFactory;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
}

interface PendingRequest {
  stage: CodexTransportStage;
  resolve: (value: unknown) => void;
  reject: (error: CodexTransportError) => void;
  timeout: NodeJS.Timeout;
  abortListener?: () => void;
}

interface NotificationWaiter {
  method: string;
  predicate: (params: unknown) => boolean;
  resolve: (params: unknown) => void;
  reject: (error: CodexTransportError) => void;
  timeout: NodeJS.Timeout;
  abortListener?: () => void;
}

interface JsonRpcRecord {
  id?: unknown;
  result?: unknown;
  error?: unknown;
  method?: unknown;
  params?: unknown;
}

function defaultSpawn(
  executable: string,
  args: string[],
  options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] },
): ChildProcessWithoutNullStreams {
  return spawn(executable, args, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyProtocolError(error: unknown, stage?: CodexTransportStage): CodexTransportError {
  if (!isRecord(error)) return new CodexTransportError('PROTOCOL_ERROR', stage);

  const code = error.code;
  const message = error.message;
  const description = `${typeof code === 'string' || typeof code === 'number' ? code : ''} ${typeof message === 'string' ? message : ''}`;
  if (/auth|unauthori[sz]ed|login|sign.?in|credential/i.test(description)) {
    return new CodexTransportError('AUTH_REQUIRED', stage);
  }
  return new CodexTransportError('PROTOCOL_ERROR', stage);
}

function nestedString(value: unknown, parent: string, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[parent];
  if (!isRecord(nested)) return undefined;
  const result = nested[key];
  return typeof result === 'string' && result.length > 0 && result.length <= 256
    ? result
    : undefined;
}

export class CodexAppServerClient {
  private readonly spawnProcess: CodexProcessFactory;
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationWaiters = new Set<NotificationWaiter>();
  private readonly bufferedNotifications = new Map<string, unknown[]>();
  private readonly decoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private stderrBytes = 0;
  private terminalError: CodexTransportError | undefined;

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
  }

  async readRateLimits(signal?: AbortSignal): Promise<unknown> {
    this.start();
    try {
      await this.request(
        'initialize',
        {
          clientInfo: {
            name: 'ai-window-manager',
            title: 'AI Window Manager',
            version: '0.1.0',
          },
        },
        signal,
        'initialize',
      );
      this.sendNotification('initialized', 'initialize');
      return await this.request('account/rateLimits/read', undefined, signal, 'rate_limits_read');
    } finally {
      await this.close();
    }
  }

  async sendMessage(
    message: string,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<CodexTurnResult> {
    this.start();
    const actionTimeoutMs = this.options.actionTimeoutMs ?? this.options.requestTimeoutMs;
    try {
      await this.request(
        'initialize',
        {
          clientInfo: {
            name: 'ai-window-manager',
            title: 'AI Window Manager',
            version: '0.1.0',
          },
        },
        signal,
        'initialize',
        actionTimeoutMs,
      );
      this.sendNotification('initialized', 'initialize');

      const threadResponse = await this.request(
        'thread/start',
        {
          ephemeral: true,
          cwd: workspace,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          serviceName: 'ai-window-manager',
        },
        signal,
        'thread_start',
        actionTimeoutMs,
      );
      const threadId = nestedString(threadResponse, 'thread', 'id');
      if (!threadId) throw new CodexTransportError('PROTOCOL_ERROR', 'thread_start');

      const turnResponse = await this.request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: message }],
          cwd: workspace,
          approvalPolicy: 'never',
          sandbox: 'read-only',
        },
        signal,
        'turn_start',
        actionTimeoutMs,
      );
      const turnId = nestedString(turnResponse, 'turn', 'id');
      if (!turnId) throw new CodexTransportError('PROTOCOL_ERROR', 'turn_start');

      const completion = this.waitForNotification(
        'turn/completed',
        (params) => {
          const candidateThreadId =
            isRecord(params) && typeof params.threadId === 'string' ? params.threadId : undefined;
          const candidateTurnId = nestedString(params, 'turn', 'id');
          return candidateThreadId === threadId && candidateTurnId === turnId;
        },
        signal,
        actionTimeoutMs,
      );
      const completed = await completion;
      const status = nestedString(completed, 'turn', 'status');
      if (status !== 'completed') throw new CodexTransportError('TURN_FAILED', 'turn_completion');
      return { threadId, turnId };
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;

    this.process = undefined;
    this.rejectPending(new CodexTransportError('EOF'));
    this.rejectNotificationWaiters(new CodexTransportError('EOF'));

    if (child.exitCode !== null || child.killed) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        resolve();
      };
      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
        finish();
      }, SHUTDOWN_GRACE_MS);

      child.once('close', finish);
      child.kill('SIGTERM');
    });
  }

  private start(): void {
    if (this.process) throw new CodexTransportError('PROCESS_ERROR');

    const env: NodeJS.ProcessEnv = {
      CODEX_HOME: this.options.codexHome,
      HOME: this.options.codexHome,
    };
    for (const name of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] } = {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    const child = this.spawnProcess(this.options.executable, ['app-server'], options);
    this.process = child;

    child.stdout.on('data', (chunk: Buffer | string) => this.handleStdoutChunk(chunk));
    child.stdout.on('end', () => this.failAll(new CodexTransportError('EOF')));
    child.stdout.on('error', () => this.failAll(new CodexTransportError('PROCESS_ERROR')));
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (this.stderrBytes < MAX_STDERR_BYTES) {
        this.stderrBytes = Math.min(MAX_STDERR_BYTES, this.stderrBytes + Buffer.byteLength(chunk));
      }
    });
    child.once('error', () => this.failAll(new CodexTransportError('PROCESS_ERROR')));
    child.once('close', () => {
      if (this.pending.size > 0) this.failAll(new CodexTransportError('EOF'));
    });
  }

  private request(
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    stage: CodexTransportStage,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<unknown> {
    const child = this.process;
    if (!child) return Promise.reject(new CodexTransportError('PROCESS_ERROR', stage));
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (signal?.aborted) return Promise.reject(new CodexTransportError('ABORTED', stage));

    const id = this.nextRequestId++;
    const message = params === undefined ? { id, method } : { id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectRequest(id, new CodexTransportError('TIMEOUT', stage));
      }, timeoutMs);
      const pending: PendingRequest = {
        stage,
        resolve: (value) => {
          clearTimeout(timeout);
          if (signal && pending.abortListener)
            signal.removeEventListener('abort', pending.abortListener);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          if (signal && pending.abortListener)
            signal.removeEventListener('abort', pending.abortListener);
          reject(error);
        },
        timeout,
      };
      if (signal) {
        pending.abortListener = () =>
          this.rejectRequest(id, new CodexTransportError('ABORTED', stage));
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);

      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
      } catch {
        this.rejectRequest(id, new CodexTransportError('PROCESS_ERROR', stage));
      }
    });
  }

  private sendNotification(method: string, stage: CodexTransportStage): void {
    const child = this.process;
    if (!child) throw new CodexTransportError('PROCESS_ERROR', stage);
    try {
      child.stdin.write(`${JSON.stringify({ method })}\n`, 'utf8');
    } catch {
      throw new CodexTransportError('PROCESS_ERROR', stage);
    }
  }

  private handleStdoutChunk(chunk: Buffer | string): void {
    this.stdoutBuffer += this.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_STDOUT_LINE_BYTES) {
      this.failAll(new CodexTransportError('PROTOCOL_ERROR'));
      return;
    }

    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failAll(new CodexTransportError('PROTOCOL_ERROR'));
      return;
    }
    if (!isRecord(parsed)) {
      this.failAll(new CodexTransportError('PROTOCOL_ERROR'));
      return;
    }

    const record = parsed as JsonRpcRecord;
    if (record.id === undefined) {
      if (typeof record.method === 'string') this.notify(record.method, record.params);
      return;
    }
    if (typeof record.id !== 'number' || !Number.isInteger(record.id)) {
      this.failAll(new CodexTransportError('PROTOCOL_ERROR'));
      return;
    }

    const pending = this.pending.get(record.id);
    if (!pending) {
      this.failAll(new CodexTransportError('PROTOCOL_ERROR'));
      return;
    }
    if ('error' in record) {
      this.rejectRequest(record.id, classifyProtocolError(record.error, pending.stage));
      return;
    }
    if (!('result' in record)) {
      this.failAll(new CodexTransportError('PROTOCOL_ERROR'));
      return;
    }
    this.pending.delete(record.id);
    pending.resolve(record.result);
  }

  private rejectRequest(id: number, error: CodexTransportError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(error);
  }

  private rejectPending(error: CodexTransportError): void {
    for (const id of this.pending.keys()) this.rejectRequest(id, error);
  }

  private waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean,
    signal?: AbortSignal,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<unknown> {
    if (signal?.aborted)
      return Promise.reject(new CodexTransportError('ABORTED', 'turn_completion'));

    const buffered = this.bufferedNotifications.get(method);
    const bufferedIndex = buffered?.findIndex((params) => {
      try {
        return predicate(params);
      } catch {
        return false;
      }
    });
    if (buffered && bufferedIndex !== undefined && bufferedIndex >= 0) {
      const [params] = buffered.splice(bufferedIndex, 1);
      if (buffered.length === 0) this.bufferedNotifications.delete(method);
      return Promise.resolve(params);
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectNotificationWaiter(
          waiter,
          new CodexTransportError('TIMEOUT', 'turn_completion'),
        );
      }, timeoutMs);
      const waiter: NotificationWaiter = {
        method,
        predicate,
        resolve: (params) => {
          clearTimeout(timeout);
          if (signal && waiter.abortListener)
            signal.removeEventListener('abort', waiter.abortListener);
          resolve(params);
        },
        reject: (error) => {
          clearTimeout(timeout);
          if (signal && waiter.abortListener)
            signal.removeEventListener('abort', waiter.abortListener);
          reject(error);
        },
        timeout,
      };
      if (signal) {
        waiter.abortListener = () =>
          this.rejectNotificationWaiter(
            waiter,
            new CodexTransportError('ABORTED', 'turn_completion'),
          );
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      this.notificationWaiters.add(waiter);
    });
  }

  private notify(method: string, params: unknown): void {
    let delivered = false;
    for (const waiter of [...this.notificationWaiters]) {
      if (waiter.method !== method) continue;
      let matches = false;
      try {
        matches = waiter.predicate(params);
      } catch {
        this.rejectNotificationWaiter(
          waiter,
          new CodexTransportError('PROTOCOL_ERROR', 'turn_completion'),
        );
        continue;
      }
      if (matches) {
        this.notificationWaiters.delete(waiter);
        waiter.resolve(params);
        delivered = true;
      }
    }
    if (!delivered) {
      const buffered = this.bufferedNotifications.get(method) ?? [];
      if (buffered.length < 8) buffered.push(params);
      this.bufferedNotifications.set(method, buffered);
    }
  }

  private rejectNotificationWaiter(waiter: NotificationWaiter, error: CodexTransportError): void {
    if (!this.notificationWaiters.delete(waiter)) return;
    waiter.reject(error);
  }

  private rejectNotificationWaiters(error: CodexTransportError): void {
    for (const waiter of [...this.notificationWaiters])
      this.rejectNotificationWaiter(waiter, error);
  }

  private failAll(error: CodexTransportError): void {
    this.terminalError ??= error;
    this.rejectPending(this.terminalError);
    this.rejectNotificationWaiters(this.terminalError);
  }
}
