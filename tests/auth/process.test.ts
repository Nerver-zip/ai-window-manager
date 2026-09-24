import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  captureAuthCommandWithRuntime,
  providerProcessEnvironment,
} from '../../src/auth/process.js';

afterEach(() => vi.unstubAllEnvs());

class StubChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exitOnTerm = false;
  exitOnKill = false;

  kill(signal?: NodeJS.Signals): boolean {
    if (!signal) return false;
    this.signals.push(signal);
    if ((signal === 'SIGTERM' && this.exitOnTerm) || (signal === 'SIGKILL' && this.exitOnKill)) {
      this.close(null, signal);
    }
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

function fakeChild(): StubChild {
  return new StubChild();
}

describe('provider auth process helpers', () => {
  it('keeps provider process environments minimal and scopes optional integration variables', () => {
    vi.stubEnv('PATH', '/usr/bin');
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/tmp/synthetic-dbus');
    vi.stubEnv('XDG_RUNTIME_DIR', '/tmp/synthetic-runtime');
    vi.stubEnv('XDG_CONFIG_HOME', '/state/agy/config');
    const base = providerProcessEnvironment({ home: '/state/provider' });
    const agy = providerProcessEnvironment({
      home: '/state/agy',
      includeDbus: true,
      includeSsh: true,
    });

    expect(base).toMatchObject({ HOME: '/state/provider', PATH: '/usr/bin' });
    expect(
      Object.keys(base).every((key) =>
        ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'].includes(key),
      ),
    ).toBe(true);
    expect(agy).toMatchObject({
      HOME: '/state/agy',
      PATH: '/usr/bin',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/synthetic-dbus',
      XDG_RUNTIME_DIR: '/tmp/synthetic-runtime',
      XDG_CONFIG_HOME: '/state/agy/config',
    });
    expect(typeof agy.SSH_CONNECTION).toBe('string');
    expect(typeof agy.SSH_CLIENT).toBe('string');
    expect(typeof agy.SSH_TTY).toBe('string');
    expect(Object.keys(base)).not.toContain('OPENAI_API_KEY');
  });

  it('captures bounded output from a successful official-client status command', async () => {
    const result = await captureAuthCommandWithRuntime(
      process.execPath,
      ['-e', 'process.stdout.write("synthetic status")'],
      { cwd: '/tmp', env: process.env },
      new AbortController().signal,
    );

    expect(result).toEqual({ code: 0, output: 'synthetic status', overflow: false });
  });

  it('fails closed when auth output exceeds its bounded capture size', async () => {
    const result = await captureAuthCommandWithRuntime(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(1024))'],
      { cwd: '/tmp', env: process.env },
      new AbortController().signal,
      { maxOutputBytes: 32, killGraceMs: 10, stopDeadlineMs: 200 },
    );

    expect(result.overflow).toBe(true);
  });

  it('terminates a timed-out auth status process and escalates cleanup', async () => {
    const result = await captureAuthCommandWithRuntime(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { cwd: '/tmp', env: process.env },
      new AbortController().signal,
      { timeoutMs: 30, killGraceMs: 20, stopDeadlineMs: 250 },
    );

    expect(result.code).toBeNull();
  });

  it('returns an empty unavailable result if cancellation precedes spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await captureAuthCommandWithRuntime(
      process.execPath,
      ['-e', 'process.exit(0)'],
      { cwd: '/tmp', env: process.env },
      controller.signal,
    );

    expect(result).toEqual({ code: null, output: '', overflow: false });
  });

  it('fails closed if spawning the official status process throws', async () => {
    const result = await captureAuthCommandWithRuntime(
      'synthetic-executable',
      [],
      { cwd: '/tmp', env: {} },
      new AbortController().signal,
      {
        spawnProcess: () => {
          throw new Error('private spawn detail');
        },
      },
    );
    expect(result).toEqual({ code: null, output: '', overflow: false });
  });

  it('captures both text and Buffer chunks and ignores a second completion event', async () => {
    const child = fakeChild();
    const resultPromise = captureAuthCommandWithRuntime(
      'synthetic-executable',
      [],
      { cwd: '/tmp', env: {} },
      new AbortController().signal,
      { spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams },
    );
    child.stdout.write(Buffer.from('first'));
    child.stderr.write(' second');
    child.close(0);
    child.emit('error', new Error('late child event'));

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      output: 'first second',
      overflow: false,
    });
  });

  it('sends SIGTERM then SIGKILL on output overflow and bounds the stop wait', async () => {
    const child = fakeChild();
    child.exitOnKill = true;
    const resultPromise = captureAuthCommandWithRuntime(
      'synthetic-executable',
      [],
      { cwd: '/tmp', env: {} },
      new AbortController().signal,
      {
        maxOutputBytes: 1,
        killGraceMs: 0,
        stopDeadlineMs: 100,
        spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      },
    );
    child.stdout.write(Buffer.from('too much'));

    const result = await resultPromise;
    expect(result.overflow).toBe(true);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('returns at the stop deadline if a status child ignores both termination signals', async () => {
    const child = fakeChild();
    const resultPromise = captureAuthCommandWithRuntime(
      'synthetic-executable',
      [],
      { cwd: '/tmp', env: {} },
      new AbortController().signal,
      {
        maxOutputBytes: 1,
        killGraceMs: 0,
        stopDeadlineMs: 10,
        spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      },
    );
    child.stdout.write(Buffer.from('too much'));
    const result = await resultPromise;
    child.close(null, 'SIGKILL');

    expect(result).toMatchObject({ code: null, overflow: true });
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops a spawned status command after its abort signal', async () => {
    const child = fakeChild();
    child.exitOnTerm = true;
    const controller = new AbortController();
    const resultPromise = captureAuthCommandWithRuntime(
      'synthetic-executable',
      [],
      { cwd: '/tmp', env: {} },
      controller.signal,
      { spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams },
    );
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({ code: null, overflow: false });
    expect(child.signals).toEqual(['SIGTERM']);
  });
});
