import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import type { ClaudeAuthState } from '../../src/providers/claude-code/protocol.js';
import {
  createProviderAuthDrivers,
  type ProviderAuthDriverOptions,
} from '../../src/auth/provider-drivers.js';
import { AuthSessionManager, type AuthManagedProcess } from '../../src/auth/session-manager.js';

const CLAUDE_BOOTSTRAP_URL = `https://claude.com/cai/oauth/authorize?${new URLSearchParams({
  code: 'synthetic-bootstrap-code-0123456789',
  client_id: 'synthetic-client-id',
  response_type: 'code',
  redirect_uri: 'https://platform.claude.com/oauth/code/callback',
  scope: 'user:profile user:inference',
  code_challenge: 'A'.repeat(43),
  code_challenge_method: 'S256',
  state: 'synthetic-state',
})}`;

function provider(
  id: string,
  health: 'UP' | 'DEGRADED' | 'AUTH_REQUIRED' | 'UNAVAILABLE',
): ProviderAdapter & { inspectionCount: () => number } {
  let inspectionCount = 0;
  const observation = {
    providerId: id,
    health,
    observedAt: '2026-09-23T12:00:00.000Z',
    staleAfterSeconds: 300,
    windows: [],
  };
  return {
    id,
    capabilities: () => ({
      usageRead: { supported: true, contract: 'official_supported' },
      resetRead: { supported: true, contract: 'official_supported' },
      windowTrigger: { supported: false, contract: 'unknown', consumesQuota: 'unknown' },
    }),
    health: () => Promise.resolve(health),
    inspect: () => {
      inspectionCount += 1;
      return Promise.resolve(observation);
    },
    triggerWindow: () => Promise.resolve({ accepted: false, reasonCode: 'TRIGGER_UNSUPPORTED' }),
    inspectionCount: () => inspectionCount,
  } as unknown as ProviderAdapter & { inspectionCount: () => number };
}

function managedProcess(): AuthManagedProcess & {
  written: string[];
  output(stream: 'stdout' | 'stderr', chunk: string): void;
} {
  const outputListeners = new Set<(stream: 'stdout' | 'stderr', chunk: string | Buffer) => void>();
  return {
    written: [],
    onOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    onExit: () => () => {},
    output(stream, chunk) {
      for (const listener of outputListeners) listener(stream, chunk);
    },
    writeInput(value: string) {
      this.written.push(value);
    },
    signal: () => {},
    waitForExit: () => Promise.resolve(true),
  };
}

function options(overrides: Partial<ProviderAuthDriverOptions> = {}): ProviderAuthDriverOptions {
  return {
    adapters: new Map([
      ['codex', provider('codex', 'UP')],
      ['antigravity', provider('antigravity', 'AUTH_REQUIRED')],
    ]),
    codexHome: '/private/codex-state',
    codexExecutable: '/opt/codex/bin/codex',
    antigravityHome: '/private/antigravity-state',
    antigravityExecutable: '/opt/antigravity/bin/agy',
    claudeCodeHome: '/private/claude-code-state',
    claudeCodeExecutable: '/opt/claude-code/bin/claude',
    openCodeGoHome: '/private/opencode-go-state',
    openCodeGoExecutable: '/opt/opencode/bin/opencode',
    ...overrides,
  };
}

function claudeAdapter(state: ClaudeAuthState) {
  return {
    ...provider('claude_code', 'AUTH_REQUIRED'),
    authStatus: vi.fn().mockResolvedValue(state),
  } as unknown as ProviderAdapter & {
    authStatus: (signal?: AbortSignal) => Promise<ClaudeAuthState>;
  };
}

