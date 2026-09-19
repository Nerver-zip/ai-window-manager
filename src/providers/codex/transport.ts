import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const MAX_STDOUT_LINE_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const SHUTDOWN_GRACE_MS = 250;

export type CodexTransportErrorCode =
  'AUTH_REQUIRED' | 'PROTOCOL_ERROR' | 'TIMEOUT' | 'EOF' | 'PROCESS_ERROR' | 'ABORTED';

export class CodexTransportError extends Error {
  constructor(readonly code: CodexTransportErrorCode) {
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
  spawnProcess?: CodexProcessFactory;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: CodexTransportError) => void;
  timeout: NodeJS.Timeout;
  abortListener?: () => void;
}

interface JsonRpcRecord {
  id?: unknown;
  result?: unknown;
  error?: unknown;
  method?: unknown;
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

function classifyProtocolError(error: unknown): CodexTransportError {
  if (!isRecord(error)) return new CodexTransportError('PROTOCOL_ERROR');

  const code = error.code;
  const message = error.message;
  const description = `${typeof code === 'string' || typeof code === 'number' ? code : ''} ${typeof message === 'string' ? message : ''}`;
  if (/auth|unauthori[sz]ed|login|sign.?in|credential/i.test(description)) {
    return new CodexTransportError('AUTH_REQUIRED');
  }
  return new CodexTransportError('PROTOCOL_ERROR');
}

export class CodexAppServerClient {
  private readonly spawnProcess: CodexProcessFactory;
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingRequest>();
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
      );
      this.sendNotification('initialized');
      return await this.request('account/rateLimits/read', undefined, signal);
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;

    this.process = undefined;
    this.rejectPending(new CodexTransportError('EOF'));

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

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.process;
    if (!child) return Promise.reject(new CodexTransportError('PROCESS_ERROR'));
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (signal?.aborted) return Promise.reject(new CodexTransportError('ABORTED'));

    const id = this.nextRequestId++;
    const message = params === undefined ? { id, method } : { id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectRequest(id, new CodexTransportError('TIMEOUT'));
      }, this.options.requestTimeoutMs);
      const pending: PendingRequest = {
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
        pending.abortListener = () => this.rejectRequest(id, new CodexTransportError('ABORTED'));
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);

      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
      } catch {
        this.rejectRequest(id, new CodexTransportError('PROCESS_ERROR'));
      }
    });
  }

  private sendNotification(method: string): void {
    const child = this.process;
    if (!child) throw new CodexTransportError('PROCESS_ERROR');
    try {
      child.stdin.write(`${JSON.stringify({ method })}\n`, 'utf8');
    } catch {
      throw new CodexTransportError('PROCESS_ERROR');
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
    if (record.id === undefined) return;
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
      this.rejectRequest(record.id, classifyProtocolError(record.error));
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

  private failAll(error: CodexTransportError): void {
    this.terminalError ??= error;
    this.rejectPending(this.terminalError);
  }
}
