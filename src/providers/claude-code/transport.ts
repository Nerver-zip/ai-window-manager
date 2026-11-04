import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const TERMINATION_GRACE_MS = 1_000;
const MAX_STDERR_DRAIN_BYTES = 64 * 1024;

export type ClaudeSpawnOptions = SpawnOptions & {
  shell: false;
  stdio: ['ignore', 'pipe', 'pipe'];
};

export type ClaudeProcessFactory = (
  executable: string,
  args: string[],
  options: ClaudeSpawnOptions,
) => ChildProcess;

export interface ClaudeCliRunOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxLineBytes?: number;
  signal?: AbortSignal;
  spawnProcess?: ClaudeProcessFactory;
  /** Receives complete stdout lines. Returning `stop` terminates the process. */
  onLine?: (line: string) => 'continue' | 'stop';
  /** Keep the (bounded) raw stdout for small JSON commands such as `auth status`. */
  collectStdout?: boolean;
}

export interface ClaudeCliRunResult {
  started: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  overflow: boolean;
  stopped: boolean;
  stdout: string;
}

/**
 * Minimal environment for every official Claude Code invocation. Provider
 * credentials and API keys from the daemon environment are never inherited;
 * the dedicated configuration directory is both HOME and CLAUDE_CONFIG_DIR so
 * the CLI cannot touch another profile. Claude Code's own updater is disabled
 * because AWM manages the pinned executable.
 */
export function claudeProcessEnvironment(
  configDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: configDirectory,
    CLAUDE_CONFIG_DIR: configDirectory,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  };
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Run one bounded official-client process; stdout is parsed line by line. */
export function runClaudeCli(options: ClaudeCliRunOptions): Promise<ClaudeCliRunResult> {
  const maxLineBytes = options.maxLineBytes ?? options.maxStdoutBytes;
  return new Promise((resolve) => {
    const result: ClaudeCliRunResult = {
      started: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      overflow: false,
      stopped: false,
      stdout: '',
    };
    if (options.signal?.aborted) {
      resolve({ ...result, aborted: true });
      return;
    }

    let child: ChildProcess;
    try {
      child = (options.spawnProcess ?? spawn)(options.executable, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(result);
      return;
    }

    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const collected: string[] = [];

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, TERMINATION_GRACE_MS);
      killTimer.unref?.();
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (!result.overflow && !result.stopped) {
        const tail = pending + decoder.end();
        if (tail.trim().length > 0) handleLine(tail);
      }
      resolve({
        ...result,
        exitCode,
        signal,
        stdout: options.collectStdout ? collected.join('') : '',
      });
    };

    const handleLine = (line: string): void => {
      if (result.stopped || result.overflow) return;
      if (Buffer.byteLength(line) > maxLineBytes) {
        result.overflow = true;
        terminate();
        return;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0 || !options.onLine) return;
      let decision: 'continue' | 'stop';
      try {
        decision = options.onLine(trimmed);
      } catch {
        decision = 'stop';
      }
      if (decision === 'stop') {
        result.stopped = true;
        terminate();
      }
    };

    const onAbort = (): void => {
      result.aborted = true;
      terminate();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      result.timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref?.();

    child.once('spawn', () => {
      result.started = true;
    });
    child.once('error', () => {
      finish(null, null);
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      result.started = true;
      finish(code, signal);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      // Drain and discard: stderr may echo prompts, paths or provider text.
      stderrBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (stderrBytes > MAX_STDERR_DRAIN_BYTES * 16) terminate();
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (result.overflow || result.stopped) return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > options.maxStdoutBytes) {
        result.overflow = true;
        terminate();
        return;
      }
      const text = decoder.write(bytes);
      if (options.collectStdout) collected.push(text);
      pending += text;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        handleLine(line);
        if (result.overflow || result.stopped) return;
        newline = pending.indexOf('\n');
      }
      if (Buffer.byteLength(pending) > maxLineBytes) {
        result.overflow = true;
        terminate();
      }
    });
  });
}
