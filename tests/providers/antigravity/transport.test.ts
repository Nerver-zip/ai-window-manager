import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AntigravityTransportError,
  runAntigravityUsageCommand,
} from '../../../src/providers/antigravity/transport.js';
import { scriptedProcessFactory } from './support.js';
import type { FakeAntigravityProcess } from './support.js';

const validJson = '{"status":"ERROR","error":"Authentication required"}';

afterEach(() => vi.unstubAllEnvs());

describe('Antigravity CLI transport', () => {
  it('classifies non-zero authentication output without returning raw diagnostics', async () => {
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: scriptedProcessFactory((process) =>
          process.complete('', 1, 'Authentication required for private account path'),
        ),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('classifies other non-zero exits as unavailable', async () => {
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: scriptedProcessFactory((process) =>
          process.complete('', 7, 'temporary failure'),
        ),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('classifies a provider timeout and sends termination signals', async () => {
    let processRef: FakeAntigravityProcess | undefined;
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 1,
        timeoutMs: 10,
        spawnProcess: scriptedProcessFactory(
          () => undefined,
          (process) => {
            processRef = process;
          },
        ),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(processRef?.killSignals).toContain('SIGTERM');
  });

  it('classifies an aborted inspection as unavailable', async () => {
    const controller = new AbortController();
    let processRef: FakeAntigravityProcess | undefined;
    const promise = runAntigravityUsageCommand({
      executable: '/opt/agy',
      printTimeoutSeconds: 1,
      timeoutMs: 1_000,
      signal: controller.signal,
      spawnProcess: scriptedProcessFactory(
        () => undefined,
        (process) => {
          processRef = process;
        },
      ),
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(processRef?.killSignals).toContain('SIGTERM');
  });

  it('classifies an executable spawn error safely', async () => {
    await expect(
      runAntigravityUsageCommand({
        executable: '/missing/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: scriptedProcessFactory((process) => {
          process.fail(Object.assign(new Error('secret path'), { code: 'ENOENT' }));
        }),
      }),
    ).rejects.toMatchObject({ code: 'EXECUTABLE_UNAVAILABLE' });
  });

  it('classifies a factory throw as unavailable without exposing the thrown error', async () => {
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: () => {
          throw new Error('secret spawn detail');
        },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('bounds stdout and stderr before returning provider data', async () => {
    const hugeStdout = 'x'.repeat(512 * 1024 + 1);
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: scriptedProcessFactory((process) => process.complete(hugeStdout)),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });

    const hugeStderr = 'x'.repeat(16 * 1024 + 1);
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: scriptedProcessFactory((process) => process.complete('', 0, hugeStderr)),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
  });

  it('returns bounded stdout only after a successful exit', async () => {
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: scriptedProcessFactory((process) => process.complete(validJson)),
      }),
    ).resolves.toBe(validJson);
  });

  it('passes only provider runtime variables to the official CLI process', async () => {
    vi.stubEnv('AWM_SYNTHETIC_SECRET', 'never-forward-this');
    let processRef: FakeAntigravityProcess | undefined;
    await runAntigravityUsageCommand({
      executable: '/opt/agy',
      printTimeoutSeconds: 30,
      timeoutMs: 1_000,
      spawnProcess: scriptedProcessFactory(
        (process) => process.complete(validJson),
        (process) => {
          processRef = process;
        },
      ),
    });

    expect(processRef?.options.env).not.toHaveProperty('AWM_SYNTHETIC_SECRET');
    expect(
      Object.keys(processRef?.options.env ?? {}).every((name) =>
        [
          'HOME',
          'PATH',
          'LANG',
          'LC_ALL',
          'TERM',
          'TMPDIR',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_CACHE_HOME',
          'XDG_STATE_HOME',
          'XDG_RUNTIME_DIR',
          'DBUS_SESSION_BUS_ADDRESS',
        ].includes(name),
      ),
    ).toBe(true);
  });

  it('recognizes explicit auth markers case-insensitively in stderr', async () => {
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: scriptedProcessFactory((process) =>
          process.complete('', 2, 'Please LOG IN before using this command'),
        ),
      }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it.each([
    ['secret keyring is locked', 'KEYRING_LOCKED'],
    ['secret service is unavailable', 'SECRET_SERVICE_UNAVAILABLE'],
    ['Failed to connect to D-Bus', 'DBUS_UNAVAILABLE'],
  ])('classifies bounded runtime failure %s as %s', async (diagnostic, code) => {
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: scriptedProcessFactory((process) => process.complete('', 1, diagnostic)),
      }),
    ).rejects.toMatchObject({ code });
  });

  it('does not leak raw transport diagnostics through safe errors', async () => {
    const secret = 'authorization=synthetic-not-a-secret';
    await expect(
      runAntigravityUsageCommand({
        executable: '/opt/agy',
        printTimeoutSeconds: 30,
        timeoutMs: 1_000,
        spawnProcess: scriptedProcessFactory((process) => process.complete('', 1, secret)),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AntigravityTransportError);
      expect(String(error)).not.toContain(secret);
      return true;
    });
  });
});
