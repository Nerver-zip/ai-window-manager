import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories, type ProviderRecord } from '../../src/storage/repositories.js';
import { createCommandApi } from '../../src/web/api-commands.js';

const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-api-commands-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock('2026-09-19T12:00:00.000Z');
  const fake = new FakeProvider(clock);
  const provider: ProviderRecord = {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'automation',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: clock.now().getTime(),
    updatedAtMs: clock.now().getTime(),
  };
  repositories.providers.upsert(provider);
  resources.push({ db, dir });
  const adapters = new Map<string, ProviderAdapter>([['fake', fake]]);
  return {
    db,
    repositories,
    clock,
    fake,
    api: createCommandApi({
      repositories,
      adapters,
      clock,
      idFactory: () => 'intent-1',
    }),
  };
}

async function persistObservation(
  context: ReturnType<typeof setup>,
  windowKinds = ['five_hour'],
): Promise<void> {
  const observation = await context.fake.inspect({});
  const baseWindow = observation.windows[0];
  if (!baseWindow) throw new Error('fake observation has no window');
  const observedAtMs = Date.parse(observation.observedAt);
  context.repositories.providerState.upsert({
    providerId: 'fake',
    health: observation.health,
    observedAtMs,
    staleAfterMs: observation.staleAfterSeconds * 1_000,
    observation: {
      ...observation,
      windows: windowKinds.map((windowKind) => ({
        ...baseWindow,
        windowKind,
        durationSeconds: {
          value: windowKind.endsWith('weekly') ? 604_800 : 18_000,
          source: 'observed',
          confidence: 'exact',
          observedAt: observation.observedAt,
        },
      })),
    },
    lastSuccessAtMs: observedAtMs,
    lastErrorCode: null,
    updatedAtMs: observedAtMs,
  });
}

