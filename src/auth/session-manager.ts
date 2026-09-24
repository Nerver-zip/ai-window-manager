import type { Clock } from '../scheduler/clock.js';

export const AUTH_SESSION_STATES = [
  'IDLE',
  'STARTING',
  'AWAITING_USER_ACTION',
  'VERIFYING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELED',
] as const;

export type AuthSessionState = (typeof AUTH_SESSION_STATES)[number];
export type AuthProviderId = 'codex' | 'antigravity';
export type AuthReasonCode =
  | 'ALREADY_AUTHENTICATED'
  | 'AUTH_STATUS_UNAVAILABLE'
  | 'AUTH_START_FAILED'
  | 'AUTH_START_TIMEOUT'
  | 'AUTH_PROCESS_FAILED'
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_CANCELED'
  | 'AUTH_REQUIRED'
  | 'AUTH_OUTPUT_LIMIT'
  | 'AUTH_VERIFICATION_FAILED'
  | 'AUTH_CODE_REJECTED'
  | 'AUTH_PROVIDER_UNAVAILABLE';

/** Safe browser-facing state. No process output, submitted code or credential is included. */
export interface AuthSessionSnapshot {
  providerId: AuthProviderId;
  state: AuthSessionState;
  startedAt: string | null;
  expiresAt: string | null;
  authorizationUrl: string | null;
  userCode: string | null;
  requiresCodeSubmission: boolean;
  reasonCode: AuthReasonCode | null;
}

export type AuthOutputStream = 'stdout' | 'stderr';

