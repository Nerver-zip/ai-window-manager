import { describe, expect, it } from 'vitest';
import {
  CodexAppServerClient,
  CodexTransportError,
} from '../../../src/providers/codex/transport.js';
import { fakeProcessFactory } from './support.js';
import type { FakeCodexProcess } from './support.js';

const clientOptions = {
  executable: 'codex-test-double',
  codexHome: '/tmp/awm-codex-test-home',
  requestTimeoutMs: 100,
};

describe('Codex app-server JSONL transport', () => {
  it('performs initialize, initialized, rate-limit read, and cleanup', async () => {
    const methods: Array<string | undefined> = [];
    const requestIds: Array<number | undefined> = [];
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory(
        (message, process) => {
          methods.push(message.method);
          requestIds.push(message.id);
          if (message.method === 'initialize' && message.id !== undefined) {
            process.send({ id: message.id, result: { serverInfo: { name: 'codex' } } });
          }
          if (message.method === 'account/rateLimits/read' && message.id !== undefined) {
            process.stderr.write('diagnostic '.repeat(2_000));
            process.stderr.write('diagnostic '.repeat(2_000));
            process.stderr.write('diagnostic');
            process.send({ id: message.id, result: { rateLimits: { primary: null } } });
          }
        },
        (created) => {
          child = created;
        },
      ),
    });

    await expect(client.readRateLimits()).resolves.toEqual({ rateLimits: { primary: null } });
    expect(methods).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
    expect(requestIds).toEqual([1, undefined, 2]);
    expect(child?.options.env?.CODEX_HOME).toBe('/tmp/awm-codex-test-home');
    expect(child?.options.env?.HOME).toBe('/tmp/awm-codex-test-home');
    expect(child?.options.env?.OPENAI_API_KEY).toBeUndefined();
    expect(child?.killSignals).toEqual(['SIGTERM']);
  });

  it('handles blank lines, CRLF framing, split string chunks, and notifications', async () => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize' && message.id !== undefined) {
          process.stdout.emit('data', '\n');
          process.stdout.emit('data', `{"id":${message.id},"result":{}}\r\n`);
        }
        if (message.method === 'account/rateLimits/read' && message.id !== undefined) {
          process.stdout.emit('data', '{"method":"account/rateLimits/updated"}\n');
          process.stdout.emit(
            'data',
            `{"id":${message.id},"result":{"rateLimits":{"primary":null}}}\r\n`,
          );
        }
      }),
    });

    await expect(client.readRateLimits()).resolves.toEqual({ rateLimits: { primary: null } });
  });

  it('classifies an authentication protocol error without exposing its message', async () => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize' && message.id !== undefined) {
          process.send({ id: message.id, result: {} });
        }
        if (message.method === 'account/rateLimits/read' && message.id !== undefined) {
          process.send({
            id: message.id,
            error: { code: 'AUTH_REQUIRED', message: 'private provider details must not escape' },
          });
        }
      }),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: 'Codex app-server auth required',
    });
  });

  it.each([
    ['non-object error', { id: 2, error: 'bad error' }],
    ['unknown numeric error', { id: 2, error: { code: 1234 } }],
  ] as const)('classifies %s as a protocol error', async (_name, response) => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize' && message.id !== undefined) {
          process.send({ id: message.id, result: {} });
        }
        if (message.method === 'account/rateLimits/read') process.send(response);
      }),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it.each([
    ['array', []],
    ['string id', { id: '2', result: {} }],
    ['unknown id', { id: 99, result: {} }],
    ['missing result', { id: 2 }],
  ] as const)('fails closed for %s response framing', async (_name, response) => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize' && message.id !== undefined) {
          process.send({ id: message.id, result: {} });
        }
        if (message.method === 'account/rateLimits/read') process.send(response);
      }),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('uses the real spawn boundary without requiring a Codex binary', async () => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      executable: '/definitely/not/a/codex/binary',
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'PROCESS_ERROR' });
  });

  it('maps stdin write failures to a process error', async () => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory(
        () => undefined,
        (created) => {
          created.stdin.write = (() => {
            throw new Error('stdin failed');
          }) as typeof created.stdin.write;
        },
      ),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'PROCESS_ERROR' });
  });

  it('maps initialized notification write failures to a process error', async () => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize' && message.id !== undefined) {
          process.send({ id: message.id, result: {} });
          process.stdin.write = (() => {
            throw new Error('notification write failed');
          }) as typeof process.stdin.write;
        }
      }),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'PROCESS_ERROR' });
  });

  it('fails closed on malformed JSON and cleans up the child', async () => {
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory(
        (message, process) => {
          if (message.method === 'initialize' && message.id !== undefined) {
            process.stdout.write('{malformed-json\n');
          }
        },
        (created) => {
          child = created;
        },
      ),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(child?.killSignals).toContain('SIGTERM');
  });

  it('fails closed when one JSONL record exceeds the bounded line size', async () => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize') process.stdout.write('x'.repeat(256 * 1024 + 1));
      }),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('returns timeout when the expected response does not arrive', async () => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      requestTimeoutMs: 10,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize' && message.id !== undefined) {
          process.send({ id: message.id, result: {} });
        }
      }),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('classifies stdout EOF while waiting for a response', async () => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize' && message.id !== undefined) {
          process.send({ id: message.id, result: {} });
        }
        if (message.method === 'account/rateLimits/read') process.stdout.end();
      }),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'EOF' });
  });

  it('maps a stdout stream error to a process error', async () => {
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize')
          process.stdout.emit('error', new Error('stream failed'));
      }),
    });

    await expect(client.readRateLimits()).rejects.toMatchObject({ code: 'PROCESS_ERROR' });
  });

  it('rejects an aborted request and exposes no trigger/action surface', async () => {
    const controller = new AbortController();
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory((message, process) => {
        if (message.method === 'initialize' && message.id !== undefined) {
          process.send({ id: message.id, result: {} });
          controller.abort();
        }
      }),
    });

    await expect(client.readRateLimits(controller.signal)).rejects.toBeInstanceOf(
      CodexTransportError,
    );
  });

  it('rejects a request that starts with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory(() => undefined),
    });

    await expect(client.readRateLimits(controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it('allows closing a client that has not started a process', async () => {
    await expect(new CodexAppServerClient({ ...clientOptions }).close()).resolves.toBeUndefined();
  });

  it('does not send a second termination signal for an already-killed child', async () => {
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory(
        (message, process) => {
          if (message.method === 'initialize' && message.id !== undefined) {
            process.send({ id: message.id, result: {} });
          }
          if (message.method === 'account/rateLimits/read' && message.id !== undefined) {
            process.killed = true;
            process.send({ id: message.id, result: { rateLimits: { primary: null } } });
          }
        },
        (created) => {
          child = created;
        },
      ),
    });

    await expect(client.readRateLimits()).resolves.toEqual({ rateLimits: { primary: null } });
    expect(child?.killSignals).toEqual([]);
  });

  it('force-kills a child that ignores graceful shutdown', async () => {
    let child: FakeCodexProcess | undefined;
    const client = new CodexAppServerClient({
      ...clientOptions,
      spawnProcess: fakeProcessFactory(
        (message, process) => {
          if (message.method === 'initialize' && message.id !== undefined) {
            process.send({ id: message.id, result: {} });
          }
          if (message.method === 'account/rateLimits/read' && message.id !== undefined) {
            process.send({ id: message.id, result: { rateLimits: { primary: null } } });
          }
        },
        (created) => {
          child = created;
          const originalKill = created.kill.bind(created);
          created.kill = (signal) => {
            if (signal === 'SIGTERM') {
              created.killSignals.push(signal);
              return true;
            }
            return originalKill(signal);
          };
        },
      ),
    });

    await expect(client.readRateLimits()).resolves.toEqual({ rateLimits: { primary: null } });
    expect(child?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