describe('command API', () => {
  it('does not accept commands for a provider hidden by environment configuration', () => {
    const context = setup();
    const api = createCommandApi({
      repositories: context.repositories,
      adapters: new Map([['fake', context.fake]]),
      clock: context.clock,
      fakeProviderEnabled: false,
    });

    expect(api.inspect('fake')).toMatchObject({ statusCode: 404 });
    expect(api.trigger('fake', {})).toMatchObject({ statusCode: 404 });
    expect(context.repositories.events.list('fake')).toEqual([]);
    expect(context.repositories.actionIntents.listOpen('fake')).toEqual([]);
  });

  it('accepts inspect as a reconcile signal without provider I/O', () => {
    const context = setup();
    let requested = 0;
    const api = createCommandApi({
      repositories: context.repositories,
      adapters: new Map([['fake', context.fake]]),
      clock: context.clock,
      requestReconcile: () => {
        requested += 1;
      },
    });

    expect(api.inspect('fake')).toEqual({
      statusCode: 202,
      body: { accepted: true, command: 'inspect' },
    });
    expect(requested).toBe(1);
    expect(context.repositories.events.list('fake')[0]).toMatchObject({
      type: 'inspect_requested',
    });
  });

  it('creates one durable manual intent for repeated idempotent trigger requests', async () => {
    const context = setup();
    await persistObservation(context);

    const first = context.api.trigger('fake', {
      idempotencyKey: 'button-1',
      windowKind: 'five_hour',
    });
    const second = context.api.trigger('fake', {
      idempotencyKey: 'button-1',
      windowKind: 'five_hour',
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    if (first.statusCode === 202 && second.statusCode === 202) {
      expect(first.body.intent).toMatchObject({
        intentId: 'intent-1',
        created: true,
        state: 'planned',
      });
      expect(second.body.intent).toMatchObject({
        intentId: 'intent-1',
        created: false,
        state: 'planned',
      });
    }
    expect(context.repositories.actionIntents.listOpen()).toHaveLength(1);
    expect(
      context.repositories.events
        .list('fake')
        .filter((event) => event.type === 'manual_trigger_requested'),
    ).toHaveLength(2);
  });

  it('keeps otherwise identical manual requests for different exact windows distinct', async () => {
    const context = setup();
    const provider = context.repositories.providers.get('fake');
    if (!provider) throw new Error('provider missing');
    context.repositories.providers.upsert({ ...provider, kind: 'antigravity' });
    await persistObservation(context, [
      'antigravity_gemini_five_hour',
      'antigravity_claude_gpt_five_hour',
    ]);
    let nextId = 0;
    const api = createCommandApi({
      repositories: context.repositories,
      adapters: new Map([['fake', context.fake]]),
      clock: context.clock,
      idFactory: () => `intent-${++nextId}`,
    });

    const gemini = api.trigger('fake', {
      idempotencyKey: 'same-click',
      windowKind: 'antigravity_gemini_five_hour',
    });
    const claude = api.trigger('fake', {
      idempotencyKey: 'same-click',
      windowKind: 'antigravity_claude_gpt_five_hour',
    });

    expect(gemini.statusCode).toBe(202);
    expect(claude.statusCode).toBe(202);
    expect(context.repositories.actionIntents.listOpen()).toHaveLength(2);
    expect(context.repositories.actionIntents.listOpen().map((intent) => intent.dedupeKey)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('manual:antigravity_gemini_five_hour:same-click'),
        expect.stringContaining('manual:antigravity_claude_gpt_five_hour:same-click'),
      ]),
    );
  });

  it('requires an Antigravity target for manual actions', () => {
    const context = setup();
    const provider = context.repositories.providers.get('fake');
    if (!provider) throw new Error('provider missing');
    context.repositories.providers.upsert({ ...provider, kind: 'antigravity' });

    expect(context.api.trigger('fake', {})).toMatchObject({
      statusCode: 400,
      body: { accepted: false, error: { code: 'BAD_REQUEST' } },
    });
    expect(context.repositories.actionIntents.listOpen()).toEqual([]);
  });

  it('rejects manual actions for absent or ambiguous targets without creating an intent', async () => {
    const context = setup();
    const provider = context.repositories.providers.get('fake');
    if (!provider) throw new Error('provider missing');
    context.repositories.providers.upsert({ ...provider, kind: 'antigravity' });
    await persistObservation(context, [
      'antigravity_gemini_five_hour',
      'antigravity_claude_gpt_five_hour',
    ]);

    expect(context.api.trigger('fake', { windowKind: 'antigravity_unknown_weekly' })).toMatchObject(
      {
        statusCode: 400,
        body: { accepted: false, error: { code: 'BAD_REQUEST' } },
      },
    );
    expect(context.api.trigger('fake', { windowKind: 'five_hour' })).toMatchObject({
      statusCode: 400,
      body: { accepted: false, error: { code: 'BAD_REQUEST' } },
    });
    expect(context.repositories.actionIntents.listOpen()).toEqual([]);
  });

  it('uses only an observed exact current policy target for an older Codex-style request', async () => {
    const context = setup();
    const nowMs = context.clock.now().getTime();
    const observation = await context.fake.inspect({});
    context.repositories.providerState.upsert({
      providerId: 'fake',
      health: 'UP',
      observedAtMs: nowMs,
      staleAfterMs: 300_000,
      observation,
      lastSuccessAtMs: nowMs,
      lastErrorCode: null,
      updatedAtMs: nowMs,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'activation-fake',
      providerId: 'fake',
      kind: 'auto',
      enabled: true,
      timezone: 'UTC',
      config: { windowKind: 'five_hour' },
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    const result = context.api.trigger('fake', { idempotencyKey: 'legacy-client' });

    expect(result.statusCode).toBe(202);
    expect(context.repositories.actionIntents.listOpen()[0]).toMatchObject({
      dedupeKey: 'fake:trigger_window:manual:five_hour:legacy-client',
      explanation: { windowKind: 'five_hour' },
    });
  });

  it('rejects disabled, monitor-only and unsupported providers safely', () => {
    const context = setup();
    const provider = context.repositories.providers.get('fake');
    if (!provider) throw new Error('provider missing');
    context.repositories.providers.upsert({ ...provider, mode: 'monitor_only' });
    expect(context.api.trigger('fake', {})).toMatchObject({ statusCode: 409 });

    context.repositories.providers.upsert({ ...provider, mode: 'automation', enabled: false });
    expect(context.api.trigger('fake', {})).toMatchObject({ statusCode: 409 });

    context.repositories.providers.upsert({ ...provider, mode: 'automation', enabled: true });
    const unsupported: ProviderAdapter = {
      id: context.fake.id,
      capabilities: () => ({
        ...context.fake.capabilities(),
        windowTrigger: { supported: false, contract: 'unknown', consumesQuota: 'unknown' },
      }),
      health: (ctx) => context.fake.health(ctx),
      inspect: (ctx) => context.fake.inspect(ctx),
    };
    const api = createCommandApi({
      repositories: context.repositories,
      adapters: new Map([['fake', unsupported]]),
      clock: context.clock,
    });
    expect(api.trigger('fake', {})).toMatchObject({ statusCode: 422 });
    expect(context.repositories.actionIntents.listOpen()).toHaveLength(0);
  });

  it('validates provider ids and trigger payloads', () => {
    const context = setup();
    expect(context.api.inspect('not valid')).toMatchObject({ statusCode: 400 });
    expect(context.api.inspect('missing')).toMatchObject({ statusCode: 404 });
    expect(context.api.trigger('fake', { unknown: true })).toMatchObject({ statusCode: 400 });
    expect(context.api.trigger('fake', { idempotencyKey: '' })).toMatchObject({ statusCode: 400 });
  });
});
