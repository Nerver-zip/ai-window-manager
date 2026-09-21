import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodexProvider as ExportedCodexProvider } from '../../../src/providers/codex/index.js';
import { CodexProvider } from '../../../src/providers/codex/provider.js';
import { fakeProcessFactory, respondToHandshake } from './support.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/providers/codex/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

function providerFor(response: unknown, now = '2026-09-19T12:00:00.000Z'): CodexProvider {
  return new CodexProvider({
    codexHome: '/tmp/awm-codex-test-home',
    now: () => new Date(now),
    spawnProcess: fakeProcessFactory(respondToHandshake(response)),
  });
}

describe('CodexProvider', () => {
  it('is exported from the provider boundary', () => {
    expect(ExportedCodexProvider).toBe(CodexProvider);
  });

  it('normalizes multiple official rate-limit buckets without collapsing windows', async () => {
    const provider = providerFor(fixture('rate-limits.multi-window.json'));

    const observation = await provider.inspect({});

    expect(observation).toMatchObject({
      providerId: 'codex',
      health: 'UP',
      observedAt: '2026-09-19T12:00:00.000Z',
    });
    expect(observation.windows.map((window) => window.windowKind)).toEqual([
      'codex_codex_primary',
      'codex_codex_secondary',
      'codex_weekly_limit_primary',
    ]);
    expect(observation.windows[0]).toMatchObject({
      phase: { value: 'UNKNOWN', source: 'unknown', confidence: 'unknown' },
      durationSeconds: { value: 18_000, source: 'official_supported', confidence: 'exact' },
      usageRatio: { value: 0.25 },
      remainingRatio: { value: 0.75, source: 'inferred' },
    });
    expect(observation.windows[0]?.startedAt).toMatchObject({
      source: 'inferred',
      confidence: 'high',
    });
    expect(provider.capabilities()).toMatchObject({
      usageRead: { supported: true, contract: 'official_supported' },
      resetRead: { supported: true, contract: 'official_supported' },
      windowTrigger: { supported: false, consumesQuota: true },
    });
    expect('triggerWindow' in provider).toBe(true);
    await expect(provider.health({})).resolves.toBe('UP');
  });

  it('advertises the explicit trigger note only when the gate is enabled', () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
    });

    const capability = provider.capabilities().windowTrigger;
    expect(capability.supported).toBe(true);
    expect(capability.notes).toContain('Hi!');
  });

  it('sends the fixed minimal message through the official app-server turn flow', async () => {
    const methods: string[] = [];
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      triggerWorkspace: '/tmp/awm-codex-test-trigger',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory((request, process) => {
        if (request.method) methods.push(request.method);
        if (request.method === 'initialize' && request.id !== undefined) {
          process.send({ id: request.id, result: {} });
        }
        if (request.method === 'thread/start' && request.id !== undefined) {
          process.send({ id: request.id, result: { thread: { id: 'thread-1' } } });
        }
        if (request.method === 'turn/start' && request.id !== undefined) {
          expect(request.params).toMatchObject({
            threadId: 'thread-1',
            input: [{ type: 'text', text: 'Hi!' }],
            approvalPolicy: 'never',
            sandbox: 'read-only',
          });
          process.send({ id: request.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(
            () =>
              process.send({
                method: 'turn/completed',
                params: {
                  threadId: 'thread-1',
                  turn: { id: 'turn-1', status: 'completed' },
                },
              }),
            0,
          );
        }
      }),
    });

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({
      status: 'succeeded',
      confirmationHint: 'CODEX_TURN_COMPLETED',
      occurredAt: '2026-09-19T12:00:00.000Z',
    });
    expect(methods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
  });

  it('does not retry or hide an uncertain turn outcome', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      triggerWorkspace: '/tmp/awm-codex-test-trigger',
      requestTimeoutMs: 10,
      actionTimeoutMs: 10,
      spawnProcess: fakeProcessFactory((request, process) => {
        if (request.method === 'initialize' && request.id !== undefined) {
          process.send({ id: request.id, result: {} });
        }
        if (request.method === 'thread/start' && request.id !== undefined) {
          process.send({ id: request.id, result: { thread: { id: 'thread-1' } } });
        }
        if (request.method === 'turn/start' && request.id !== undefined) {
          process.send({ id: request.id, result: { turn: { id: 'turn-1' } } });
        }
      }),
    });

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'CODEX_TURN_OUTCOME_UNKNOWN' });
  });

  it('rejects the trigger when the explicit quota gate is disabled', async () => {
    const provider = providerFor(fixture('rate-limits.partial.json'));

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({ status: 'rejected', errorCode: 'CODEX_TRIGGER_DISABLED' });
  });

  it.each([
    [
      'auth required',
      { code: 'AUTH_REQUIRED', message: 'login required' },
      'failed',
      'AUTH_REQUIRED',
    ],
    [
      'thread protocol rejection',
      { code: -32602, message: 'invalid params' },
      'rejected',
      'CODEX_THREAD_START_REJECTED',
    ],
  ] as const)('maps %s before dispatch safely', async (_name, error, status, errorCode) => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      triggerWorkspace: '/tmp/awm-codex-test-trigger',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory((request, process) => {
        if (request.method === 'initialize' && request.id !== undefined) {
          process.send({ id: request.id, result: {} });
        }
        if (request.method === 'thread/start' && request.id !== undefined) {
          process.send({ id: request.id, error });
        }
      }),
    });

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({ status, errorCode });
  });

  it('maps a turn-start protocol rejection to a terminal provider result', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      triggerWorkspace: '/tmp/awm-codex-test-trigger',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory((request, process) => {
        if (request.method === 'initialize' && request.id !== undefined) {
          process.send({ id: request.id, result: {} });
        }
        if (request.method === 'thread/start' && request.id !== undefined) {
          process.send({ id: request.id, result: { thread: { id: 'thread-1' } } });
        }
        if (request.method === 'turn/start' && request.id !== undefined) {
          process.send({ id: request.id, error: { code: -32602, message: 'invalid params' } });
        }
      }),
    });

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'CODEX_TURN_START_REJECTED',
    });
  });

  it('marks a failed completed turn as uncertain', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      triggerWorkspace: '/tmp/awm-codex-test-trigger',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory((request, process) => {
        if (request.method === 'initialize' && request.id !== undefined) {
          process.send({ id: request.id, result: {} });
        }
        if (request.method === 'thread/start' && request.id !== undefined) {
          process.send({ id: request.id, result: { thread: { id: 'thread-1' } } });
        }
        if (request.method === 'turn/start' && request.id !== undefined) {
          process.send({ id: request.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(
            () =>
              process.send({
                method: 'turn/completed',
                params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } },
              }),
            0,
          );
        }
      }),
    });

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'CODEX_TURN_FAILED' });
  });

  it('preserves partial nullable fields and does not invent timing or phase', async () => {
    const observation = await providerFor(fixture('rate-limits.partial.json')).inspect({});
    const window = observation.windows[0];

    expect(observation.health).toBe('UP');
    expect(window).toMatchObject({
      phase: { value: 'UNKNOWN' },
      usageRatio: { value: 0 },
      remainingRatio: { value: 1 },
    });
    expect(window?.durationSeconds).toBeUndefined();
    expect(window?.resetAt).toBeUndefined();
    expect(window?.startedAt).toBeUndefined();
  });

  it('uses reset-time phase inference only behind the explicit trigger gate', async () => {
    const response = {
      rateLimits: {
        primary: {
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: Math.floor(new Date('2026-09-19T11:59:00.000Z').getTime() / 1000),
        },
      },
    };
    const monitor = await providerFor(response).inspect({});
    expect(monitor.windows[0]?.phase).toMatchObject({
      value: 'UNKNOWN',
      source: 'unknown',
      confidence: 'unknown',
    });

    const automation = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory(respondToHandshake(response)),
    });
    const inferred = await automation.inspect({});
    expect(inferred.windows[0]?.phase).toMatchObject({
      value: 'INACTIVE',
      source: 'inferred',
      confidence: 'high',
    });
  });

  it('infers an active phase when the reset remains in the future', async () => {
    const response = {
      rateLimits: {
        primary: {
          usedPercent: 10,
          windowDurationMins: 300,
          resetsAt: Math.floor(new Date('2026-09-19T13:00:00.000Z').getTime() / 1000),
        },
      },
    };
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory(respondToHandshake(response)),
    });

    await expect(provider.inspect({})).resolves.toMatchObject({
      windows: [{ phase: { value: 'ACTIVE', source: 'inferred', confidence: 'high' } }],
    });
  });

  it('infers an inactive phase when quota usage is 0 even if reset is projected in the future', async () => {
    const response = {
      rateLimits: {
        primary: {
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: Math.floor(new Date('2026-09-19T17:00:00.000Z').getTime() / 1000),
        },
      },
    };
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory(respondToHandshake(response)),
    });

    await expect(provider.inspect({})).resolves.toMatchObject({
      windows: [{ phase: { value: 'INACTIVE', source: 'inferred', confidence: 'high' } }],
    });
  });

  it('infers an exhausted phase when quota usage is 100% and reset is in the future', async () => {
    const response = {
      rateLimits: {
        primary: {
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: Math.floor(new Date('2026-09-19T17:00:00.000Z').getTime() / 1000),
        },
      },
    };
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory(respondToHandshake(response)),
    });

    await expect(provider.inspect({})).resolves.toMatchObject({
      windows: [{ phase: { value: 'EXHAUSTED', source: 'inferred', confidence: 'high' } }],
    });
  });

  it('uses a safe fallback for empty bucket maps and distinguishes no-window health', async () => {
    const observation = await providerFor({
      rateLimits: { limitId: 'codex', primary: null, secondary: null },
      rateLimitsByLimitId: {},
    }).inspect({});

    expect(observation).toMatchObject({
      health: 'DEGRADED',
      windows: [],
      summary: 'CODEX_NO_RATE_LIMIT_WINDOWS',
    });
  });

  it('keeps normalized window keys stable when provider bucket names collide', async () => {
    const observation = await providerFor({
      rateLimits: { primary: null },
      rateLimitsByLimitId: {
        'a-b': { primary: { usedPercent: 0 } },
        a_b: { primary: { usedPercent: 1 } },
        '!!!': { primary: { usedPercent: 2 } },
      },
    }).inspect({});

    expect(observation.windows.map((window) => window.windowKind)).toEqual([
      'codex_a_b_primary',
      'codex_a_b_primary_2',
      'codex_bucket_primary',
    ]);
  });

  it('turns invalid provider numerics into a bounded error observation', async () => {
    const provider = providerFor(fixture('rate-limits.invalid-numeric.json'));

    const observation = await provider.inspect({});

    expect(observation).toMatchObject({
      providerId: 'codex',
      health: 'ERROR',
      windows: [],
      summary: 'CODEX_INVALID_RESPONSE',
    });
    expect(JSON.stringify(observation)).not.toContain('provider details');
    await expect(provider.health({})).resolves.toBe('ERROR');
  });

  it.each([
    ['duration', { usedPercent: 0, windowDurationMins: 1_000_000, resetsAt: null }],
    ['reset', { usedPercent: 0, windowDurationMins: null, resetsAt: Number.MAX_SAFE_INTEGER }],
  ] as const)('rejects invalid %s timing numerics instead of guessing', async (_name, window) => {
    const observation = await providerFor({
      rateLimits: { primary: window },
    }).inspect({});

    expect(observation).toMatchObject({
      health: 'ERROR',
      windows: [],
      summary: 'CODEX_INVALID_RESPONSE',
    });
  });

  it.each([
    ['AUTH_REQUIRED', 'AUTH_REQUIRED', 'authentication required'],
    ['PROTOCOL_ERROR', 'ERROR', 'protocol mismatch'],
  ] as const)('maps provider protocol failure %s safely', async (_name, health, message) => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory((request, process) => {
        if (request.method === 'initialize' && request.id !== undefined) {
          process.send({ id: request.id, result: {} });
        }
        if (request.method === 'account/rateLimits/read' && request.id !== undefined) {
          process.send({
            id: request.id,
            error: {
              code: _name === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'SCHEMA_MISMATCH',
              message,
            },
          });
        }
      }),
    });

    const observation = await provider.inspect({});

    expect(observation.health).toBe(health);
    expect(observation.summary).toBe(`CODEX_${_name}`);
    expect(observation.summary).not.toContain(message);
  });

  it.each([
    ['timeout', 10, 'TIMEOUT', 'UNAVAILABLE'],
    ['EOF', 100, 'EOF', 'UNAVAILABLE'],
    ['malformed', 100, 'PROTOCOL_ERROR', 'ERROR'],
  ] as const)(
    'maps transport failure %s to a safe observation',
    async (scenario, timeout, code, health) => {
      const provider = new CodexProvider({
        codexHome: '/tmp/awm-codex-test-home',
        requestTimeoutMs: timeout,
        now: () => new Date('2026-09-19T12:00:00.000Z'),
        spawnProcess: fakeProcessFactory((request, process) => {
          if (request.method === 'initialize' && request.id !== undefined) {
            if (scenario === 'malformed') {
              process.stdout.write('{not-json\n');
            } else {
              process.send({ id: request.id, result: {} });
            }
          } else if (scenario === 'EOF' && request.method === 'account/rateLimits/read') {
            process.stdout.end();
          }
        }),
      });

      const observation = await provider.inspect({});

      expect(observation.health).toBe(health);
      expect(observation.summary).toBe(`CODEX_${code}`);
      expect(observation.windows).toEqual([]);
    },
  );

  it('maps a child process error to unavailable without exposing process details', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory((_request, process) => {
        process.emit('error', new Error('private spawn path'));
      }),
    });

    const observation = await provider.inspect({});

    expect(observation).toMatchObject({
      health: 'UNAVAILABLE',
      summary: 'CODEX_PROCESS_ERROR',
      windows: [],
    });
    expect(JSON.stringify(observation)).not.toContain('private spawn path');
  });

  it('uses safe defaults when optional runtime hooks are omitted', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      executable: '/definitely/not/a/codex/binary',
    });

    const observation = await provider.inspect({});

    expect(observation).toMatchObject({ health: 'UNAVAILABLE', summary: 'CODEX_PROCESS_ERROR' });
  });

  it('fails closed when the injected observation clock is invalid', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      now: () => new Date(Number.NaN),
      spawnProcess: fakeProcessFactory(respondToHandshake(fixture('rate-limits.partial.json'))),
    });

    const observation = await provider.inspect({});

    expect(observation).toMatchObject({
      health: 'ERROR',
      windows: [],
      summary: 'CODEX_INVALID_RESPONSE',
    });
  });

  it('returns a deterministic rejection when the action clock is invalid', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      now: () => new Date(Number.NaN),
      spawnProcess: fakeProcessFactory(() => undefined),
    });

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'CODEX_INVALID_TIME',
      occurredAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('maps a thread-start timeout to a pre-dispatch failure', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      requestTimeoutMs: 10,
      actionTimeoutMs: 10,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory((request, process) => {
        if (request.method === 'initialize' && request.id !== undefined)
          process.send({ id: request.id, result: {} });
      }),
    });

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'PROCESS_START_FAILED' });
  });

  it('does not classify a turn-start timeout as a safe retry', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      requestTimeoutMs: 10,
      actionTimeoutMs: 10,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory((request, process) => {
        if (request.method === 'initialize' && request.id !== undefined)
          process.send({ id: request.id, result: {} });
        if (request.method === 'thread/start' && request.id !== undefined)
          process.send({ id: request.id, result: { thread: { id: 'thread-1' } } });
      }),
    });

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'CODEX_TURN_OUTCOME_UNKNOWN' });
  });

  it('maps local trigger workspace failures without exposing filesystem details', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      triggerEnabled: true,
      triggerWorkspace: '/dev/null/awm-codex-trigger',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      spawnProcess: fakeProcessFactory(() => undefined),
    });

    const result = await provider.triggerWindow(
      {},
      { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
    );
    expect(result).toMatchObject({ status: 'uncertain', errorCode: 'CODEX_TURN_OUTCOME_UNKNOWN' });
    expect(JSON.stringify(result)).not.toContain('/dev/null');
  });

  it('uses the real process boundary when no test factory is injected', async () => {
    const provider = new CodexProvider({
      codexHome: '/tmp/awm-codex-test-home',
      executable: '/definitely/not/a/codex/binary',
      triggerEnabled: true,
      triggerWorkspace: '/tmp/awm-codex-test-trigger',
      now: () => new Date('2026-09-19T12:00:00.000Z'),
    });

    await expect(
      provider.triggerWindow(
        {},
        { intentId: 'intent-1', dedupeKey: 'dedupe-1', reasonCode: 'test' },
      ),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'CODEX_TURN_OUTCOME_UNKNOWN' });
  });

  it('rejects unsafe construction options and requires a dedicated Codex home', () => {
    expect(() => new CodexProvider({ codexHome: '  ' })).toThrow('codexHome is required');
    expect(() => new CodexProvider({ codexHome: '/tmp/codex', id: 'Codex' })).toThrow();
    expect(() => new CodexProvider({ codexHome: '/tmp/codex', requestTimeoutMs: 0 })).toThrow(
      'requestTimeoutMs',
    );
    expect(() => new CodexProvider({ codexHome: '/tmp/codex', actionTimeoutMs: 0 })).toThrow(
      'actionTimeoutMs',
    );
    expect(() => new CodexProvider({ codexHome: '/tmp/codex', staleAfterSeconds: 0 })).toThrow();
  });
});