describe('provider auth drivers', () => {
  it('checks Codex login status using the dedicated CODEX_HOME and fails closed on unknown output', async () => {
    const runCommand = vi
      .fn<NonNullable<ProviderAuthDriverOptions['runCommand']>>()
      .mockResolvedValueOnce({ code: 1, output: 'Not logged in', overflow: false })
      .mockResolvedValueOnce({ code: 0, output: 'Logged in', overflow: false })
      .mockResolvedValueOnce({ code: 1, output: 'network error', overflow: false });
    const drivers = createProviderAuthDrivers(options({ runCommand }));
    const driver = drivers.get('codex');
    if (!driver) throw new Error('Codex driver missing');

    await expect(driver.isAlreadyAuthenticated(new AbortController().signal)).resolves.toBe(false);
    await expect(driver.isAlreadyAuthenticated(new AbortController().signal)).resolves.toBe(true);
    await expect(
      driver.isAlreadyAuthenticated(new AbortController().signal),
    ).resolves.toBeUndefined();
    const [executable, args, commandOptions, signal] = runCommand.mock.calls[0]!;
    expect([executable, args, commandOptions.cwd]).toEqual([
      '/opt/codex/bin/codex',
      ['login', 'status'],
      '/tmp',
    ]);
    expect(commandOptions.env.HOME).toBe('/private/codex-state');
    expect(commandOptions.env.CODEX_HOME).toBe('/private/codex-state');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('treats overflow, timeout and unrecognized Codex status output as unknown', async () => {
    const runCommand = vi
      .fn<NonNullable<ProviderAuthDriverOptions['runCommand']>>()
      .mockResolvedValueOnce({ code: 1, output: 'Not logged in', overflow: true })
      .mockResolvedValueOnce({ code: null, output: '', overflow: false })
      .mockResolvedValueOnce({ code: 2, output: 'unexpected status', overflow: false });
    const driver = createProviderAuthDrivers(options({ runCommand })).get('codex');
    if (!driver) throw new Error('Codex driver missing');
    await expect(
      driver.isAlreadyAuthenticated(new AbortController().signal),
    ).resolves.toBeUndefined();
    await expect(
      driver.isAlreadyAuthenticated(new AbortController().signal),
    ).resolves.toBeUndefined();
    await expect(
      driver.isAlreadyAuthenticated(new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('uses the bounded local status runner fallback without contacting a provider', async () => {
    const driver = createProviderAuthDrivers(options({ codexExecutable: process.execPath })).get(
      'codex',
    );
    if (!driver) throw new Error('Codex driver missing');
    await expect(
      driver.isAlreadyAuthenticated(new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('launches the official Codex device flow in a PTY and accepts only its official auth host', () => {
    const process = managedProcess();
    const spawnProcess = vi.fn<NonNullable<ProviderAuthDriverOptions['spawnProcess']>>(
      () => process,
    );
    const driver = createProviderAuthDrivers(options({ spawnProcess })).get('codex');
    if (!driver) throw new Error('Codex driver missing');

    expect(driver.launch()).toBe(process);
    const [executable, args, processOptions] = spawnProcess.mock.calls[0]!;
    expect([executable, args, processOptions.cwd, processOptions.interactive]).toEqual([
      '/opt/codex/bin/codex',
      ['login', '--device-auth'],
      '/tmp',
      true,
    ]);
    expect(processOptions.env.CODEX_HOME).toBe('/private/codex-state');
    expect(
      driver.parseOutput('stderr', 'Open https://auth.openai.com/codex/device?flow=synthetic'),
    ).toEqual({
      awaitingUserAction: true,
      authorizationUrl: 'https://auth.openai.com/codex/device?flow=synthetic',
      requiresCodeSubmission: false,
    });
    expect(driver.parseOutput('stdout', 'Enter this code: ABCD-EFGHI')).toEqual({
      awaitingUserAction: true,
      authorizationUrl: 'https://auth.openai.com/codex/device?flow=synthetic',
      userCode: 'ABCD-EFGHI',
      requiresCodeSubmission: false,
    });
    expect(driver.parseOutputFragment?.('stdout', 'Enter this code: ABCD-EFGHI')).toEqual({
      awaitingUserAction: true,
      authorizationUrl: 'https://auth.openai.com/codex/device?flow=synthetic',
      userCode: 'ABCD-EFGHI',
      requiresCodeSubmission: false,
    });
    driver.launch();
    expect(
      driver.parseOutput('stdout', 'https://evil.example.test/device ABCD-EFGH'),
    ).toBeUndefined();
    expect(
      driver.parseOutput('stdout', 'https://auth.openai.com/device?access_token=synthetic-value'),
    ).toBeUndefined();
  });

  it('selects Google OAuth only from its explicit default selection and submits the user code', () => {
    const process = managedProcess();
    const spawnProcess = vi.fn<NonNullable<ProviderAuthDriverOptions['spawnProcess']>>(
      () => process,
    );
    const driver = createProviderAuthDrivers(options({ spawnProcess })).get('antigravity');
    if (!driver) throw new Error('Antigravity driver missing');

    expect(driver.launch()).toBe(process);
    const [executable, args, processOptions] = spawnProcess.mock.calls[0]!;
    expect([executable, args, processOptions.cwd, processOptions.interactive]).toEqual([
      '/opt/antigravity/bin/agy',
      [],
      '/private/antigravity-state',
      true,
    ]);
    expect(processOptions.env.HOME).toBe('/private/antigravity-state');
    expect(typeof processOptions.env.SSH_CONNECTION).toBe('string');
    expect(typeof processOptions.env.SSH_TTY).toBe('string');

    driver.onOutputLine?.(process, 'stdout', '> 1. Google OAuth');
    expect(process.written).toEqual([]);
    driver.onOutputLine?.(process, 'stdout', 'Select login method:');
    driver.onOutputLine?.(process, 'stdout', '> 2. Use a Google Cloud project');
    expect(process.written).toEqual([]);
    driver.onOutputLine?.(process, 'stdout', 'Select login method:');
    driver.onOutputLine?.(process, 'stdout', '> 1. Google OAuth');
    driver.onOutputLine?.(process, 'stdout', '> 1. Google OAuth');
    expect(process.written).toEqual(['\r']);

    const urlLineOne =
      'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=synthetic.apps.googleusercontent.com&code_challenge=synthetic';
    const urlLineTwo =
      'challenge&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=synthetic-state';
    expect(driver.parseOutput('stdout', urlLineOne)).toBeUndefined();
    expect(driver.parseOutput('stdout', urlLineTwo)).toBeUndefined();
    expect(
      driver.parseOutput('stdout', 'Copy and paste the URL or click on the link below:'),
    ).toEqual({
      awaitingUserAction: true,
      authorizationUrl:
        'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=synthetic.apps.googleusercontent.com&code_challenge=syntheticchallenge&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=synthetic-state',
      requiresCodeSubmission: true,
    });

    driver.launch();
    driver.parseOutput(
      'stdout',
      'https://accounts.google.com/o/oauth2/auth?client_id=synthetic&state=fragment-state',
    );
    expect(
      driver.parseOutputFragment?.(
        'stdout',
        'Copy and paste the URL or click here to authenticate',
      ),
    ).toEqual({
      awaitingUserAction: true,
      authorizationUrl:
        'https://accounts.google.com/o/oauth2/auth?client_id=synthetic&state=fragment-state',
      requiresCodeSubmission: true,
    });

    driver.submitCode(process, 'SYNTHETIC-CODE');
    expect(process.written).toEqual(['\r', 'SYNTHETIC-CODE\r']);
    expect(JSON.stringify(process.written)).not.toContain('refresh_token');
  });

  it('recognizes an invalid Antigravity code and rejects unsafe authorization URLs', () => {
    const process = managedProcess();
    const driver = createProviderAuthDrivers(options({ spawnProcess: () => process })).get(
      'antigravity',
    );
    if (!driver) throw new Error('Antigravity driver missing');
    driver.launch();
    driver.parseOutput('stdout', 'Open https://accounts.google.com/signin');
    driver.parseOutput('stdout', 'Copy and paste the URL or click on the link below:');
    expect(driver.parseOutput('stderr', 'Invalid authorization code')).toMatchObject({
      awaitingUserAction: true,
      requiresCodeSubmission: true,
      reasonCode: 'AUTH_CODE_REJECTED',
    });
    driver.launch();
    expect(
      driver.parseOutput('stdout', 'https://accounts.google.com.evil.test/login'),
    ).toBeUndefined();
    expect(
      driver.parseOutput('stdout', 'https://user:pass@accounts.google.com/login'),
    ).toBeUndefined();
    expect(
      driver.parseOutput('stdout', 'https://accounts.google.com/login?code=synthetic'),
    ).toBeUndefined();
    expect(
      driver.parseOutput('stdout', 'Copy and paste the URL or click on the link below:'),
    ).toBeUndefined();
    expect(driver.parseOutput('stdout', 'https://accounts.google.com:bad/login')).toBeUndefined();
    expect(
      driver.parseOutput('stdout', 'Copy and paste the URL or click on the link below:'),
    ).toBeUndefined();
  });

  it('returns no drivers when neither provider adapter is configured', () => {
    const drivers = createProviderAuthDrivers(options({ adapters: new Map() }));
    expect(drivers.size).toBe(0);
  });

  it('does not overwrite authenticated Agy state and treats an unavailable status as unknown', async () => {
    const agyAuthenticated = provider('antigravity', 'DEGRADED');
    const agyUnavailable = provider('antigravity', 'UNAVAILABLE');
    const driver = createProviderAuthDrivers(
      options({ adapters: new Map([['antigravity', agyAuthenticated]]) }),
    ).get('antigravity');
    if (!driver) throw new Error('Antigravity driver missing');
    await expect(driver.isAlreadyAuthenticated(new AbortController().signal)).resolves.toBe(true);
    await expect(driver.verify(new AbortController().signal)).resolves.toBe(true);

    const unavailable = createProviderAuthDrivers(
      options({ adapters: new Map([['antigravity', agyUnavailable]]) }),
    ).get('antigravity');
    if (!unavailable) throw new Error('Antigravity driver missing');
    await expect(
      unavailable.isAlreadyAuthenticated(new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('verifies Codex only through the normalized official adapter result', async () => {
    const codex = provider('codex', 'DEGRADED');
    const driver = createProviderAuthDrivers(
      options({ adapters: new Map([['codex', codex]]) }),
    ).get('codex');
    if (!driver) throw new Error('Codex driver missing');
    await expect(driver.verify(new AbortController().signal)).resolves.toBe(true);
    expect(codex.inspectionCount()).toBe(1);
  });

  it('checks Claude Code status without usage reads and never replaces an existing login', async () => {
    const statusAdapter = {
      authStatus: vi
        .fn()
        .mockResolvedValueOnce({ state: 'unauthenticated' })
        .mockResolvedValueOnce({ state: 'unsupported_auth' })
        .mockResolvedValueOnce({ state: 'unknown' })
        .mockResolvedValueOnce({
          state: 'authenticated',
          accountFingerprint: 'synthetic-fingerprint',
          subscriptionType: 'pro',
        })
        .mockResolvedValueOnce({
          state: 'authenticated',
          accountFingerprint: 'synthetic-fingerprint',
          subscriptionType: 'pro',
        })
        .mockResolvedValueOnce({ state: 'unauthenticated' }),
    };
    const adapter = {
      ...provider('claude_code', 'AUTH_REQUIRED'),
      ...statusAdapter,
    } as unknown as ProviderAdapter & typeof statusAdapter;
    const driver = createProviderAuthDrivers(
      options({ adapters: new Map([['claude_code', adapter]]) }),
    ).get('claude_code');
    if (!driver) throw new Error('Claude Code auth driver missing');

    const signal = new AbortController().signal;
    await expect(driver.isAlreadyAuthenticated(signal)).resolves.toBe(false);
    await expect(driver.isAlreadyAuthenticated(signal)).resolves.toBe(true);
    await expect(driver.isAlreadyAuthenticated(signal)).resolves.toBeUndefined();
    await expect(driver.isAlreadyAuthenticated(signal)).resolves.toBe(true);
    await expect(driver.verify(signal)).resolves.toBe(true);
    await expect(driver.verify(signal)).resolves.toBe(false);
    expect(statusAdapter.authStatus).toHaveBeenCalledTimes(6);
    expect(statusAdapter.authStatus).toHaveBeenCalledWith(signal);
  });

  it('starts the official Claude Code browser flow in an isolated interactive PTY', () => {
    const process = managedProcess();
    const spawnProcess = vi.fn<NonNullable<ProviderAuthDriverOptions['spawnProcess']>>(
      () => process,
    );
    const adapter = claudeAdapter({ state: 'unauthenticated' });
    const driver = createProviderAuthDrivers(
      options({
        adapters: new Map([['claude_code', adapter]]),
        claudeCodeHome: './private-claude-code-state',
        spawnProcess,
      }),
    ).get('claude_code');
    if (!driver) throw new Error('Claude Code auth driver missing');

    expect(driver.launch()).toBe(process);
    const [executable, args, processOptions] = spawnProcess.mock.calls[0]!;
    expect([executable, args, processOptions.cwd, processOptions.interactive]).toEqual([
      '/opt/claude-code/bin/claude',
      ['auth', 'login'],
      '/tmp',
      true,
    ]);
    expect(processOptions.env.HOME).toBe(path.resolve('./private-claude-code-state'));
    expect(processOptions.env.CLAUDE_CONFIG_DIR).toBe(path.resolve('./private-claude-code-state'));
    expect(processOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(processOptions.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(path.isAbsolute(processOptions.env.CLAUDE_CONFIG_DIR ?? '')).toBe(true);

    expect(
      driver.parseOutput(
        'stdout',
        'Open this URL in your browser: https://claude.com/oauth/authorize?state=synthetic',
      ),
    ).toEqual({
      awaitingUserAction: true,
      authorizationUrl: 'https://claude.com/oauth/authorize?state=synthetic',
      requiresCodeSubmission: false,
    });
    expect(driver.parseOutputFragment?.('stdout', 'Paste code here if prompted:')).toMatchObject({
      awaitingUserAction: true,
      authorizationUrl: 'https://claude.com/oauth/authorize?state=synthetic',
      requiresCodeSubmission: true,
    });
    expect(driver.parseOutput('stderr', 'Invalid code')).toMatchObject({
      awaitingUserAction: true,
      authorizationUrl: 'https://claude.com/oauth/authorize?state=synthetic',
      requiresCodeSubmission: true,
      reasonCode: 'AUTH_CODE_REJECTED',
    });

    driver.submitCode(process, 'synthetic-one-time-code');
    driver.onOutputLine?.(process, 'stdout', 'Login successful');
    driver.onOutputLine?.(process, 'stdout', 'Login successful');
    expect(process.written).toEqual(['synthetic-one-time-code\r', '\r']);
  });

  it('fails closed on unsafe Claude authorization URLs and requires the exact host', () => {
    const driver = createProviderAuthDrivers(
      options({
        adapters: new Map([['claude_code', claudeAdapter({ state: 'unauthenticated' })]]),
      }),
    ).get('claude_code');
    if (!driver) throw new Error('Claude Code auth driver missing');
    driver.launch();

    for (const url of [
      'https://claude.com.evil.test/oauth/start',
      'https://user:pass@claude.com/oauth/start',
      'https://claude.com/oauth/start?code=synthetic',
      'https://claude.com:bad/oauth/start',
      'http://claude.com/oauth/start',
    ]) {
      expect(driver.parseOutput('stdout', `Open ${url}`)).toBeUndefined();
    }
    expect(driver.parseOutputFragment?.('stdout', 'unrelated output')).toBeUndefined();
  });

  it('remembers a split Claude code prompt that arrives before its authorization URL', () => {
    const driver = createProviderAuthDrivers(
      options({
        adapters: new Map([['claude_code', claudeAdapter({ state: 'unauthenticated' })]]),
      }),
    ).get('claude_code');
    if (!driver) throw new Error('Claude Code auth driver missing');
    driver.launch();

    expect(driver.parseOutputFragment?.('stdout', 'Paste code here if prompted:')).toBeUndefined();
    expect(
      driver.parseOutput(
        'stdout',
        'Open this URL: https://claude.com/oauth/authorize?state=synthetic',
      ),
    ).toMatchObject({ requiresCodeSubmission: true });
  });

  it('publishes a complete Claude authorization URL from an unterminated PTY fragment', () => {
    const driver = createProviderAuthDrivers(
      options({
        adapters: new Map([['claude_code', claudeAdapter({ state: 'unauthenticated' })]]),
      }),
    ).get('claude_code');
    if (!driver) throw new Error('Claude Code driver missing');
    driver.launch();

    expect(
      driver.parseOutputFragment?.(
        'stdout',
        'Open this URL: https://claude.com/oauth/authorize?state=synthetic',
      ),
    ).toEqual({
      awaitingUserAction: true,
      authorizationUrl: 'https://claude.com/oauth/authorize?state=synthetic',
      requiresCodeSubmission: false,
    });
  });

  it('publishes Claude Code’s one-time bootstrap URL after its code prompt', () => {
    const driver = createProviderAuthDrivers(
      options({
        adapters: new Map([['claude_code', claudeAdapter({ state: 'unauthenticated' })]]),
      }),
    ).get('claude_code');
    if (!driver) throw new Error('Claude Code auth driver missing');
    driver.launch();

    const url = CLAUDE_BOOTSTRAP_URL;
    expect(driver.parseOutputFragment?.('stdout', `Visit ${url}`)).toBeUndefined();
    expect(driver.parseOutputFragment?.('stdout', 'Paste code here if prompted >')).toEqual({
      awaitingUserAction: true,
      authorizationUrl: url,
      requiresCodeSubmission: true,
    });
  });

  it('reassembles Claude Code bootstrap URLs wrapped across PTY lines', () => {
    const driver = createProviderAuthDrivers(
      options({
        adapters: new Map([['claude_code', claudeAdapter({ state: 'unauthenticated' })]]),
      }),
    ).get('claude_code');
    if (!driver) throw new Error('Claude Code auth driver missing');
    driver.launch();

    const url = CLAUDE_BOOTSTRAP_URL;
    const splitAt = url.indexOf('code=') + 'code='.length + 12;
    expect(
      driver.parseOutput('stdout', `If the browser did not open, visit: ${url.slice(0, splitAt)}`),
    ).toBeUndefined();
    expect(driver.parseOutput('stdout', url.slice(splitAt))).toBeUndefined();
    expect(driver.parseOutput('stdout', 'Paste code here if prompted >')).toEqual({
      awaitingUserAction: true,
      authorizationUrl: url,
      requiresCodeSubmission: true,
    });
  });

  it('moves the managed Claude sign-in session to the browser step for the observed OAuth URL', async () => {
    const process = managedProcess();
    const driver = createProviderAuthDrivers(
      options({
        adapters: new Map([['claude_code', claudeAdapter({ state: 'unauthenticated' })]]),
        spawnProcess: () => process,
      }),
    ).get('claude_code');
    if (!driver) throw new Error('Claude Code auth driver missing');

    const manager = new AuthSessionManager({
      clock: {
        now: () => new Date('2026-11-04T00:00:00.000Z'),
        monotonicMs: () => 0,
      },
      drivers: new Map([['claude_code', driver]]),
      startupTimeoutMs: 1_000,
      sessionTimeoutMs: 10_000,
      processStopGraceMs: 1,
    });
    manager.start('claude_code');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    process.output(
      'stdout',
      `Opening browser to sign in…\r\nIf the browser didn't open, visit: ${CLAUDE_BOOTSTRAP_URL}\r\nPaste code here if prompted >`,
    );

    expect(manager.status('claude_code')).toMatchObject({
      state: 'AWAITING_USER_ACTION',
      authorizationUrl: CLAUDE_BOOTSTRAP_URL,
      requiresCodeSubmission: true,
    });
    await manager.shutdown();
  });

  it('does not start Claude sign-in when auth status is unavailable', async () => {
    const adapter = claudeAdapter({ state: 'unknown' });
    const spawnProcess = vi.fn<NonNullable<ProviderAuthDriverOptions['spawnProcess']>>(() =>
      managedProcess(),
    );
    const driver = createProviderAuthDrivers(
      options({ adapters: new Map([['claude_code', adapter]]), spawnProcess }),
    ).get('claude_code');
    if (!driver) throw new Error('Claude Code auth driver missing');

    await expect(
      driver.isAlreadyAuthenticated(new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

describe('OpenCode Go auth driver', () => {
  // Lines captured from the real official CLI (SPIKE-008), after terminal-control stripping.
  const DEVICE_URL =
    'https://opencode.ai/console/device?user_code=NPMX-PNKR&client_id=opencode-cli';
  const TRANSCRIPT = [
    '┌  Connect an integration',
    '│',
    '◒  Starting authorization◐  Starting authorization◇  Authorization started',
    '│',
    '●  Enter code: NPMX-PNKR',
    '│',
    `●  ${DEVICE_URL}`,
    '│',
    '◇  Waiting for authorization...',
  ];

  function driverWith(
    health: 'UP' | 'DEGRADED' | 'AUTH_REQUIRED' | 'UNAVAILABLE' = 'AUTH_REQUIRED',
  ) {
    const adapter = provider('opencode_go', health);
    const process = managedProcess();
    const spawnProcess = vi.fn<NonNullable<ProviderAuthDriverOptions['spawnProcess']>>(
      () => process,
    );
    const driver = createProviderAuthDrivers(
      options({ adapters: new Map([['opencode_go', adapter]]), spawnProcess }),
    ).get('opencode_go');
    if (!driver) throw new Error('OpenCode Go auth driver missing');
    return { adapter, process, spawnProcess, driver };
  }

  it('is only created when the OpenCode Go adapter is configured', () => {
    expect(createProviderAuthDrivers(options()).has('opencode_go')).toBe(false);
    expect(driverWith().driver.providerId).toBe('opencode_go');
  });

  it('launches the Console device method directly, over pipes, in the isolated home', () => {
    const { process, spawnProcess, driver } = driverWith();
    expect(driver.launch()).toBe(process);
    const [executable, args, processOptions] = spawnProcess.mock.calls[0]!;
    expect(executable).toBe('/opt/opencode/bin/opencode');
    // The method is explicit, so the login-method menu (and its API-key entry) never appears.
    expect(args).toEqual(['--standalone', 'auth', 'login', 'opencode', '--method', 'device']);
    expect(processOptions.cwd).toBe('/private/opencode-go-state');
    expect(processOptions.interactive).toBeUndefined();
    expect(processOptions.env).toMatchObject({
      HOME: '/private/opencode-go-state',
      XDG_DATA_HOME: '/private/opencode-go-state/.local/share',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    expect(Object.keys(processOptions.env)).not.toContain('OPENCODE_API_KEY');
  });

  it('publishes the code and URL from the observed transcript without any code submission', () => {
    const { driver } = driverWith();
    driver.launch();
    const updates = TRANSCRIPT.map((line) => driver.parseOutput('stdout', line)).filter(Boolean);
    expect(updates).toEqual([
      // the code line arrives first; no URL yet, so nothing is published for it
      {
        awaitingUserAction: true,
        authorizationUrl: DEVICE_URL,
        userCode: 'NPMX-PNKR',
        requiresCodeSubmission: false,
      },
    ]);
    expect(() => driver.submitCode(managedProcess(), '123456')).toThrow(/official website/);
  });

  it('takes the code from the URL when the labeled line was not seen', () => {
    const { driver } = driverWith();
    driver.launch();
    expect(driver.parseOutput('stdout', `●  ${DEVICE_URL}`)).toEqual({
      awaitingUserAction: true,
      authorizationUrl: DEVICE_URL,
      userCode: 'NPMX-PNKR',
      requiresCodeSubmission: false,
    });
    // a standalone code line is accepted, an unrelated line is not
    expect(driver.parseOutput('stdout', '   ABCD-EFGH  ')).toMatchObject({ userCode: 'ABCD-EFGH' });
    expect(driver.parseOutput('stdout', '◇  Waiting for authorization...')).toBeUndefined();
  });

  it('forgets a previous attempt on relaunch and rejects unsafe or unexpected URLs', () => {
    const { driver } = driverWith();
    driver.launch();
    driver.parseOutput('stdout', `●  ${DEVICE_URL}`);
    driver.launch();
    expect(driver.parseOutput('stdout', 'Enter code: ABCD-EFGH')).toBeUndefined();
    for (const bad of [
      'https://evil.example.test/console/device?user_code=ABCD-EFGH',
      'https://opencode.ai.evil.test/console/device?user_code=ABCD-EFGH',
      'http://opencode.ai/console/device?user_code=ABCD-EFGH',
      'https://opencode.ai/console/other?user_code=ABCD-EFGH',
      'https://opencode.ai/console/device?user_code=ABCD-EFGH&access_token=synthetic',
      'https://opencode.ai/console/device?user_code=ABCD-EFGH&redirect=https://evil.test',
      'https://opencode.ai/console/device?user_code=lowercase&client_id=opencode-cli',
      'https://opencode.ai/console/device?client_id=opencode-cli',
      'https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=other',
    ]) {
      expect(driver.parseOutput('stdout', bad)).toBeUndefined();
    }
  });

  it('checks existing sign-in through a fresh usage read and never replaces a login', async () => {
    const signal = new AbortController().signal;
    await expect(driverWith('AUTH_REQUIRED').driver.isAlreadyAuthenticated(signal)).resolves.toBe(
      false,
    );
    await expect(driverWith('UP').driver.isAlreadyAuthenticated(signal)).resolves.toBe(true);
    // signed in without a Go subscription is still an existing login
    await expect(driverWith('DEGRADED').driver.isAlreadyAuthenticated(signal)).resolves.toBe(true);
    await expect(driverWith('UNAVAILABLE').driver.isAlreadyAuthenticated(signal)).resolves.toBe(
      undefined,
    );
  });

  it('verifies only through the normalized adapter observation', async () => {
    const signal = new AbortController().signal;
    await expect(driverWith('UP').driver.verify(signal)).resolves.toBe(true);
    await expect(driverWith('DEGRADED').driver.verify(signal)).resolves.toBe(true);
    await expect(driverWith('AUTH_REQUIRED').driver.verify(signal)).resolves.toBe(false);
    await expect(driverWith('UNAVAILABLE').driver.verify(signal)).resolves.toBe(false);
  });

  it('uses the shared inspection coordinator when one is provided', async () => {
    const adapter = provider('opencode_go', 'UP');
    const inspectFresh = vi.fn<
      (adapter: unknown, context: unknown, purpose: string) => Promise<never>
    >(() => Promise.resolve({ health: 'UP', windows: [] } as never));
    const driver = createProviderAuthDrivers(
      options({
        adapters: new Map([['opencode_go', adapter]]),
        inspections: { inspectFresh } as never,
      }),
    ).get('opencode_go')!;
    const signal = new AbortController().signal;
    await driver.isAlreadyAuthenticated(signal);
    await driver.verify(signal);
    expect(inspectFresh.mock.calls.map((call) => call[2])).toEqual(['auth_check', 'auth_verify']);
    expect(adapter.inspectionCount()).toBe(0);
  });

  it('moves a managed sign-in session to the browser step and then verifies it', async () => {
    const process = managedProcess();
    let health: 'AUTH_REQUIRED' | 'UP' = 'AUTH_REQUIRED';
    const adapter = {
      ...provider('opencode_go', 'AUTH_REQUIRED'),
      inspect: () =>
        Promise.resolve({
          providerId: 'opencode_go',
          health,
          observedAt: '2026-11-21T12:00:00.000Z',
          staleAfterSeconds: 300,
          windows: [],
        }),
    } as unknown as ProviderAdapter;
    const driver = createProviderAuthDrivers(
      options({ adapters: new Map([['opencode_go', adapter]]), spawnProcess: () => process }),
    ).get('opencode_go')!;
    const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
    process.onExit = (listener) => {
      exitListeners.push(listener);
      return () => {};
    };

    const manager = new AuthSessionManager({
      clock: { now: () => new Date('2026-11-21T12:00:00.000Z'), monotonicMs: () => 0 },
      drivers: new Map([['opencode_go', driver]]),
      startupTimeoutMs: 1_000,
      sessionTimeoutMs: 10_000,
      processStopGraceMs: 1,
    });
    manager.start('opencode_go');
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();

    process.output('stdout', `${TRANSCRIPT.join('\r\n')}\r\n`);
    expect(manager.status('opencode_go')).toMatchObject({
      state: 'AWAITING_USER_ACTION',
      authorizationUrl: DEVICE_URL,
      userCode: 'NPMX-PNKR',
      requiresCodeSubmission: false,
    });
    // The operator approves in the browser; the CLI exits and the usage read now succeeds.
    health = 'UP';
    for (const listener of exitListeners) listener(0, null);
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    expect(manager.status('opencode_go').state).toBe('SUCCEEDED');
    expect(process.written).toEqual([]);
    await manager.shutdown();
  });
});
