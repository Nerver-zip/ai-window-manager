import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const TERMINATION_GRACE_MS = 250;

export type AntigravityTransportErrorCode =
  | 'AUTH_REQUIRED'
  | 'KEYRING_LOCKED'
  | 'SECRET_SERVICE_UNAVAILABLE'
  | 'DBUS_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_OUTPUT_INVALID'
  | 'EXECUTABLE_UNAVAILABLE';

export class AntigravityTransportError extends Error {
  constructor(readonly code: AntigravityTransportErrorCode) {
    super(`Antigravity provider ${code.toLowerCase().replaceAll('_', ' ')}`);
    this.name = 'AntigravityTransportError';
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
