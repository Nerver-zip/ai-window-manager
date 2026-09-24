import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import * as pty from 'node-pty';
import type { AuthManagedProcess, AuthOutputStream } from './session-manager.js';

export interface AuthProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive?: boolean;
}

export type AuthProcessFactory = (
  executable: string,
  args: string[],
  options: AuthProcessOptions,
) => AuthManagedProcess;

export type AuthCommandRunner = (
  executable: string,
  args: string[],
  options: AuthProcessOptions,
  signal: AbortSignal,
) => Promise<{ code: number | null; output: string; overflow: boolean }>;

export interface CaptureAuthCommandRuntime {
  spawnProcess?: (
    executable: string,
    args: string[],
    options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] },
  ) => ChildProcessWithoutNullStreams;
  maxOutputBytes?: number;
  timeoutMs?: number;
  killGraceMs?: number;
  stopDeadlineMs?: number;
}

class ChildAuthProcess implements AuthManagedProcess {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  onOutput(listener: (stream: AuthOutputStream, chunk: string | Buffer) => void): () => void {
    const stdout = (chunk: Buffer | string): void => listener('stdout', chunk);
    const stderr = (chunk: Buffer | string): void => listener('stderr', chunk);
    this.child.stdout.on('data', stdout);
    this.child.stderr.on('data', stderr);
    return () => {
      this.child.stdout.off('data', stdout);
      this.child.stderr.off('data', stderr);
    };
  }

  onExit(listener: (code: number | null, signal: string | null) => void): () => void {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      listener(code, signal);
    };
    const close = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(code, signal);
    const error = (): void => finish(null, null);
    this.child.once('close', close);
    this.child.once('error', error);
    return () => {
      this.child.off('close', close);
      this.child.off('error', error);
    };
  }

  writeInput(value: string): void {
    this.child.stdin.write(value, 'utf8');
  }

  signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (exited: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.child.off('close', onClose);
        resolve(exited);
      };
      const onClose = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.child.once('close', onClose);
    });
  }
}

const MAX_BUFFERED_PTY_OUTPUT_BYTES = 2 * 1024 * 1024;

export class PtyAuthProcess implements AuthManagedProcess {
  private exited = false;
  private exitCode: number | null = null;
  private outputListener: ((stream: AuthOutputStream, chunk: string | Buffer) => void) | undefined;
  private bufferedOutput: string[] = [];
  private bufferedOutputBytes = 0;
  private outputOverflow = false;
  private readonly outputSubscription: pty.IDisposable;

  constructor(private readonly child: pty.IPty) {
    this.outputSubscription = child.onData((chunk) => {
      if (this.outputListener) {
        this.outputListener('stdout', chunk);
        return;
      }
      if (this.outputOverflow) return;

      const chunkBytes = Buffer.byteLength(chunk);
      if (this.bufferedOutputBytes + chunkBytes > MAX_BUFFERED_PTY_OUTPUT_BYTES) {
        this.bufferedOutput = [];
        this.bufferedOutputBytes = 0;
        this.outputOverflow = true;
        return;
      }
      this.bufferedOutput.push(chunk);
      this.bufferedOutputBytes += chunkBytes;
    });
    child.onExit((event) => {
      this.exited = true;
      this.exitCode = event.exitCode;
      this.outputSubscription.dispose();
    });
  }

  onOutput(listener: (stream: AuthOutputStream, chunk: string | Buffer) => void): () => void {
    this.outputListener = listener;
    for (const chunk of this.bufferedOutput) listener('stdout', chunk);
    this.bufferedOutput = [];
    this.bufferedOutputBytes = 0;
    if (this.outputOverflow) {
      this.outputOverflow = false;
      listener('stdout', Buffer.alloc(MAX_BUFFERED_PTY_OUTPUT_BYTES + 1));
    }
    return () => {
      if (this.outputListener !== listener) return;
      this.outputListener = undefined;
      this.outputSubscription.dispose();
      this.bufferedOutput = [];
      this.bufferedOutputBytes = 0;
    };
  }

  onExit(listener: (code: number | null, signal: string | null) => void): () => void {
    if (this.exited) {
      queueMicrotask(() => listener(this.exitCode, null));
      return () => {};
    }
    const subscription = this.child.onExit((event) => listener(event.exitCode, null));
    return () => subscription.dispose();
  }

  writeInput(value: string): void {
    this.child.write(value);
  }

  signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!this.exited) this.child.kill(signal);
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (exited: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        subscription.dispose();
        resolve(exited);
      };
      const subscription = this.child.onExit(() => finish(true));
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }
}

export const spawnAuthProcess: AuthProcessFactory = (executable, args, options) => {
  if (options.interactive) {
    const env = Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const child = pty.spawn(executable, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 32,
      cwd: options.cwd,
      env,
      useConpty: false,
    });
    return new PtyAuthProcess(child);
  }
  const spawnOptions: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] } = {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  };
  const child = spawn(executable, args, spawnOptions);
  return new ChildAuthProcess(child);
};

export const captureAuthCommand: AuthCommandRunner = (executable, args, options, signal) =>
  captureAuthCommandWithRuntime(executable, args, options, signal);

export async function captureAuthCommandWithRuntime(
  executable: string,
  args: string[],
  options: AuthProcessOptions,
  signal: AbortSignal,
  runtime: CaptureAuthCommandRuntime = {},
): Promise<{ code: number | null; output: string; overflow: boolean }> {
  if (signal.aborted) return { code: null, output: '', overflow: false };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (runtime.spawnProcess ?? spawn)(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    child.stdin.end();
  } catch {
    return { code: null, output: '', overflow: false };
  }

  const maxOutputBytes = runtime.maxOutputBytes ?? 16 * 1024;
  let output = '';
  let outputBytes = 0;
  let overflow = false;
  let stopping = false;
  let hardKillTimer: NodeJS.Timeout | undefined;
  let stopDeadline: NodeJS.Timeout | undefined;
  let stopChild: () => void = () => {};
  const onData = (chunk: Buffer | string): void => {
    const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    outputBytes += Buffer.byteLength(value);
    if (outputBytes > maxOutputBytes) {
      overflow = true;
      stopChild();
      return;
    }
    output += value;
  };
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (stopDeadline) clearTimeout(stopDeadline);
      signal.removeEventListener('abort', abort);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      resolve({ code, output, overflow });
    };
    stopChild = (): void => {
      if (stopping) return;
      stopping = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      hardKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, runtime.killGraceMs ?? 500);
      stopDeadline = setTimeout(() => finish(null), runtime.stopDeadlineMs ?? 1_500);
    };
    const abort = (): void => {
      stopChild();
    };
    const timer = setTimeout(() => {
      stopChild();
    }, runtime.timeoutMs ?? 5_000);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
  });
}

export function providerProcessEnvironment(input: {
  home: string;
  includeDbus?: boolean;
  includeSsh?: boolean;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: input.home };
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (input.includeDbus) {
    for (const name of [
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_RUNTIME_DIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
    ]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
  }
  if (input.includeSsh) {
    // Agy's documented remote flow reads the normal SSH environment variables.
    env.SSH_CONNECTION = '127.0.0.1 1 127.0.0.1 1';
    env.SSH_CLIENT = '127.0.0.1 1 127.0.0.1';
    env.SSH_TTY = '/dev/pts/0';
  }
  return env;
}
