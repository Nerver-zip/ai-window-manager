import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories, type ProviderRecord } from '../../src/storage/repositories.js';
import { updateProviderSettings, updateScheduleSettings } from '../../src/web/settings-api.js';

const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-settings-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock('2026-09-19T12:00:00.000Z');
  const fake = new FakeProvider(clock);
  const provider: ProviderRecord = {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 300,
    config: { safe: true },
    configVersion: 1,
    createdAtMs: clock.now().getTime(),
    updatedAtMs: clock.now().getTime(),
  };
  repositories.providers.upsert(provider);
  resources.push({ db, dir });
  return { db, repositories, clock, fake, adapters: new Map([['fake', fake]]) };
}

describe('settings API', () => {
  it('rejects edits to the hidden FakeProvider without changing its saved row', () => {
    const context = setup();
    const result = updateProviderSettings({ ...context, fakeProviderEnabled: false }, 'fake', {
      enabled: false,
      mode: 'monitor_only',
      pollIntervalSeconds: 60,
    });

    expect(result).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(context.repositories.providers.get('fake')).toMatchObject({ enabled: true });
    expect(
      updateScheduleSettings(
        { ...context, fakeProviderEnabled: false },
        {
          enabled: true,
          providerId: 'fake',
          windowKind: 'five_hour',
          targetResetLocalTime: '13:00',
          timezone: 'UTC',
          toleranceSeconds: 0,
        },
      ),
    ).toMatchObject({ ok: false, statusCode: 404, code: 'NOT_FOUND' });
  });

  it('persists only validated provider runtime settings', () => {
    const context = setup();
    expect(
      updateProviderSettings(context, 'fake', {
        enabled: false,
        mode: 'automation',
        pollIntervalSeconds: 60,
      }),
    ).toMatchObject({ ok: true, value: { providerId: 'fake', mode: 'automation' } });
    expect(context.repositories.providers.get('fake')).toMatchObject({
      enabled: false,
      mode: 'automation',
      modeExplicit: true,
      pollIntervalSeconds: 60,
      config: { safe: true },
    });
    expect(context.repositories.events.list('fake')[0]).toMatchObject({
      type: 'provider_settings_updated',
    });
  });

  it('does not turn automatic starts off when a settings update omits the mode', () => {
    const context = setup();
    const provider = context.repositories.providers.get('fake');
    if (!provider) throw new Error('test provider missing');
    context.repositories.providers.upsert({
      ...provider,
      mode: 'automation',
      modeExplicit: true,
    });

    expect(
      updateProviderSettings(context, 'fake', { enabled: true, pollIntervalSeconds: 60 }),
    ).toMatchObject({ ok: true, value: { mode: 'automation' } });
    expect(context.repositories.providers.get('fake')).toMatchObject({
      mode: 'automation',
      modeExplicit: true,
    });
  });

  it('rejects unknown providers, invalid values, and unsupported automation', () => {
    const context = setup();
    expect(updateProviderSettings(context, 'not valid', {})).toMatchObject({ statusCode: 400 });
    expect(updateProviderSettings(context, 'missing', {})).toMatchObject({ statusCode: 404 });
    expect(
      updateProviderSettings(context, 'fake', {
        enabled: true,
        mode: 'monitor_only',
        pollIntervalSeconds: 29,
      }),
    ).toMatchObject({ statusCode: 400 });

    const noTrigger: ProviderAdapter = {
      id: context.fake.id,
      capabilities: () => ({
        ...context.fake.capabilities(),
        windowTrigger: {
          supported: false,
          contract: 'unknown' as const,
          consumesQuota: 'unknown' as const,
        },
      }),
      health: (ctx) => context.fake.health(ctx),
      inspect: (ctx) => context.fake.inspect(ctx),
    };
    expect(
      updateProviderSettings({ ...context, adapters: new Map([['fake', noTrigger]]) }, 'fake', {
        enabled: true,
        mode: 'automation',
        pollIntervalSeconds: 60,
      }),
    ).toMatchObject({ statusCode: 409 });

    expect(
      updateProviderSettings({ ...context, adapters: new Map() }, 'fake', {
        enabled: true,
        mode: 'automation',
        pollIntervalSeconds: 60,
      }),
    ).toMatchObject({ statusCode: 409, code: 'PROVIDER_UNAVAILABLE' });

    const throwingAdapter: ProviderAdapter = {
      id: 'fake',
      capabilities: () => {
        throw new Error('capabilities unavailable');
      },
      health: (ctx) => context.fake.health(ctx),
      inspect: (ctx) => context.fake.inspect(ctx),
    };
    expect(
      updateProviderSettings(
        { ...context, adapters: new Map([['fake', throwingAdapter]]) },
        'fake',
        { enabled: true, mode: 'automation', pollIntervalSeconds: 60 },
      ),
    ).toMatchObject({ statusCode: 409, code: 'ACTION_CAPABILITY_UNAVAILABLE' });
  });

  it('stores an idempotent target-reset policy and returns a local-time preview', () => {
    const context = setup();
    const first = updateScheduleSettings(context, {
      enabled: true,
      providerId: 'fake',
      windowKind: 'five_hour',
      targetResetLocalTime: '13:00',
      timezone: 'America/Sao_Paulo',
      toleranceSeconds: 30,
    });
    expect(first).toMatchObject({ ok: true, value: { preview: { resolution: 'exact' } } });
    expect(context.repositories.schedulePolicies.list('fake')).toHaveLength(1);
    const second = updateScheduleSettings(context, {
      enabled: false,
      providerId: 'fake',
      windowKind: 'five_hour',
      targetResetLocalTime: '14:00',
      timezone: 'America/Sao_Paulo',
      toleranceSeconds: 45,
    });
    expect(second).toMatchObject({ ok: true, value: { policy: { enabled: false } } });
    expect(context.repositories.schedulePolicies.list('fake')).toHaveLength(1);
    expect(context.repositories.schedulePolicies.get('target-reset-fake-five_hour')).toMatchObject({
      config: { targetResetLocalTime: '14:00', toleranceSeconds: 45 },
    });
  });

  it('rejects invalid timezones, invalid local times, and unknown providers', () => {
    const context = setup();
    const base = {
      enabled: true,
      providerId: 'fake',
      windowKind: 'five_hour',
      targetResetLocalTime: '13:00',
      timezone: 'America/Sao_Paulo',
      toleranceSeconds: 30,
    };
    expect(updateScheduleSettings(context, { ...base, providerId: 'missing' })).toMatchObject({
      statusCode: 404,
    });
    expect(updateScheduleSettings(context, { ...base, timezone: 'Not/AZone' })).toMatchObject({
      statusCode: 400,
    });
    expect(
      updateScheduleSettings(context, { ...base, targetResetLocalTime: '25:00' }),
    ).toMatchObject({
      statusCode: 400,
    });
    expect(updateScheduleSettings(context, { ...base, toleranceSeconds: 3601 })).toMatchObject({
      statusCode: 400,
    });
    expect(updateScheduleSettings(context, {})).toMatchObject({ statusCode: 400 });
  });
});
