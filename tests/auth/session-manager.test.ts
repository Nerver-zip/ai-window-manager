import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock, type Clock } from '../../src/scheduler/clock.js';
import {
  AuthSessionError,
  AuthSessionManager,
  type AuthManagedProcess,
  type AuthOutputStream,
  type AuthOutputUpdate,
  type AuthProviderId,
  type AuthSessionEvent,
  type ProviderAuthDriver,
} from '../../src/auth/session-manager.js';

const NOW = '2026-09-23T12:00:00.000Z';

class FakeProcess implements AuthManagedProcess {
  readonly signals: string[] = [];
  readonly inputs: string[] = [];
  private readonly outputListeners = new Set<
    (stream: AuthOutputStream, chunk: string | Buffer) => void
  >();
  private readonly exitListeners = new Set<(code: number | null, signal: string | null) => void>();
  private closed = false;
  ignoreTerm = false;
  waitResults: boolean[] = [];

  onOutput(listener: (stream: AuthOutputStream, chunk: string | Buffer) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  writeInput(value: string): void {
    this.inputs.push(value);
  }

  signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && !this.ignoreTerm) this.exit(null, signal);
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.waitResults.length) return Promise.resolve(this.waitResults.shift()!);
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => setTimeout(() => resolve(this.closed), timeoutMs));
  }

  output(stream: AuthOutputStream, chunk: string): void {
    for (const listener of this.outputListeners) listener(stream, chunk);
  }

  exit(code: number | null, signal: string | null = null): void {
    this.closed = true;
    for (const listener of this.exitListeners) listener(code, signal);
  }
}

class FakeDriver implements ProviderAuthDriver {
  readonly providerId: AuthProviderId;
  readonly process = new FakeProcess();
  launchCount = 0;
  codeSubmissions: string[] = [];
  authenticated: boolean | undefined = false;
  verification: Array<boolean | Error> = [true];
  outputLines: string[] = [];
  launchFailure: Error | undefined;
  submitFailure: Error | undefined;
  authCheckFailure: Error | undefined;

  constructor(providerId: AuthProviderId = 'codex') {
    this.providerId = providerId;
  }

  isAlreadyAuthenticated(): Promise<boolean | undefined> {
    if (this.authCheckFailure) return Promise.reject(this.authCheckFailure);
    return Promise.resolve(this.authenticated);
  }

  launch(): AuthManagedProcess {
    if (this.launchFailure) throw this.launchFailure;
    this.launchCount += 1;
    return this.process;
  }

  onOutputLine(process: AuthManagedProcess, _stream: AuthOutputStream, line: string): void {
    this.outputLines.push(line);
    if (this.providerId === 'antigravity' && line === 'select-google-oauth')
      process.writeInput('\r');
  }

  parseOutput(_stream: AuthOutputStream, line: string): AuthOutputUpdate | undefined {
    if (line === 'auth-link-only' || line === 'auth-progress') {
      return {
        awaitingUserAction: true,
        authorizationUrl: 'https://auth.openai.com/codex/device',
        requiresCodeSubmission: false,
      };
    }
    if (line === 'auth-prompt') {
      return {
        awaitingUserAction: true,
        authorizationUrl:
          this.providerId === 'codex'
            ? 'https://auth.openai.com/codex/device'
            : 'https://accounts.google.com/o/oauth2/auth?state=synthetic',
        userCode: this.providerId === 'codex' ? 'ABCD-EFGH' : null,
        requiresCodeSubmission: this.providerId === 'antigravity',
      };
    }
    if (line === 'bad-code')
      return {
        awaitingUserAction: true,
        requiresCodeSubmission: true,
        reasonCode: 'AUTH_CODE_REJECTED',
      };
    return undefined;
  }

  parseOutputFragment(_stream: AuthOutputStream, fragment: string): AuthOutputUpdate | undefined {
    if (!fragment.endsWith('ABCD-EFGHI')) return undefined;
    return {
      awaitingUserAction: true,
      authorizationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGHI',
      requiresCodeSubmission: false,
    };
  }

  submitCode(_process: AuthManagedProcess, code: string): void {
    if (this.submitFailure) throw this.submitFailure;
    this.codeSubmissions.push(code);
  }

  verify(): Promise<boolean> {
    const result = this.verification.shift() ?? true;
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }
}

