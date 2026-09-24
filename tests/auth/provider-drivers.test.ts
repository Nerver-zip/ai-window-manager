import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import {
  createProviderAuthDrivers,
  type ProviderAuthDriverOptions,
} from '../../src/auth/provider-drivers.js';
import type { AuthManagedProcess } from '../../src/auth/session-manager.js';

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

function managedProcess(): AuthManagedProcess & { written: string[] } {
  return {
    written: [],
    onOutput: () => () => {},
    onExit: () => () => {},
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
    ...overrides,
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

  it('launches only the official Codex device flow and accepts only its official auth host', () => {
    const process = managedProcess();
    const spawnProcess = vi.fn<NonNullable<ProviderAuthDriverOptions['spawnProcess']>>(
      () => process,
    );
    const driver = createProviderAuthDrivers(options({ spawnProcess })).get('codex');
    if (!driver) throw new Error('Codex driver missing');

    expect(driver.launch()).toBe(process);
    const [executable, args, processOptions] = spawnProcess.mock.calls[0]!;
    expect([executable, args, processOptions.cwd]).toEqual([
      '/opt/codex/bin/codex',
      ['login', '--device-auth'],
      '/tmp',
    ]);
    expect(processOptions.env.CODEX_HOME).toBe('/private/codex-state');
    expect(
      driver.parseOutput(
        'stderr',
        'Open https://auth.openai.com/codex/device?flow=synthetic and enter code: ABCD-EFGH',
      ),
    ).toEqual({
      awaitingUserAction: true,
      authorizationUrl: 'https://auth.openai.com/codex/device?flow=synthetic',
      userCode: 'ABCD-EFGH',
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

  it('uses the official Antigravity interactive flow and submits only the user-entered code', () => {
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
    expect(
      driver.parseOutput('stdout', 'Open https://accounts.google.com/o/oauth2/auth?flow=synthetic'),
    ).toEqual({
      awaitingUserAction: true,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?flow=synthetic',
      requiresCodeSubmission: true,
    });
    driver.submitCode(process, 'SYNTHETIC-CODE');
    expect(process.written).toEqual(['SYNTHETIC-CODE\r']);
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
    expect(driver.parseOutput('stdout', 'https://accounts.google.com:bad/login')).toBeUndefined();
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
});