export interface AuthManagedProcess {
  onOutput(listener: (stream: AuthOutputStream, chunk: string | Buffer) => void): () => void;
  onExit(listener: (code: number | null, signal: string | null) => void): () => void;
  writeInput(value: string): void;
  signal(signal: 'SIGTERM' | 'SIGKILL'): void;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface AuthOutputUpdate {
  awaitingUserAction?: boolean;
  authorizationUrl?: string | null;
  userCode?: string | null;
  requiresCodeSubmission?: boolean;
  reasonCode?: AuthReasonCode | null;
}

export interface ProviderAuthDriver {
  readonly providerId: AuthProviderId;
  /** true means an existing auth must not be overwritten; undefined is an unsafe/unknown result. */
  isAlreadyAuthenticated(signal: AbortSignal): Promise<boolean | undefined>;
  launch(): AuthManagedProcess;
  /** React only to explicitly recognized, control-stripped interactive CLI prompts. */
  onOutputLine?(process: AuthManagedProcess, stream: AuthOutputStream, line: string): void;
  parseOutput(stream: AuthOutputStream, line: string): AuthOutputUpdate | undefined;
  /** Parse a complete auth prompt that has not ended with a newline yet. */
  parseOutputFragment?(stream: AuthOutputStream, fragment: string): AuthOutputUpdate | undefined;
  submitCode(process: AuthManagedProcess, code: string): void;
  /** Must verify through an official provider read surface, never by inspecting credential files. */
  verify(signal: AbortSignal): Promise<boolean>;
}

export interface AuthSessionEvent {
  type:
    | 'provider_auth_started'
    | 'provider_auth_awaiting_user'
    | 'provider_auth_succeeded'
    | 'provider_auth_failed'
    | 'provider_auth_timed_out'
    | 'provider_auth_canceled';
  providerId: AuthProviderId;
  reasonCode: AuthReasonCode | null;
}

export class AuthSessionError extends Error {
  constructor(
    readonly code:
      'PROVIDER_UNAVAILABLE' | 'SESSION_ACTIVE' | 'SESSION_NOT_WAITING' | 'CODE_INVALID',
  ) {
    super(code);
    this.name = 'AuthSessionError';
  }
}

interface Session extends AuthSessionSnapshot {
  abortController: AbortController;
  process: AuthManagedProcess | undefined;
  outputUnsubscribe: (() => void) | undefined;
  exitUnsubscribe: (() => void) | undefined;
  lineBuffers: Record<AuthOutputStream, string>;
  outputBytes: number;
  verificationRun: number;
  stopping: Promise<void> | undefined;
  startupTimer: NodeJS.Timeout | undefined;
  expiresTimer: NodeJS.Timeout;
}

const TERMINAL_STATES = new Set<AuthSessionState>(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED']);
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_AUTH_CODE_LENGTH = 128;
const VERIFY_ATTEMPTS = 6;
const VERIFY_INTERVAL_MS = 500;
const PROCESS_STOP_GRACE_MS = 500;

const ALLOWED_AUTH_HOSTS: Readonly<Record<AuthProviderId, ReadonlySet<string>>> = {
  codex: new Set(['auth.openai.com']),
  antigravity: new Set(['accounts.google.com']),
};

export class AuthSessionManager {
  private readonly sessions = new Map<AuthProviderId, Session>();

  constructor(
    private readonly options: {
      clock: Clock;
      drivers: ReadonlyMap<AuthProviderId, ProviderAuthDriver>;
      startupTimeoutMs?: number;
      sessionTimeoutMs?: number;
      verificationAttempts?: number;
      verificationIntervalMs?: number;
      processStopGraceMs?: number;
      onEvent?: (event: AuthSessionEvent) => void;
      requestReconcile?: () => void;
    },
  ) {}

  status(providerId: AuthProviderId): AuthSessionSnapshot {
    const session = this.sessions.get(providerId);
    return session ? this.snapshot(session) : idleSnapshot(providerId);
  }

  start(providerId: AuthProviderId): AuthSessionSnapshot {
    const driver = this.options.drivers.get(providerId);
    if (!driver) throw new AuthSessionError('PROVIDER_UNAVAILABLE');

    const previous = this.sessions.get(providerId);
    if (previous && !TERMINAL_STATES.has(previous.state))
      throw new AuthSessionError('SESSION_ACTIVE');

    const now = this.options.clock.now();
    if (!Number.isFinite(now.getTime())) throw new AuthSessionError('PROVIDER_UNAVAILABLE');
    const timeoutMs = this.options.sessionTimeoutMs ?? 15 * 60 * 1000;
    const expiresAt = new Date(now.getTime() + timeoutMs);
    const session = {
      providerId,
      state: 'STARTING' as const,
      startedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      authorizationUrl: null,
      userCode: null,
      requiresCodeSubmission: false,
      reasonCode: null,
      abortController: new AbortController(),
      process: undefined,
      outputUnsubscribe: undefined,
      exitUnsubscribe: undefined,
      lineBuffers: { stdout: '', stderr: '' },
      outputBytes: 0,
      verificationRun: 0,
      stopping: undefined,
      startupTimer: undefined,
      expiresTimer: setTimeout(() => {
        if (this.isActive(session)) this.finish(session, 'TIMED_OUT', 'AUTH_SESSION_EXPIRED');
      }, timeoutMs),
    } satisfies Session;

    this.sessions.set(providerId, session);
    this.emit({ type: 'provider_auth_started', providerId, reasonCode: null });
    void this.begin(session, driver);
    return this.snapshot(session);
  }

  submitCode(providerId: AuthProviderId, value: unknown): AuthSessionSnapshot {
    const session = this.sessions.get(providerId);
    const driver = this.options.drivers.get(providerId);
    if (
      !session ||
      !driver ||
      session.state !== 'AWAITING_USER_ACTION' ||
      !session.requiresCodeSubmission ||
      !session.process
    ) {
      throw new AuthSessionError('SESSION_NOT_WAITING');
    }

    if (typeof value !== 'string') throw new AuthSessionError('CODE_INVALID');
    const code = value.trim();
    if (
      code.length < 4 ||
      code.length > MAX_AUTH_CODE_LENGTH ||
      !/^[A-Za-z0-9._~+/=-]+$/.test(code)
    ) {
      throw new AuthSessionError('CODE_INVALID');
    }

    try {
      driver.submitCode(session.process, code);
    } catch {
      this.finish(session, 'FAILED', 'AUTH_PROCESS_FAILED');
      return this.snapshot(session);
    }

    session.authorizationUrl = null;
    session.userCode = null;
    session.requiresCodeSubmission = false;
    session.reasonCode = null;
    this.transition(session, 'VERIFYING');
    this.beginVerification(session, driver);
    return this.snapshot(session);
  }

  cancel(providerId: AuthProviderId): AuthSessionSnapshot {
    const session = this.sessions.get(providerId);
    if (!session || TERMINAL_STATES.has(session.state)) return this.status(providerId);
    this.finish(session, 'CANCELED', 'AUTH_CANCELED');
    return this.snapshot(session);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()].filter((session) => this.isActive(session));
    for (const session of sessions) this.finish(session, 'CANCELED', 'AUTH_CANCELED');
    await Promise.all(sessions.map((session) => this.stopProcess(session)));
  }

  private async begin(session: Session, driver: ProviderAuthDriver): Promise<void> {
    try {
      const alreadyAuthenticated = await driver.isAlreadyAuthenticated(
        session.abortController.signal,
      );
      if (!this.isActive(session)) return;
      if (alreadyAuthenticated === true) {
        this.finish(session, 'FAILED', 'ALREADY_AUTHENTICATED');
        return;
      }
      if (alreadyAuthenticated !== false) {
        this.finish(session, 'FAILED', 'AUTH_STATUS_UNAVAILABLE');
        return;
      }

      session.startupTimer = setTimeout(() => {
        if (this.isActive(session) && session.state === 'STARTING') {
          this.finish(session, 'TIMED_OUT', 'AUTH_START_TIMEOUT');
        }
      }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
      const process = driver.launch();
      if (!this.isActive(session)) {
        process.signal('SIGTERM');
        return;
      }
      session.process = process;
      session.outputUnsubscribe = process.onOutput((stream, chunk) => {
        this.handleOutput(session, driver, stream, chunk);
      });
      session.exitUnsubscribe = process.onExit((code) => {
        void this.handleExit(session, driver, code);
      });
    } catch {
      if (this.isActive(session)) this.finish(session, 'FAILED', 'AUTH_START_FAILED');
    }
  }

  private handleOutput(
    session: Session,
    driver: ProviderAuthDriver,
    stream: AuthOutputStream,
    chunk: string | Buffer,
  ): void {
    if (!this.isActive(session)) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    session.outputBytes += Buffer.byteLength(text);
    if (session.outputBytes > MAX_OUTPUT_BYTES) {
      this.finish(session, 'FAILED', 'AUTH_OUTPUT_LIMIT');
      return;
    }

    const combined = session.lineBuffers[stream] + text;
    if (Buffer.byteLength(combined) > MAX_LINE_BYTES && !/[\r\n]/.test(combined)) {
      this.finish(session, 'FAILED', 'AUTH_OUTPUT_LIMIT');
      return;
    }
    const lines = combined.split(/[\r\n]+/);
    session.lineBuffers[stream] = lines.pop() ?? '';
    if (Buffer.byteLength(session.lineBuffers[stream]) > MAX_LINE_BYTES) {
      this.finish(session, 'FAILED', 'AUTH_OUTPUT_LIMIT');
      return;
    }

    for (const rawLine of lines) {
      if (!this.isActive(session)) return;
      const line = stripTerminalControls(rawLine);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.finish(session, 'FAILED', 'AUTH_OUTPUT_LIMIT');
        return;
      }
      let update: AuthOutputUpdate | undefined;
      try {
        const process = session.process;
        if (process) driver.onOutputLine?.(process, stream, line);
        if (!this.isActive(session)) return;
        update = driver.parseOutput(stream, line);
      } catch {
        this.finish(session, 'FAILED', 'AUTH_PROCESS_FAILED');
        return;
      }
      if (update) this.applyOutputUpdate(session, update);
    }

    const fragment = stripTerminalControls(session.lineBuffers[stream]);
    if (fragment && driver.parseOutputFragment) {
      let update: AuthOutputUpdate | undefined;
      try {
        update = driver.parseOutputFragment(stream, fragment);
      } catch {
        this.finish(session, 'FAILED', 'AUTH_PROCESS_FAILED');
        return;
      }
      if (update) this.applyOutputUpdate(session, update);
    }
  }

  private applyOutputUpdate(session: Session, update: AuthOutputUpdate): void {
    if (update.reasonCode === 'AUTH_CODE_REJECTED') {
      session.reasonCode = update.reasonCode;
      session.requiresCodeSubmission =
        update.requiresCodeSubmission ?? session.requiresCodeSubmission;
      session.authorizationUrl = null;
      session.userCode = null;
      if (session.state === 'VERIFYING' && session.requiresCodeSubmission) {
        session.verificationRun += 1;
        this.transition(session, 'AWAITING_USER_ACTION');
      }
    }

    if (update.awaitingUserAction) {
      const url = validateAuthorizationUrl(session.providerId, update.authorizationUrl);
      const code = validateDisplayCode(update.userCode);
      if (update.authorizationUrl && !url) return;
      if (update.userCode && !code) return;
      session.authorizationUrl = url ?? null;
      if (update.userCode !== undefined) session.userCode = code ?? null;
      session.requiresCodeSubmission = update.requiresCodeSubmission ?? false;
      session.reasonCode = update.reasonCode ?? null;
      if (session.state === 'STARTING' || session.state === 'VERIFYING') {
        session.verificationRun += 1;
        this.transition(session, 'AWAITING_USER_ACTION');
        this.emit({
          type: 'provider_auth_awaiting_user',
          providerId: session.providerId,
          reasonCode: session.reasonCode,
        });
      }
    }
  }

  private handleExit(session: Session, driver: ProviderAuthDriver, code: number | null): void {
    this.detachProcess(session);
    if (!this.isActive(session)) return;
    if (code !== 0) {
      this.finish(session, 'FAILED', 'AUTH_PROCESS_FAILED');
      return;
    }
    this.beginVerification(session, driver);
  }

  private beginVerification(session: Session, driver: ProviderAuthDriver): void {
    const run = ++session.verificationRun;
    if (session.state !== 'VERIFYING') this.transition(session, 'VERIFYING');
    void this.verifyUntilComplete(session, driver, run);
  }

  private async verifyUntilComplete(
    session: Session,
    driver: ProviderAuthDriver,
    run: number,
  ): Promise<void> {
    const attempts = this.options.verificationAttempts ?? VERIFY_ATTEMPTS;
    const intervalMs = this.options.verificationIntervalMs ?? VERIFY_INTERVAL_MS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!this.isActive(session) || session.verificationRun !== run) return;
      try {
        if (await driver.verify(session.abortController.signal)) {
          if (this.isActive(session) && session.verificationRun === run) {
            this.finish(session, 'SUCCEEDED', null);
            this.options.requestReconcile?.();
          }
          return;
        }
      } catch {
        // Provider-specific details are intentionally not retained or returned.
      }
      if (attempt + 1 < attempts && !(await delay(intervalMs, session.abortController.signal)))
        return;
    }
    if (this.isActive(session) && session.verificationRun === run) {
      this.finish(session, 'FAILED', 'AUTH_VERIFICATION_FAILED');
    }
  }

  private finish(
    session: Session,
    state: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELED',
    reasonCode: AuthReasonCode | null,
  ): void {
    if (TERMINAL_STATES.has(session.state)) return;
    this.transition(session, state);
    session.reasonCode = reasonCode;
    session.authorizationUrl = null;
    session.userCode = null;
    session.requiresCodeSubmission = false;
    session.verificationRun += 1;
    session.abortController.abort();
    if (session.startupTimer) clearTimeout(session.startupTimer);
    session.startupTimer = undefined;
    clearTimeout(session.expiresTimer);
    const eventType =
      state === 'SUCCEEDED'
        ? 'provider_auth_succeeded'
        : state === 'CANCELED'
          ? 'provider_auth_canceled'
          : state === 'TIMED_OUT'
            ? 'provider_auth_timed_out'
            : 'provider_auth_failed';
    this.emit({ type: eventType, providerId: session.providerId, reasonCode });
    void this.stopProcess(session);
  }

  private transition(session: Session, state: AuthSessionState): void {
    const allowed: Readonly<Record<AuthSessionState, readonly AuthSessionState[]>> = {
      IDLE: ['STARTING'],
      STARTING: [
        'AWAITING_USER_ACTION',
        'VERIFYING',
        'SUCCEEDED',
        'FAILED',
        'TIMED_OUT',
        'CANCELED',
      ],
      AWAITING_USER_ACTION: [
        'AWAITING_USER_ACTION',
        'VERIFYING',
        'FAILED',
        'TIMED_OUT',
        'CANCELED',
      ],
      VERIFYING: ['AWAITING_USER_ACTION', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED'],
      SUCCEEDED: [],
      FAILED: [],
      TIMED_OUT: [],
      CANCELED: [],
    };
    if (!allowed[session.state].includes(state)) return;
    if (session.state === 'STARTING' && state !== 'STARTING') {
      if (session.startupTimer) clearTimeout(session.startupTimer);
      session.startupTimer = undefined;
    }
    session.state = state;
  }

  private async stopProcess(session: Session): Promise<void> {
    if (session.stopping) return session.stopping;
    const process = session.process;
    if (!process) return;
    session.stopping = (async () => {
      process.signal('SIGTERM');
      const graceMs = this.options.processStopGraceMs ?? PROCESS_STOP_GRACE_MS;
      if (!(await process.waitForExit(graceMs))) {
        process.signal('SIGKILL');
        await process.waitForExit(graceMs);
      }
      if (session.process === process) this.detachProcess(session);
    })();
    return session.stopping;
  }

  private detachProcess(session: Session): void {
    session.outputUnsubscribe?.();
    session.exitUnsubscribe?.();
    session.outputUnsubscribe = undefined;
    session.exitUnsubscribe = undefined;
    session.process = undefined;
    session.lineBuffers.stdout = '';
    session.lineBuffers.stderr = '';
  }

  private emit(event: AuthSessionEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Auth lifecycle must remain independent of history sink availability.
    }
  }

  private isActive(session: Session): boolean {
    return !TERMINAL_STATES.has(session.state) && !session.abortController.signal.aborted;
  }

  private snapshot(session: Session): AuthSessionSnapshot {
    return {
      providerId: session.providerId,
      state: session.state,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      authorizationUrl: session.authorizationUrl,
      userCode: session.userCode,
      requiresCodeSubmission: session.requiresCodeSubmission,
      reasonCode: session.reasonCode,
    };
  }
}