function createManager(
  input: {
    driver?: FakeDriver;
    clock?: Clock;
    startupTimeoutMs?: number;
    timeoutMs?: number;
    processStopGraceMs?: number;
    verificationAttempts?: number;
    verificationIntervalMs?: number;
    events?: AuthSessionEvent[];
    requestReconcile?: { count: number };
    onEvent?: (event: AuthSessionEvent) => void;
  } = {},
) {
  const driver = input.driver ?? new FakeDriver();
  const events = input.events ?? [];
  const manager = new AuthSessionManager({
    clock: input.clock ?? new FakeClock(NOW),
    drivers: new Map([[driver.providerId, driver]]),
    ...(input.startupTimeoutMs !== undefined ? { startupTimeoutMs: input.startupTimeoutMs } : {}),
    sessionTimeoutMs: input.timeoutMs ?? 60_000,
    processStopGraceMs: input.processStopGraceMs ?? 20,
    verificationAttempts: input.verificationAttempts ?? 3,
    verificationIntervalMs: input.verificationIntervalMs ?? 10,
    onEvent: input.onEvent ?? ((event) => events.push(event)),
    requestReconcile: () => {
      if (input.requestReconcile) input.requestReconcile.count += 1;
    },
  });
  return { manager, driver, events };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe('AuthSessionManager', () => {
  it('captures a complete device code from a PTY prompt without a trailing newline', async () => {
    const { manager, driver } = createManager();
    manager.start('codex');
    await flushMicrotasks();
    driver.process.output('stdout', 'auth-link-only\n');
    expect(manager.status('codex')).toMatchObject({
      state: 'AWAITING_USER_ACTION',
      userCode: null,
    });

    driver.process.output('stdout', 'Enter this code: ABCD-EF');
    expect(manager.status('codex').userCode).toBeNull();
    driver.process.output('stdout', 'GHI');
    expect(manager.status('codex')).toMatchObject({
      state: 'AWAITING_USER_ACTION',
      userCode: 'ABCD-EFGHI',
    });

    driver.process.output('stdout', 'auth-progress\n');
    expect(manager.status('codex')).toMatchObject({
      state: 'AWAITING_USER_ACTION',
      userCode: 'ABCD-EFGHI',
    });
    await manager.shutdown();
  });

  it('exposes an idle DTO with no process or credential fields', () => {
    const { manager } = createManager();
    expect(manager.status('codex')).toEqual({
      providerId: 'codex',
      state: 'IDLE',
      startedAt: null,
      expiresAt: null,
      authorizationUrl: null,
      userCode: null,
      requiresCodeSubmission: false,
      reasonCode: null,
    });
  });

  it('fails closed when no driver exists or the injected clock is invalid', () => {
    const withoutDriver = new AuthSessionManager({ clock: new FakeClock(NOW), drivers: new Map() });
    expect(() => withoutDriver.start('codex')).toThrowError(
      new AuthSessionError('PROVIDER_UNAVAILABLE'),
    );

    const driver = new FakeDriver();
    const invalidClock: Clock = { now: () => new Date(Number.NaN), monotonicMs: () => 0 };
    const withInvalidClock = new AuthSessionManager({
      clock: invalidClock,
      drivers: new Map([['codex', driver]]),
    });
    expect(() => withInvalidClock.start('codex')).toThrowError(
      new AuthSessionError('PROVIDER_UNAVAILABLE'),
    );
    expect(driver.launchCount).toBe(0);
  });

  it('starts one official session and publishes only explicitly parsed auth steps', async () => {
    const { manager, driver, events } = createManager();
    expect(manager.start('codex').state).toBe('STARTING');
    await flushMicrotasks();
    expect(driver.launchCount).toBe(1);
    driver.process.output('stderr', 'auth-');
    driver.process.output('stderr', 'prompt\n');
    expect(manager.status('codex')).toMatchObject({
      state: 'AWAITING_USER_ACTION',
      authorizationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      requiresCodeSubmission: false,
    });
    expect(events).toEqual([
      { type: 'provider_auth_started', providerId: 'codex', reasonCode: null },
      { type: 'provider_auth_awaiting_user', providerId: 'codex', reasonCode: null },
    ]);
    expect(JSON.stringify(events)).not.toContain('ABCD-EFGH');
  });

  it('routes sanitized PTY lines to the provider prompt handler', async () => {
    const driver = new FakeDriver('antigravity');
    const { manager } = createManager({ driver });
    manager.start('antigravity');
    await flushMicrotasks();

    driver.process.output('stdout', 'select-google-oauth\n');

    expect(driver.outputLines).toContain('select-google-oauth');
    expect(driver.process.inputs).toEqual(['\r']);
    await manager.shutdown();
  });

  it('times out and stops a launched process that never emits sign-in progress', async () => {
    vi.useFakeTimers();
    const { manager, driver, events } = createManager({ startupTimeoutMs: 100 });
    manager.start('codex');
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(100);

    expect(manager.status('codex')).toMatchObject({
      state: 'TIMED_OUT',
      reasonCode: 'AUTH_START_TIMEOUT',
    });
    expect(driver.process.signals).toContain('SIGTERM');
    expect(events.at(-1)).toMatchObject({
      type: 'provider_auth_timed_out',
      reasonCode: 'AUTH_START_TIMEOUT',
    });
  });

  it('stops the startup deadline when the official client requests user action', async () => {
    vi.useFakeTimers();
    const { manager, driver } = createManager({ startupTimeoutMs: 100 });
    manager.start('codex');
    await flushMicrotasks();
    driver.process.output('stderr', 'auth-prompt\n');

    await vi.advanceTimersByTimeAsync(100);

    expect(manager.status('codex').state).toBe('AWAITING_USER_ACTION');
    await manager.shutdown();
  });

  it('rejects a second active session for the same provider', async () => {
    const { manager, driver } = createManager();
    manager.start('codex');
    await flushMicrotasks();
    expect(() => manager.start('codex')).toThrowError(new AuthSessionError('SESSION_ACTIVE'));
    expect(driver.launchCount).toBe(1);
  });

  it('does not overwrite an existing provider login', async () => {
    const driver = new FakeDriver();
    driver.authenticated = true;
    const { manager } = createManager({ driver });
    manager.start('codex');
    await flushMicrotasks();
    expect(manager.status('codex')).toMatchObject({
      state: 'FAILED',
      reasonCode: 'ALREADY_AUTHENTICATED',
    });
    expect(driver.launchCount).toBe(0);
  });

  it('fails closed when auth status is unknown', async () => {
    const driver = new FakeDriver();
    driver.authenticated = undefined;
    const { manager } = createManager({ driver });
    manager.start('codex');
    await flushMicrotasks();
    expect(manager.status('codex')).toMatchObject({
      state: 'FAILED',
      reasonCode: 'AUTH_STATUS_UNAVAILABLE',
    });
    expect(driver.launchCount).toBe(0);
  });

  it.each(['auth status check', 'official process launch'])(
    'does not retain details when %s fails',
    async (failure) => {
      const driver = new FakeDriver();
      if (failure === 'auth status check') driver.authCheckFailure = new Error('private detail');
      else driver.launchFailure = new Error('private detail');
      const { manager } = createManager({ driver });
      manager.start('codex');
      await flushMicrotasks();
      expect(manager.status('codex')).toMatchObject({
        state: 'FAILED',
        reasonCode: 'AUTH_START_FAILED',
      });
      expect(JSON.stringify(manager.status('codex'))).not.toContain('private detail');
    },
  );

  it('accepts an Agy code once, removes it from status and completes after read verification', async () => {
    const driver = new FakeDriver('antigravity');
    const requestReconcile = { count: 0 };
    const { manager } = createManager({ driver, requestReconcile });
    manager.start('antigravity');
    await flushMicrotasks();
    driver.process.output('stdout', 'auth-prompt\n');
    expect(manager.status('antigravity')).toMatchObject({
      state: 'AWAITING_USER_ACTION',
      requiresCodeSubmission: true,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=synthetic',
    });

    expect(() => manager.submitCode('antigravity', 'bad code\nquit')).toThrowError(
      new AuthSessionError('CODE_INVALID'),
    );
    const submitted = manager.submitCode('antigravity', '  4/0AbC-DEfGh=  ');
    expect(submitted).toMatchObject({ state: 'VERIFYING', authorizationUrl: null, userCode: null });
    await flushMicrotasks();
    expect(driver.codeSubmissions).toEqual(['4/0AbC-DEfGh=']);
    expect(manager.status('antigravity').state).toBe('SUCCEEDED');
    expect(requestReconcile.count).toBe(1);
    expect(JSON.stringify(manager.status('antigravity'))).not.toContain('4/0AbC-DEfGh=');
  });

  it('accepts a short provider-issued code at the same four-character minimum used for display', async () => {
    const driver = new FakeDriver('antigravity');
    const { manager } = createManager({ driver });
    manager.start('antigravity');
    await flushMicrotasks();
    driver.process.output('stdout', 'auth-prompt\n');

    expect(manager.submitCode('antigravity', 'ABCD').state).toBe('VERIFYING');
    await flushMicrotasks();
    expect(driver.codeSubmissions).toEqual(['ABCD']);
  });

  it.each([undefined, null, 12345, 'ABC', 'bad code', 'x'.repeat(129)])(
    'rejects malformed submitted code %s',
    async (code) => {
      const driver = new FakeDriver('antigravity');
      const { manager } = createManager({ driver });
      manager.start('antigravity');
      await flushMicrotasks();
      driver.process.output('stdout', 'auth-prompt\n');
      expect(() => manager.submitCode('antigravity', code)).toThrowError(
        new AuthSessionError('CODE_INVALID'),
      );
      expect(driver.codeSubmissions).toHaveLength(0);
    },
  );

  it('stops safely if the official process rejects the submitted-code write', async () => {
    const driver = new FakeDriver('antigravity');
    driver.submitFailure = new Error('synthetic write failure');
    const { manager } = createManager({ driver });
    manager.start('antigravity');
    await flushMicrotasks();
    driver.process.output('stdout', 'auth-prompt\n');

    expect(manager.submitCode('antigravity', 'ABCD')).toMatchObject({
      state: 'FAILED',
      reasonCode: 'AUTH_PROCESS_FAILED',
    });
    expect(JSON.stringify(manager.status('antigravity'))).not.toContain('synthetic write failure');
  });

  it('rejects a code submission for Codex, which submits its device code on the official site', async () => {
    const { manager, driver } = createManager();
    manager.start('codex');
    await flushMicrotasks();
    driver.process.output('stdout', 'auth-prompt\n');
    expect(() => manager.submitCode('codex', 'ABCD-EFGH')).toThrowError(
      new AuthSessionError('SESSION_NOT_WAITING'),
    );
  });

  it.each([
    'https://evil.example.test/login',
    'https://auth.openai.com/device?access_token=synthetic-value',
  ])(
    'drops untrusted auth material from %s instead of returning it to the browser',
    async (url) => {
      const driver = new FakeDriver();
      driver.parseOutput = () => ({
        awaitingUserAction: true,
        authorizationUrl: url,
        userCode: 'SENSITIVE-1234',
      });
      const { manager } = createManager({ driver });
      manager.start('codex');
      await flushMicrotasks();
      driver.process.output('stdout', 'anything\n');
      expect(manager.status('codex')).toMatchObject({
        state: 'STARTING',
        authorizationUrl: null,
        userCode: null,
      });
      expect(JSON.stringify(manager.status('codex'))).not.toContain('SENSITIVE-1234');
    },
  );

  it('retries only read verification and marks success without retaining the browser code', async () => {
    const driver = new FakeDriver();
    driver.verification = [false, false, true];
    vi.useFakeTimers();
    const { manager } = createManager({ driver, verificationIntervalMs: 10 });
    manager.start('codex');
    await flushMicrotasks();
    driver.process.output('stdout', 'auth-prompt\n');
    driver.process.exit(0);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20);
    expect(manager.status('codex')).toMatchObject({ state: 'SUCCEEDED', userCode: null });
    expect(driver.verification).toHaveLength(0);
  });

  it('fails after bounded read verification retries and hides provider errors', async () => {
    const driver = new FakeDriver();
    driver.verification = [new Error('private provider payload'), false, false];
    vi.useFakeTimers();
    const { manager } = createManager({ driver, verificationIntervalMs: 10 });
    manager.start('codex');
    await flushMicrotasks();
    driver.process.exit(0);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20);

    expect(manager.status('codex')).toMatchObject({
      state: 'FAILED',
      reasonCode: 'AUTH_VERIFICATION_FAILED',
    });
    expect(JSON.stringify(manager.status('codex'))).not.toContain('private provider payload');
  });

  it('stops retrying verification when the operator cancels during a wait', async () => {
    const driver = new FakeDriver();
    driver.verification = [false, true];
    vi.useFakeTimers();
    const { manager } = createManager({ driver, verificationIntervalMs: 100 });
    manager.start('codex');
    await flushMicrotasks();
    driver.process.exit(0);
    await flushMicrotasks();
    manager.cancel('codex');
    await vi.advanceTimersByTimeAsync(100);

    expect(manager.status('codex').state).toBe('CANCELED');
    expect(driver.verification).toEqual([true]);
  });

  it('escalates shutdown to SIGKILL when the official process ignores SIGTERM', async () => {
    const driver = new FakeDriver();
    driver.process.ignoreTerm = true;
    driver.process.waitResults = [false, true];
    const { manager } = createManager({ driver });
    manager.start('codex');
    await flushMicrotasks();

    manager.cancel('codex');
    await flushMicrotasks();

    expect(driver.process.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not fail if the history sink throws while publishing auth state', async () => {
    const driver = new FakeDriver();
    const { manager } = createManager({
      driver,
      onEvent: () => {
        throw new Error('history unavailable');
      },
    });
    manager.start('codex');
    await flushMicrotasks();
    driver.process.output('stdout', 'auth-prompt\n');
    expect(manager.status('codex').state).toBe('AWAITING_USER_ACTION');
  });

  it('returns to the code prompt after the official CLI rejects the submitted code', async () => {
    const driver = new FakeDriver('antigravity');
    driver.verification = [false, true];
    vi.useFakeTimers();
    const { manager } = createManager({ driver, verificationIntervalMs: 10 });
    manager.start('antigravity');
    await flushMicrotasks();
    driver.process.output('stdout', 'auth-prompt\n');
    manager.submitCode('antigravity', '4/0AbC-DEfGh=');
    driver.process.output('stderr', 'bad-code\n');
    expect(manager.status('antigravity')).toMatchObject({
      state: 'AWAITING_USER_ACTION',
      reasonCode: 'AUTH_CODE_REJECTED',
      requiresCodeSubmission: true,
    });
  });

  it('bounds accumulated process output and terminates without leaking it', async () => {
    const { manager, driver } = createManager();
    manager.start('codex');
    await flushMicrotasks();
    driver.process.output('stderr', `${'private-output-'.repeat(150_000)}\n`);
    expect(manager.status('codex')).toMatchObject({
      state: 'FAILED',
      reasonCode: 'AUTH_OUTPUT_LIMIT',
    });
    expect(JSON.stringify(manager.status('codex'))).not.toContain('private-output');
    expect(driver.process.signals).toContain('SIGTERM');
  });

  it('expires an unattended session and stops the child process', async () => {
    vi.useFakeTimers();
    const { manager, driver, events } = createManager({ timeoutMs: 1_000 });
    manager.start('codex');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.status('codex')).toMatchObject({
      state: 'TIMED_OUT',
      reasonCode: 'AUTH_SESSION_EXPIRED',
    });
    expect(driver.process.signals).toContain('SIGTERM');
    expect(events.at(-1)).toMatchObject({
      type: 'provider_auth_timed_out',
      providerId: 'codex',
      reasonCode: 'AUTH_SESSION_EXPIRED',
    });
  });

  it('cancel is idempotent and shuts down every active child', async () => {
    const driver = new FakeDriver();
    const { manager, events } = createManager({ driver });
    manager.start('codex');
    await flushMicrotasks();
    expect(manager.cancel('codex').state).toBe('CANCELED');
    expect(manager.cancel('codex').state).toBe('CANCELED');
    await manager.shutdown();
    expect(driver.process.signals).toEqual(['SIGTERM']);
    expect(events.filter((event) => event.type === 'provider_auth_canceled')).toHaveLength(1);
  });

  it('fails closed on malformed progress returned by a provider driver', async () => {
    const driver = new FakeDriver();
    driver.parseOutput = () => {
      throw new Error('raw provider output must not be returned');
    };
    const { manager } = createManager({ driver });
    manager.start('codex');
    await flushMicrotasks();
    driver.process.output('stdout', 'malformed\n');
    expect(manager.status('codex')).toMatchObject({
      state: 'FAILED',
      reasonCode: 'AUTH_PROCESS_FAILED',
    });
  });
});
