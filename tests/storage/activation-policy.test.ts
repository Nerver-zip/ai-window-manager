import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activationPolicyFromRecord } from '../../src/scheduler/policy.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ProviderRecord,
  type SchedulePolicyRecord,
} from '../../src/storage/repositories.js';

const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

const createdAtMs = Date.parse('2026-09-19T07:00:00.000Z');

function openFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-activation-policy-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  resources.push({ db, dir });
  repositories.providers.upsert({
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'automation',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs,
    updatedAtMs: createdAtMs,
  } satisfies ProviderRecord);
  return { db, dir, repositories };
}

function policies(): SchedulePolicyRecord[] {
  const base = {
    providerId: 'fake',
    enabled: true,
    timezone: 'America/Sao_Paulo',
    createdAtMs,
    updatedAtMs: createdAtMs,
  } as const;

  return [
    { ...base, id: 'activation-manual', kind: 'manual', config: {} },
    { ...base, id: 'activation-auto', kind: 'auto', config: {} },
    {
      ...base,
      id: 'activation-fixed',
      kind: 'fixed',
      config: { windowKind: 'five_hour', anchorLocalTime: '08:00', toleranceSeconds: 30 },
    },
    {
      ...base,
      id: 'activation-custom',
      kind: 'custom_schedule',
      config: {
        windowKind: 'five_hour',
        times: ['08:00', '18:00'],
        toleranceSeconds: 30,
      },
    },
    {
      ...base,
      id: 'activation-active-hours',
      kind: 'active_hours',
      config: {
        windowKind: 'five_hour',
        periods: [{ start: '08:00', end: '12:00' }],
      },
    },
  ] satisfies SchedulePolicyRecord[];
}

describe('persisted activation policies', () => {
  it('round-trips all five modes through SQLite and reopens them unchanged', () => {
    const context = openFixture();
    for (const policy of policies()) context.repositories.schedulePolicies.upsert(policy);

    const firstRead = context.repositories.schedulePolicies.list('fake');
    expect(firstRead.map((policy) => policy.kind)).toEqual([
      'active_hours',
      'auto',
      'custom_schedule',
      'fixed',
      'manual',
    ]);
    expect(firstRead.map((policy) => activationPolicyFromRecord(policy)?.kind)).toEqual([
      'active_hours',
      'auto',
      'custom_schedule',
      'fixed',
      'manual',
    ]);
    expect(activationPolicyFromRecord(firstRead[0]!)).toMatchObject({
      kind: 'active_hours',
      timezone: 'America/Sao_Paulo',
      windowKind: 'five_hour',
      periods: [{ start: '08:00', end: '12:00' }],
    });

    context.db.close();
    const reopenedDb = openDatabase(path.join(context.dir, 'awm.db'));
    const reopenedRepositories = createRepositories(reopenedDb);
    resources[0]!.db = reopenedDb;

    expect(reopenedRepositories.schedulePolicies.list('fake')).toEqual(firstRead);
    expect(
      reopenedRepositories.schedulePolicies
        .list('fake')
        .map((policy) => activationPolicyFromRecord(policy)?.kind),
    ).toEqual(['active_hours', 'auto', 'custom_schedule', 'fixed', 'manual']);
    expect(reopenedDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps activation policy records distinct from append-only history', () => {
    const context = openFixture();
    for (const policy of policies()) context.repositories.schedulePolicies.upsert(policy);

    const table = context.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule_policies'")
      .get();
    const historyTable = context.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
      .get();

    expect(table).toEqual({ name: 'schedule_policies' });
    expect(historyTable).toEqual({ name: 'events' });
    expect(
      (
        context.db.prepare('SELECT COUNT(*) AS count FROM schedule_policies').get() as {
          count: number;
        }
      ).count,
    ).toBe(5);
  });
});
