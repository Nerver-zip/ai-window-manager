import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AntigravityActionTransportError,
  AntigravityTransportError,
  runAntigravityTriggerCommand,
  runAntigravityUsageCommand,
} from '../../../src/providers/antigravity/transport.js';
import { scriptedProcessFactory, type FakeAntigravityProcess } from './support.js';

const validJson = '{"status":"ERROR","error":"Authentication required"}';
const validActionJson = '{"status":"SUCCESS","response":"Hello.","num_turns":1}';

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

describe('Antigravity action transport', () => {
  const defaults = {
    executable: '/opt/agy',
    model: 'gemini-3.8-flash-low',
    timeoutMs: 1_000,
  };

  it('passes only the fixed prompt and explicit safe CLI arguments without a shell', async () => {
    let observedArgs: string[] = [];
    let observedShell: boolean | undefined;
    let observedEnvIsSanitized: boolean | undefined;
    await runAntigravityTriggerCommand({
      ...defaults,
      spawnProcess: (executable, args, options) => {
        observedArgs = args;
        observedShell = options.shell;
        observedEnvIsSanitized = Object.keys(options.env ?? {}).every((name) =>
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
        );
        return scriptedProcessFactory((process) => process.complete(validActionJson))(
          executable,
          args,
          options,
        );
      },
    });

    expect(observedArgs).toEqual([
      '-p',
      'Hi!',
      '--model',
      defaults.model,
      '--output-format',
      'json',
      '--print-timeout',
      '1s',
      '--sandbox',
    ]);
    expect(observedShell).toBe(false);
    expect(observedEnvIsSanitized).toBe(true);
  });

  it('returns structured stdout only after successful process completion', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) => process.complete(validActionJson)),
      }),
    ).resolves.toBe(validActionJson);
  });

  it('accepts string stream chunks and ignores late child errors after settlement', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) => {
          process.stdout.setEncoding('utf8');
          process.stderr.setEncoding('utf8');
          process.complete(validActionJson, 0, 'bounded diagnostic');
          queueMicrotask(() => process.emit('error', new Error('late child error')));
        }),
      }),
    ).resolves.toBe(validActionJson);
  });

  it('classifies a synchronous process factory throw as pre-dispatch failure', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: () => {
          throw new Error('private spawn path');
        },
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
  });

  it('keeps authentication output after spawn uncertain because dispatch cannot be proven', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) =>
          process.complete('', 1, 'Authentication required; sign in first.'),
        ),
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'uncertain' });
  });

  it('classifies any other non-zero exit after spawn as uncertain', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) =>
          process.complete('', 7, 'provider internal diagnostic'),
        ),
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'uncertain' });
  });

  it('classifies executable spawn failure as pre-dispatch failure', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) =>
          process.fail(Object.assign(new Error('private path'), { code: 'ENOENT' })),
        ),
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
  });

  it('classifies close before spawn as a pre-dispatch failure', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) => {
          queueMicrotask(() => process.emit('close', 1, null));
        }),
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
  });

  it('classifies stdin failure after spawn as uncertain', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) => {
          process.start();
          queueMicrotask(() => process.stdin.emit('error', new Error('private stdin detail')));
        }),
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'uncertain' });
  });

  it('classifies a timeout before the child starts as a pre-dispatch failure', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        timeoutMs: 10,
        spawnProcess: scriptedProcessFactory(() => undefined),
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
  });

  it('rejects unbounded timeouts and unsafe model arguments before spawn', async () => {
    let spawnCount = 0;
    const spawnProcess = () => {
      spawnCount += 1;
      throw new Error('must not spawn');
    };
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        timeoutMs: 120_001,
        spawnProcess,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        model: '--dangerously-skip-permissions',
        spawnProcess,
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
    expect(spawnCount).toBe(0);
  });

  it('classifies an unexpected process error after spawn as uncertain', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) => {
          process.start();
          queueMicrotask(() => process.emit('error', new Error('synthetic private detail')));
        }),
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'uncertain' });
  });

  it('treats timeout after spawn as uncertain and terminates the child', async () => {
    let processRef: FakeAntigravityProcess | undefined;
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        timeoutMs: 10,
        spawnProcess: scriptedProcessFactory(
          (process) => process.start(),
          (process) => {
            processRef = process;
          },
        ),
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'uncertain' });
    expect(processRef?.killSignals).toContain('SIGTERM');
  });

  it('keeps cleanup safe when both termination signals fail', async () => {
    vi.useFakeTimers();
    let processRef: FakeAntigravityProcess | undefined;
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    try {
      const pending = runAntigravityTriggerCommand({
        ...defaults,
        timeoutMs: 100,
        spawnProcess: scriptedProcessFactory(
          (process) => {
            process.exitCode = null;
            process.signalCode = null;
            process.kill = (signal) => {
              process.killSignals.push(signal);
              throw new Error('synthetic termination failure');
            };
            process.start();
          },
          (process) => {
            processRef = process;
            process.once('spawn', () => markSpawned?.());
          },
        ),
      });
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'OUTCOME_UNKNOWN',
        disposition: 'uncertain',
      });

      await spawned;
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      await vi.advanceTimersByTimeAsync(250);
      expect(processRef?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats abort after spawn as uncertain but abort before spawn as a safe failure', async () => {
    const controller = new AbortController();
    let processRef: FakeAntigravityProcess | undefined;
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const dispatched = runAntigravityTriggerCommand({
      ...defaults,
      signal: controller.signal,
      spawnProcess: scriptedProcessFactory(
        (process) => process.start(),
        (process) => {
          processRef = process;
          process.once('spawn', () => markSpawned?.());
        },
      ),
    });
    await spawned;
    controller.abort();
    await expect(dispatched).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'uncertain',
    });
    expect(processRef?.killSignals).toContain('SIGTERM');

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let spawnCount = 0;
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        signal: alreadyAborted.signal,
        spawnProcess: () => {
          spawnCount += 1;
          throw new Error('must not spawn');
        },
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
    expect(spawnCount).toBe(0);
  });

  it('bounds action output and never includes provider diagnostics in safe errors', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) =>
          process.complete('x'.repeat(128 * 1024 + 1)),
        ),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AntigravityActionTransportError);
      expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'uncertain' });
      expect(String(error)).not.toContain('x'.repeat(64));
      return true;
    });

    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) =>
          process.complete('', 0, 'x'.repeat(16 * 1024 + 1)),
        ),
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'uncertain' });
  });
});
