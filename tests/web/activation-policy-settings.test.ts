import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import type { ProviderObservation } from '../../src/domain/types.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ProviderRecord,
  type StorageRepositories,
} from '../../src/storage/repositories.js';
import {
  readTimezoneSetting,
  updateActivationPolicy,
  updateTimezoneSetting,
} from '../../src/web/settings-api.js';

type Database = ReturnType<typeof openDatabase>;

interface TestContext {
  db: Database;
  dir: string;
  repositories: StorageRepositories;
  clock: FakeClock;
  fake: FakeProvider;
}

const contexts: TestContext[] = [];
const INITIAL_TIME = '2026-09-19T12:00:00.000Z';

afterEach(() => {
  for (const context of contexts.splice(0)) {
    if (context.db.open) context.db.close();
    fs.rmSync(context.dir, { recursive: true, force: true });
  }
});

function setup(): TestContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-activation-policy-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const clock = new FakeClock(INITIAL_TIME);
  const fake = new FakeProvider(clock, { windowDurationSeconds: 30 });
  const repositories = createRepositories(db);
  const timestamp = clock.now().getTime();
  const provider: ProviderRecord = {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 30,
    config: { fixture: true },
    configVersion: 1,
    createdAtMs: timestamp,
    updatedAtMs: timestamp,
  };
  repositories.providers.upsert(provider);
  const context = { db, dir, repositories, clock, fake };
  contexts.push(context);
  return context;
}

function settingsInput(context: TestContext) {
  return {
    repositories: context.repositories,
    adapters: new Map([['fake', context.fake]]),
    clock: context.clock,
  };
}

async function persistObservation(context: TestContext): Promise<ProviderObservation> {
  const observation = await context.fake.inspect({});
  const observedAtMs = Date.parse(observation.observedAt);
  context.repositories.providerState.upsert({
    providerId: 'fake',
    health: observation.health,
    observedAtMs,
    staleAfterMs: observation.staleAfterSeconds * 1000,
    observation,
    lastSuccessAtMs: observedAtMs,
    lastErrorCode: null,
    updatedAtMs: observedAtMs,
  });
  return observation;
}

function reload(context: TestContext): void {
  const filename = path.join(context.dir, 'awm.db');
  context.db.close();
  context.db = openDatabase(filename);
  context.repositories = createRepositories(context.db);
}

