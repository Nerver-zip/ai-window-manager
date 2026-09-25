import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ProviderCleanupArtifact } from '../provider.js';

const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_ACTION_STDOUT_BYTES = 128 * 1024;
const MAX_ACTION_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 250;
export const ANTIGRAVITY_TRIGGER_MESSAGE = 'Hi!';

export type AntigravityTransportErrorCode =
  | 'AUTH_REQUIRED'
  | 'KEYRING_LOCKED'
  | 'SECRET_SERVICE_UNAVAILABLE'
  | 'DBUS_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_OUTPUT_INVALID'
  | 'EXECUTABLE_UNAVAILABLE';

export type AntigravityActionFailureDisposition = 'failed' | 'uncertain';
export type AntigravityActionTransportErrorCode =
  | 'PROCESS_START_FAILED'
  | 'CLEANUP_REGISTRATION_FAILED'
  | 'STREAM_PROTOCOL_ERROR'
  | 'OUTCOME_UNKNOWN';

export class AntigravityTransportError extends Error {
  constructor(readonly code: AntigravityTransportErrorCode) {
    super(`Antigravity provider ${code.toLowerCase().replaceAll('_', ' ')}`);
    this.name = 'AntigravityTransportError';
  }
}

export class AntigravityActionTransportError extends Error {
  constructor(
    readonly code: AntigravityActionTransportErrorCode,
    readonly disposition: AntigravityActionFailureDisposition,
  ) {
    super(`Antigravity action ${code.toLowerCase().replaceAll('_', ' ')}`);
    this.name = 'AntigravityActionTransportError';
  }
}

export type AntigravitySpawnOptions = SpawnOptions & {
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
};

export type AntigravityProcessFactory = (
  executable: string,
  args: string[],
  options: AntigravitySpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface AntigravityUsageCommandOptions {
  executable: string;
  printTimeoutSeconds: number;
  timeoutMs: number;
  cwd?: string;
  spawnProcess?: AntigravityProcessFactory;
  signal?: AbortSignal;
}

export interface AntigravityTriggerCommandOptions {
  executable: string;
  model: string;
  timeoutMs: number;
  registerCleanupArtifact: (artifact: ProviderCleanupArtifact) => Promise<void>;
  cleanupUnregisteredConversation: (conversationId: string) => Promise<void>;
  spawnProcess?: AntigravityProcessFactory;
  signal?: AbortSignal;
}

function defaultSpawn(
  executable: string,
  args: string[],
  options: AntigravitySpawnOptions,
): ChildProcessWithoutNullStreams {
  return spawn(executable, args, options);
}

function antigravityProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = [
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
  ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function hasAuthenticationMarker(value: string): boolean {
  return /authentication required|auth required|unauthenticated|not authenticated|login required|sign[ -]?in required|please log in/i.test(
    value,
  );
}

function classifyProcessFailure(value: string): AntigravityTransportErrorCode {
  if (/keyring.{0,40}locked|locked.{0,40}keyring/i.test(value)) return 'KEYRING_LOCKED';
  if (
    /secret.?service.{0,60}(unavailable|not available|failed|not found)|(?:unavailable|not available|failed).{0,60}secret.?service/i.test(
      value,
    )
  ) {
    return 'SECRET_SERVICE_UNAVAILABLE';
  }
  if (
    /(?:dbus|d-bus).{0,80}(unavailable|not available|failed|cannot connect|connection refused)|(?:failed|unable).{0,80}(?:dbus|d-bus)/i.test(
      value,
    )
  ) {
    return 'DBUS_UNAVAILABLE';
  }
  return hasAuthenticationMarker(value) ? 'AUTH_REQUIRED' : 'PROVIDER_UNAVAILABLE';
}

function killProcess(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill('SIGTERM');
  } catch {
    // The process may have exited between the timeout and cleanup.
  }
  const killTimer = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch {
      // Cleanup is best effort and never changes the safe classification.
    }
  }, TERMINATION_GRACE_MS);
  killTimer.unref();
}

