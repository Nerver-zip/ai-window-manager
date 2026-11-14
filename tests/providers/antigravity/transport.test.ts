import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AntigravityActionTransportError,
  AntigravityTransportError,
  runAntigravityTriggerCommand,
  runAntigravityUsageCommand,
} from '../../../src/providers/antigravity/transport.js';
import {
  hangingStreamingActionProcessFactory,
  scriptedProcessFactory,
  streamingActionProcessFactory,
  type FakeAntigravityProcess,
} from './support.js';
import { DispatchAuthorizationError } from '../../../src/providers/dispatch-authorization.js';

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
  it('checks authorization after durable conversation registration and before writing the prompt', async () => {
    let registered = false;
    let prompts = 0;
    await expect(
      runAntigravityTriggerCommand({
        executable: '/opt/agy',
        model: 'gemini-3.8-flash-low',
        timeoutMs: 1_000,
        registerCleanupArtifact: () => {
          registered = true;
          return Promise.resolve();
        },
        cleanupUnregisteredConversation: () => Promise.resolve(),
        assertDispatchAllowed: () => {
          expect(registered).toBe(true);
          throw new DispatchAuthorizationError('ACTION_PROVIDER_UNAVAILABLE');
        },
        spawnProcess: streamingActionProcessFactory(validActionJson, () => {
          prompts += 1;
        }),
      }),
    ).rejects.toMatchObject({ reasonCode: 'ACTION_PROVIDER_UNAVAILABLE' });
    expect(prompts).toBe(0);
    expect(registered).toBe(true);
  });

  const defaults = {
    executable: '/opt/agy',
    model: 'gemini-3.8-flash-low',
    timeoutMs: 1_000,
    registerCleanupArtifact: () => Promise.resolve(),
    cleanupUnregisteredConversation: () => Promise.resolve(),
  };

  it('uses official stream-json input/output and sends the fixed prompt only after cleanup registration', async () => {
    let observedArgs: string[] = [];
    let observedShell: boolean | undefined;
    let observedEnvIsSanitized: boolean | undefined;
    let registered = false;
    let observedInput = '';
    await runAntigravityTriggerCommand({
      ...defaults,
      registerCleanupArtifact: (artifact) => {
        expect(artifact).toEqual({
          kind: 'antigravity_conversation',
          externalId: '00000000-0000-4000-8000-000000000001',
        });
        registered = true;
        return Promise.resolve();
      },
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
        return streamingActionProcessFactory(validActionJson, (input) => {
          observedInput = input;
          expect(registered).toBe(true);
        })(executable, args, options);
      },
    });

    expect(observedArgs).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      defaults.model,
      '--print-timeout',
      '1s',
      '--sandbox',
    ]);
    expect(JSON.parse(observedInput)).toEqual({
      event: 'user',
      message: { content: 'Hi!' },
    });
    expect(observedShell).toBe(false);
    expect(observedEnvIsSanitized).toBe(true);
  });

  it('returns only the terminal result after successful stream completion', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: streamingActionProcessFactory(validActionJson),
      }),
    ).resolves.toSatisfy((output: string) => {
      const result = JSON.parse(output) as Record<string, unknown>;
      expect(result).toMatchObject({ status: 'SUCCESS', num_turns: 1 });
      expect(String(result.response)).toBe('Hello.');
      return true;
    });
  });

  it('accepts string stream chunks and returns only the terminal result, not progress events', async () => {
    const output = await runAntigravityTriggerCommand({
      ...defaults,
      spawnProcess: streamingActionProcessFactory(
        validActionJson,
        undefined,
        undefined,
        0,
        'bounded diagnostic',
        (process) => process.stdout.setEncoding('utf8'),
      ),
    });
    expect(output).toContain('Hello.');
    expect(output).not.toContain('step_update');
  });

  it('does not send the prompt if durable conversation registration fails', async () => {
    let observedInput = '';
    let registrationAttempts = 0;
    let compensatedConversationId: string | undefined;
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        registerCleanupArtifact: () => {
          registrationAttempts += 1;
          return Promise.reject(new Error('synthetic database failure'));
        },
        cleanupUnregisteredConversation: (conversationId) => {
          compensatedConversationId = conversationId;
          return Promise.resolve();
        },
        spawnProcess: streamingActionProcessFactory(validActionJson, (input) => {
          observedInput = input;
        }),
      }),
    ).rejects.toMatchObject({ code: 'CLEANUP_REGISTRATION_FAILED', disposition: 'failed' });
    expect(registrationAttempts).toBe(2);
    expect(compensatedConversationId).toBe('00000000-0000-4000-8000-000000000001');
    expect(observedInput).toBe('');
  });

  it('recovers a transient durable-registration failure without duplicating the conversation', async () => {
    let registrationAttempts = 0;
    let promptInput = '';
    const output = await runAntigravityTriggerCommand({
      ...defaults,
      registerCleanupArtifact: () => {
        registrationAttempts += 1;
        if (registrationAttempts === 1)
          return Promise.reject(new Error('synthetic transient database failure'));
        return Promise.resolve();
      },
      spawnProcess: streamingActionProcessFactory(validActionJson, (input) => {
        promptInput = input;
      }),
    });

    expect(registrationAttempts).toBe(2);
    expect(JSON.parse(promptInput)).toEqual({
      event: 'user',
      message: { content: 'Hi!' },
    });
    expect(output).toContain('SUCCESS');
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

  it('classifies authentication failure before an init/prompt as a safe pre-dispatch failure', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) =>
          process.complete('', 1, 'Authentication required; sign in first.'),
        ),
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
  });

  it('classifies a non-zero exit after sending the registered prompt as uncertain', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: streamingActionProcessFactory(
          validActionJson,
          undefined,
          undefined,
          7,
          'provider internal diagnostic',
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

  it('classifies stdin failure before the prompt as a safe pre-dispatch failure', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) => {
          process.start();
          queueMicrotask(() => process.stdin.emit('error', new Error('private stdin detail')));
        }),
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
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

  it('classifies an unexpected process error before the prompt as a safe pre-dispatch failure', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: scriptedProcessFactory((process) => {
          process.start();
          queueMicrotask(() => process.emit('error', new Error('synthetic private detail')));
        }),
      }),
    ).rejects.toMatchObject({ code: 'PROCESS_START_FAILED', disposition: 'failed' });
  });

  it('treats timeout after dispatch as uncertain and terminates the child', async () => {
    let processRef: FakeAntigravityProcess | undefined;
    let markPromptSent: (() => void) | undefined;
    const promptSent = new Promise<void>((resolve) => {
      markPromptSent = resolve;
    });
    const pending = runAntigravityTriggerCommand({
      ...defaults,
      timeoutMs: 100,
      spawnProcess: hangingStreamingActionProcessFactory(
        () => markPromptSent?.(),
        undefined,
        (process) => {
          processRef = process;
        },
      ),
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'uncertain',
    });
    await promptSent;
    await rejection;
    expect(processRef?.killSignals).toContain('SIGTERM');
  });

  it('keeps cleanup safe when both termination signals fail after dispatch', async () => {
    vi.useFakeTimers();
    let processRef: FakeAntigravityProcess | undefined;
    let markPromptSent: (() => void) | undefined;
    const promptSent = new Promise<void>((resolve) => {
      markPromptSent = resolve;
    });
    try {
      const pending = runAntigravityTriggerCommand({
        ...defaults,
        timeoutMs: 100,
        spawnProcess: hangingStreamingActionProcessFactory(
          () => markPromptSent?.(),
          undefined,
          (process) => {
            processRef = process;
            process.kill = (signal) => {
              process.killSignals.push(signal);
              throw new Error('synthetic termination failure');
            };
          },
        ),
      });
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'OUTCOME_UNKNOWN',
        disposition: 'uncertain',
      });
      await promptSent;
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      await vi.advanceTimersByTimeAsync(250);
      expect(processRef?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats abort after dispatch as uncertain but abort before spawn as a safe failure', async () => {
    const controller = new AbortController();
    let processRef: FakeAntigravityProcess | undefined;
    let markPromptSent: (() => void) | undefined;
    const promptSent = new Promise<void>((resolve) => {
      markPromptSent = resolve;
    });
    const dispatched = runAntigravityTriggerCommand({
      ...defaults,
      signal: controller.signal,
      spawnProcess: hangingStreamingActionProcessFactory(
        () => markPromptSent?.(),
        undefined,
        (process) => {
          processRef = process;
        },
      ),
    });
    await promptSent;
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

  it('bounds streamed output and stderr without exposing diagnostics', async () => {
    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: streamingActionProcessFactory(
          JSON.stringify({ status: 'SUCCESS', response: 'x'.repeat(128 * 1024 + 1), num_turns: 1 }),
        ),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AntigravityActionTransportError);
      expect(error).toMatchObject({ code: 'STREAM_PROTOCOL_ERROR', disposition: 'uncertain' });
      expect(String(error)).not.toContain('x'.repeat(64));
      return true;
    });

    await expect(
      runAntigravityTriggerCommand({
        ...defaults,
        spawnProcess: streamingActionProcessFactory(
          validActionJson,
          undefined,
          undefined,
          0,
          'x'.repeat(16 * 1024 + 1),
        ),
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'uncertain' });
  });
});
