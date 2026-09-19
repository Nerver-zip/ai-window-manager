import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import type { CodexProcessFactory } from '../../../src/providers/codex/transport.js';

export interface FakeCodexProcessMessage {
  id?: number;
  method?: string;
  params?: unknown;
}

export type FakeCodexMessageHandler = (
  message: FakeCodexProcessMessage,
  process: FakeCodexProcess,
) => void;

export class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  exitCode: number | null = null;
  killed = false;
  readonly options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] };

  constructor(
    private readonly handler: FakeCodexMessageHandler,
    options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] },
  ) {
    super();
    this.options = options;
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          handler(JSON.parse(line) as FakeCodexProcessMessage, this);
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
  }

  send(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.killed = true;
    this.exitCode = signal === 'SIGKILL' ? 137 : 0;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', this.exitCode, signal);
    return true;
  }
}

export function fakeProcessFactory(
  handler: FakeCodexMessageHandler,
  onCreated?: (process: FakeCodexProcess) => void,
): CodexProcessFactory {
  return (_executable, _args, options) => {
    const process = new FakeCodexProcess(handler, options);
    onCreated?.(process);
    return process as unknown as ChildProcessWithoutNullStreams;
  };
}

export function respondToHandshake(
  response: unknown,
  onMessage?: (message: FakeCodexProcessMessage) => void,
): FakeCodexMessageHandler {
  return (message, process) => {
    onMessage?.(message);
    if (message.method === 'initialize' && message.id !== undefined) {
      process.send({ id: message.id, result: { serverInfo: { name: 'codex' } } });
      return;
    }
    if (message.method === 'account/rateLimits/read' && message.id !== undefined) {
      process.send({ id: message.id, result: response });
    }
  };
}