function actionFailure(
  code: AntigravityActionTransportErrorCode,
  disposition: AntigravityActionFailureDisposition,
): AntigravityActionTransportError {
  return new AntigravityActionTransportError(code, disposition);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConversationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Create an official CLI stream, persist its conversation ID on the init event,
 * and only then send the fixed quota-consuming prompt through stdin. Step text
 * is discarded and the final response remains transient in process memory.
 */
export async function runAntigravityTriggerCommand(
  options: AntigravityTriggerCommandOptions,
): Promise<string> {
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_ACTION_TIMEOUT_MS
  ) {
    throw actionFailure('PROCESS_START_FAILED', 'failed');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(options.model)) {
    throw actionFailure('PROCESS_START_FAILED', 'failed');
  }
  if (typeof options.registerCleanupArtifact !== 'function') {
    throw actionFailure('CLEANUP_REGISTRATION_FAILED', 'failed');
  }
  if (typeof options.cleanupUnregisteredConversation !== 'function') {
    throw actionFailure('CLEANUP_REGISTRATION_FAILED', 'failed');
  }
  if (options.signal?.aborted) throw actionFailure('PROCESS_START_FAILED', 'failed');

  let workspace: string;
  try {
    workspace = await mkdtemp(join(tmpdir(), 'awm-agy-trigger-'));
  } catch {
    throw actionFailure('PROCESS_START_FAILED', 'failed');
  }

  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--model',
    options.model,
    '--print-timeout',
    `${Math.ceil(options.timeoutMs / 1000)}s`,
    '--sandbox',
  ];

  try {
    return await new Promise<string>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnProcess(options.executable, args, {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: antigravityProcessEnvironment(process.env),
          cwd: workspace,
        });
      } catch {
        reject(actionFailure('PROCESS_START_FAILED', 'failed'));
        return;
      }

      let settled = false;
      let spawned = false;
      let promptSent = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let lineBuffer = '';
      let conversationId: string | undefined;
      let resultJson: string | undefined;
      let streamFailure: AntigravityActionTransportError | undefined;
      let processing = Promise.resolve();
      const decoder = new StringDecoder('utf8');
      const timeout = setTimeout(() => {
        terminate();
        finish(failureForDispatch(promptSent));
      }, options.timeoutMs);
      timeout.unref();
      let abortListener: (() => void) | undefined;

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (abortListener && options.signal)
          options.signal.removeEventListener('abort', abortListener);
      };

      const finish = (error?: AntigravityActionTransportError, value?: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value ?? '');
      };

      const terminate = (): void => {
        killProcess(child);
      };

      const failStream = (error: AntigravityActionTransportError): void => {
        if (settled) return;
        streamFailure = error;
        terminate();
        finish(error);
      };

      const processLine = async (line: string): Promise<void> => {
        if (settled || line.trim().length === 0) return;
        let event: unknown;
        try {
          event = JSON.parse(line) as unknown;
        } catch {
          failStream(failureForDispatch(promptSent, 'STREAM_PROTOCOL_ERROR'));
          return;
        }
        if (!isRecord(event) || typeof event.event !== 'string') {
          failStream(failureForDispatch(promptSent, 'STREAM_PROTOCOL_ERROR'));
          return;
        }

        if (event.event === 'init') {
          if (conversationId !== undefined || !isConversationId(event.conversation_id)) {
            failStream(failureForDispatch(promptSent, 'STREAM_PROTOCOL_ERROR'));
            return;
          }
          const artifact: ProviderCleanupArtifact = {
            kind: 'antigravity_conversation',
            externalId: event.conversation_id,
          };
          try {
            try {
              await options.registerCleanupArtifact(artifact);
            } catch {
              // createIfAbsent is idempotent, so retry one transient failure and
              // a lost acknowledgement before giving up on the cleanup obligation.
              await options.registerCleanupArtifact(artifact);
            }
          } catch {
            try {
              await options.cleanupUnregisteredConversation(event.conversation_id);
            } catch {
              // Never dispatch if both durable registration and exact-ID cleanup fail.
            }
            failStream(actionFailure('CLEANUP_REGISTRATION_FAILED', 'failed'));
            return;
          }
          if (settled || options.signal?.aborted) return;
          conversationId = event.conversation_id;
          promptSent = true;
          try {
            child.stdin.write(
              `${JSON.stringify({
                event: 'user',
                message: { content: ANTIGRAVITY_TRIGGER_MESSAGE },
              })}\n`,
            );
            child.stdin.end();
          } catch {
            failStream(failureForDispatch(promptSent));
          }
          return;
        }

        if (event.event === 'result') {
          if (
            !conversationId ||
            resultJson !== undefined ||
            !isRecord(event.result) ||
            event.result.conversation_id !== conversationId
          ) {
            failStream(failureForDispatch(promptSent, 'STREAM_PROTOCOL_ERROR'));
            return;
          }
          resultJson = JSON.stringify(event.result);
        }
        // step_update text and future additive event types are deliberately discarded.
      };

      const enqueueLines = (text: string): void => {
        lineBuffer += text;
        if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_ACTION_STDOUT_BYTES) {
          failStream(failureForDispatch(promptSent, 'STREAM_PROTOCOL_ERROR'));
          return;
        }
        let newline = lineBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
          lineBuffer = lineBuffer.slice(newline + 1);
          processing = processing.then(() => processLine(line));
          newline = lineBuffer.indexOf('\n');
        }
      };

      child.once('spawn', () => {
        spawned = true;
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        stdoutBytes += Buffer.byteLength(text, 'utf8');
        if (stdoutBytes > MAX_ACTION_STDOUT_BYTES) {
          failStream(failureForDispatch(promptSent, 'STREAM_PROTOCOL_ERROR'));
          return;
        }
        enqueueLines(text);
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        stderrBytes += Buffer.byteLength(text, 'utf8');
        if (stderrBytes > MAX_STDERR_BYTES) {
          failStream(failureForDispatch(promptSent));
        }
      });

      child.once('error', () => {
        if (settled) return;
        finish(failureForDispatch(promptSent));
      });

      child.stdin.once('error', () => {
        if (settled) return;
        finish(failureForDispatch(promptSent));
      });

      child.once('close', (exitCode: number | null) => {
        if (settled) return;
        lineBuffer += decoder.end();
        const trailing = lineBuffer.replace(/\r$/, '');
        lineBuffer = '';
        if (trailing.trim().length > 0) processing = processing.then(() => processLine(trailing));
        void processing.then(() => {
          if (settled) return;
          if (streamFailure) {
            finish(streamFailure);
          } else if (!spawned || !promptSent) {
            finish(actionFailure('PROCESS_START_FAILED', 'failed'));
          } else if (exitCode !== 0 || !resultJson) {
            finish(actionFailure('OUTCOME_UNKNOWN', 'uncertain'));
          } else {
            finish(undefined, resultJson);
          }
        });
      });

      if (options.signal) {
        abortListener = () => {
          terminate();
          finish(failureForDispatch(promptSent));
        };
        if (options.signal.aborted) abortListener();
        else options.signal.addEventListener('abort', abortListener, { once: true });
      }
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function failureForDispatch(
  promptSent: boolean,
  preDispatchCode: 'PROCESS_START_FAILED' | 'STREAM_PROTOCOL_ERROR' = 'PROCESS_START_FAILED',
): AntigravityActionTransportError {
  if (promptSent) {
    return actionFailure(
      preDispatchCode === 'STREAM_PROTOCOL_ERROR' ? 'STREAM_PROTOCOL_ERROR' : 'OUTCOME_UNKNOWN',
      'uncertain',
    );
  }
  if (preDispatchCode === 'STREAM_PROTOCOL_ERROR') {
    return actionFailure('STREAM_PROTOCOL_ERROR', 'failed');
  }
  return actionFailure('PROCESS_START_FAILED', 'failed');
}

