import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AntigravityProcessFactory,
  AntigravitySpawnOptions,
} from '../../../src/providers/antigravity/transport.js';

export class FakeAntigravityProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  readonly options: AntigravitySpawnOptions;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(options: AntigravitySpawnOptions) {
    super();
    this.options = options;
  }

  start(): void {
    queueMicrotask(() => this.emit('spawn'));
  }

  complete(output: string, exitCode = 0, stderr = ''): void {
    queueMicrotask(() => {
      this.emit('spawn');
      if (output) this.stdout.write(output);
      if (stderr) this.stderr.write(stderr);
      this.stdout.end();
      this.stderr.end();
      this.emit('close', exitCode, null);
    });
  }

  fail(error: NodeJS.ErrnoException): void {
    queueMicrotask(() => this.emit('error', error));
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.killed = true;
    this.signalCode = typeof signal === 'string' ? signal : null;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

export function scriptedProcessFactory(
  script: (process: FakeAntigravityProcess, args: string[]) => void,
  onSpawn?: (process: FakeAntigravityProcess) => void,
): AntigravityProcessFactory {
  return (_executable, args, options) => {
    const process = new FakeAntigravityProcess(options);
    onSpawn?.(process);
    script(process, args);
    return process as unknown as ChildProcessWithoutNullStreams;
  };
}

export function outputProcessFactory(
  output: string,
  onSpawn?: (process: FakeAntigravityProcess) => void,
): AntigravityProcessFactory {
  return scriptedProcessFactory((process) => process.complete(output), onSpawn);
}