describe('activation policy settings persistence', () => {
  it('reads, persists, and locks the timezone after a manual choice', () => {
    const context = setup();
    const input = settingsInput(context);

    expect(readTimezoneSetting(input)).toBeUndefined();
    expect(
      updateTimezoneSetting(input, {
        timezone: 'America/Sao_Paulo',
        source: 'detected',
      }),
    ).toMatchObject({
      ok: true,
      value: { timezone: { timezone: 'America/Sao_Paulo', source: 'detected' } },
    });
    expect(readTimezoneSetting(input)).toEqual({
      timezone: 'America/Sao_Paulo',
      source: 'detected',
    });

    context.clock.advanceMs(1_000);
    expect(
      updateTimezoneSetting(input, {
        timezone: 'UTC',
        source: 'manual',
      }),
    ).toMatchObject({
      ok: true,
      value: { timezone: { timezone: 'UTC', source: 'manual' } },
    });

    context.clock.advanceMs(1_000);
    expect(
      updateTimezoneSetting(input, {
        timezone: 'Europe/London',
        source: 'detected',
      }),
    ).toMatchObject({
      ok: true,
      value: { timezone: { timezone: 'UTC', source: 'manual' } },
    });
    expect(readTimezoneSetting(input)).toEqual({ timezone: 'UTC', source: 'manual' });

    const timezoneEvents = context.repositories.events
      .list()
      .filter((event) => event.type === 'timezone_updated');
    expect(timezoneEvents).toHaveLength(2);
    expect(timezoneEvents[0]).toMatchObject({
      reasonCode: 'TIMEZONE_UPDATED',
      data: { timezone: 'UTC', source: 'manual' },
    });
  });

  it.each([
    {
      name: 'manual',
      body: { kind: 'manual' as const, enabled: false },
      config: {},
    },
    {
      name: 'auto',
      body: { kind: 'auto' as const, enabled: true },
      config: {},
    },
    {
      name: 'fixed',
      body: {
        kind: 'fixed' as const,
        enabled: true,
        windowKind: 'five_hour',
        anchorLocalTime: '08:00',
        toleranceSeconds: 30,
      },
      config: { windowKind: 'five_hour', anchorLocalTime: '08:00', toleranceSeconds: 30 },
    },
    {
      name: 'custom schedule',
      body: {
        kind: 'custom_schedule' as const,
        enabled: true,
        windowKind: 'five_hour',
        times: ['08:00', '16:00'],
        toleranceSeconds: 30,
      },
      config: { windowKind: 'five_hour', times: ['08:00', '16:00'], toleranceSeconds: 30 },
    },
    {
      name: 'active hours',
      body: {
        kind: 'active_hours' as const,
        enabled: true,
        windowKind: 'five_hour',
        periods: [
          { start: '08:00', end: '12:00' },
          { start: '13:00', end: '17:00' },
        ],
      },
      config: {
        windowKind: 'five_hour',
        periods: [
          { start: '08:00', end: '12:00' },
          { start: '13:00', end: '17:00' },
        ],
      },
    },
  ])('persists the $name activation policy shape', ({ body, config }) => {
    const context = setup();
    const result = updateActivationPolicy(settingsInput(context), {
      ...body,
      providerId: 'fake',
      timezone: 'UTC',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        policy: { id: 'activation-fake', providerId: 'fake', kind: body.kind, timezone: 'UTC' },
        timezone: { timezone: 'UTC', source: 'manual' },
      },
    });
    expect(context.repositories.schedulePolicies.get('activation-fake')).toMatchObject({
      providerId: 'fake',
      kind: body.kind,
      enabled: body.enabled,
      timezone: 'UTC',
      config,
    });
    expect(context.repositories.events.list('fake')[0]).toMatchObject({
      type: 'schedule_policy_updated',
      reasonCode: 'SCHEDULE_POLICY_UPDATED',
      data: { policyId: 'activation-fake', policyKind: body.kind },
    });
  });

  it('keeps a detected timezone detected when the policy form submits it unchanged', () => {
    const context = setup();
    const input = settingsInput(context);
    expect(
      updateTimezoneSetting(input, { timezone: 'America/Sao_Paulo', source: 'detected' }),
    ).toMatchObject({ ok: true });
    const eventsBefore = context.repositories.events.list().length;

    expect(
      updateActivationPolicy(input, {
        kind: 'manual',
        enabled: true,
        providerId: 'fake',
        timezone: 'America/Sao_Paulo',
      }),
    ).toMatchObject({
      ok: true,
      value: { timezone: { timezone: 'America/Sao_Paulo', source: 'detected' } },
    });
    expect(context.repositories.events.list()).toHaveLength(eventsBefore + 1);
    expect(
      context.repositories.events.list().filter((event) => event.type === 'timezone_updated'),
    ).toHaveLength(1);
  });

  it('rejects invalid timezone, unsupported tolerance, overlapping periods, and unknown provider', async () => {
    const context = setup();
    const input = settingsInput(context);
    const fixed = {
      kind: 'fixed' as const,
      enabled: true,
      providerId: 'fake',
      timezone: 'UTC',
      windowKind: 'five_hour',
      anchorLocalTime: '08:00',
      toleranceSeconds: 30,
    };

    expect(updateTimezoneSetting(input, { timezone: 'Not/AZone', source: 'manual' })).toMatchObject(
      {
        ok: false,
        statusCode: 400,
        code: 'INVALID_TIMEZONE',
      },
    );
    expect(updateActivationPolicy(input, { ...fixed, timezone: 'Not/AZone' })).toMatchObject({
      ok: false,
      statusCode: 400,
      code: 'TIMEZONE_REQUIRED',
    });
    expect(updateActivationPolicy(input, { ...fixed, toleranceSeconds: 3_601 })).toMatchObject({
      ok: false,
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
    expect(updateActivationPolicy(input, { ...fixed, providerId: 'missing' })).toMatchObject({
      ok: false,
      statusCode: 404,
      code: 'NOT_FOUND',
    });

    await persistObservation(context);
    expect(updateActivationPolicy(input, { ...fixed, toleranceSeconds: 20 })).toMatchObject({
      ok: false,
      statusCode: 400,
      code: 'INVALID_TOLERANCE',
    });

    expect(
      updateActivationPolicy(input, {
        kind: 'active_hours',
        enabled: true,
        providerId: 'fake',
        timezone: 'UTC',
        windowKind: 'five_hour',
        periods: [
          { start: '08:00', end: '12:00' },
          { start: '11:00', end: '13:00' },
        ],
      }),
    ).toMatchObject({
      ok: false,
      statusCode: 400,
      code: 'INVALID_POLICY',
    });

    expect(context.repositories.schedulePolicies.get('activation-fake')).toBeUndefined();
    expect(
      context.repositories.events
        .list('fake')
        .filter((event) => event.type === 'schedule_policy_updated'),
    ).toHaveLength(0);
  });

  it('reloads timezone, policy, and append-only events from SQLite', () => {
    const context = setup();
    const input = settingsInput(context);
    expect(
      updateTimezoneSetting(input, { timezone: 'America/Sao_Paulo', source: 'manual' }),
    ).toMatchObject({ ok: true });
    expect(
      updateActivationPolicy(input, {
        kind: 'custom_schedule',
        enabled: true,
        providerId: 'fake',
        windowKind: 'five_hour',
        times: ['08:00', '20:00'],
        toleranceSeconds: 45,
      }),
    ).toMatchObject({ ok: true });

    const eventCountBeforeReload = context.repositories.events.list('fake').length;
    reload(context);

    expect(readTimezoneSetting({ repositories: context.repositories })).toEqual({
      timezone: 'America/Sao_Paulo',
      source: 'manual',
    });
    expect(context.repositories.schedulePolicies.get('activation-fake')).toMatchObject({
      kind: 'custom_schedule',
      config: { windowKind: 'five_hour', times: ['08:00', '20:00'], toleranceSeconds: 45 },
    });
    expect(context.repositories.events.list('fake')).toHaveLength(eventCountBeforeReload);
    expect(context.repositories.events.list().map((event) => event.type)).toEqual(
      expect.arrayContaining(['timezone_updated', 'schedule_policy_updated']),
    );
  });
});