function idleSnapshot(providerId: AuthProviderId): AuthSessionSnapshot {
  return {
    providerId,
    state: 'IDLE',
    startedAt: null,
    expiresAt: null,
    authorizationUrl: null,
    userCode: null,
    requiresCodeSubmission: false,
    reasonCode: null,
  };
}

function validateAuthorizationUrl(
  providerId: AuthProviderId,
  value: string | null | undefined,
): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !ALLOWED_AUTH_HOSTS[providerId].has(url.hostname.toLowerCase()) ||
      url.username ||
      url.password
    )
      return undefined;
    const sensitiveParameter = /^(access_token|refresh_token|id_token|token|authorization|code)$/i;
    if ([...url.searchParams.keys()].some((name) => sensitiveParameter.test(name)))
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function validateDisplayCode(value: string | null | undefined): string | undefined {
  if (!value || value.length > 64 || !/^[A-Za-z0-9-]{4,64}$/.test(value)) return undefined;
  return value;
}

const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const OSC_SEQUENCE = new RegExp(`${ESCAPE}\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`, 'g');
const CSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');
const REMOVED_CONTROL_CODES = [
  ...Array.from({ length: 9 }, (_, index) => index),
  0x0b,
  0x0c,
  ...Array.from({ length: 18 }, (_, index) => index + 0x0e),
  0x7f,
];
const REMOVED_CONTROLS = new RegExp(
  `[${REMOVED_CONTROL_CODES.map((code) => String.fromCharCode(code)).join('')}]`,
  'g',
);

function stripTerminalControls(value: string): string {
  return value
    .replaceAll(OSC_SEQUENCE, '')
    .replaceAll(CSI_SEQUENCE, '')
    .replaceAll(REMOVED_CONTROLS, '');
}

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