export async function runAntigravityUsageCommand(
  options: AntigravityUsageCommandOptions,
): Promise<string> {
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const args = [
    '-p',
    '/usage',
    '--output-format',
    'json',
    '--print-timeout',
    `${options.printTimeoutSeconds}s`,
  ];

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(options.executable, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: antigravityProcessEnvironment(process.env),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch {
      reject(new AntigravityTransportError('PROVIDER_UNAVAILABLE'));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      terminate();
      finish(new AntigravityTransportError('PROVIDER_TIMEOUT'));
    }, options.timeoutMs);
    timeout.unref();
    let abortListener: (() => void) | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (abortListener && options.signal)
        options.signal.removeEventListener('abort', abortListener);
    };

    const finish = (error?: AntigravityTransportError, value?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value ?? '');
    };

    const terminate = (): void => {
      killProcess(child);
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stdoutBytes += Buffer.byteLength(text, 'utf8');
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate();
        finish(new AntigravityTransportError('PROVIDER_OUTPUT_INVALID'));
        return;
      }
      stdout += text;
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrBytes += Buffer.byteLength(text, 'utf8');
      if (stderrBytes > MAX_STDERR_BYTES) {
        terminate();
        finish(new AntigravityTransportError('PROVIDER_OUTPUT_INVALID'));
        return;
      }
      stderr += text;
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      finish(
        new AntigravityTransportError(
          error.code === 'ENOENT' ? 'EXECUTABLE_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE',
        ),
      );
    });

    child.once('close', (exitCode: number | null) => {
      if (settled) return;
      if (exitCode !== 0) {
        finish(new AntigravityTransportError(classifyProcessFailure(`${stdout}\n${stderr}`)));
        return;
      }
      finish(undefined, stdout);
    });

    if (options.signal) {
      abortListener = () => {
        terminate();
        finish(new AntigravityTransportError('PROVIDER_UNAVAILABLE'));
      };
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener('abort', abortListener, { once: true });
    }

    child.stdin.end();
  });
}
