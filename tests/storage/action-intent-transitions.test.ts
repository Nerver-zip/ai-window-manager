import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ActionIntentRecord,
  type ProviderRecord,
  type SchedulePolicyRecord,
} from '../../src/storage/repositories.js';

const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];
const nowMs = Date.parse('2026-09-14T08:00:00.000Z');

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-intent-transitions-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const provider: ProviderRecord = {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'automation',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  const policy: SchedulePolicyRecord = {
    id: 'policy-1',
    providerId: 'fake',
    kind: 'target_reset',
    enabled: true,
    timezone: 'UTC',
    config: {},
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  repositories.providers.upsert(provider);
  repositories.schedulePolicies.upsert(policy);
  resources.push({ db, dir });
  return { db, repositories };
}

function intent(overrides: Partial<ActionIntentRecord> = {}): ActionIntentRecord {
  return {
    id: 'intent-1',
    providerId: 'fake',
    policyId: 'policy-1',
    actionType: 'trigger_window',
    dedupeKey: 'fake:trigger_window:policy-1:cycle-1',
    state: 'planned',
    scheduledForMs: nowMs,
    notBeforeMs: null,
    expiresAtMs: nowMs + 60_000,
    attemptCount: 0,
    reasonCode: 'TARGET_RESET_WINDOW_MATCH',
    explanation: { windowKind: 'five_hour' },
    lastErrorCode: null,
    createdAtMs: nowMs,
    startedAtMs: null,
    finishedAtMs: null,
    updatedAtMs: nowMs,
    ...overrides,
  };
}

describe('atomic action intent transitions', () => {
  it('allows one planned claim and rejects the second owner', () => {
    const { repositories } = setup();
    repositories.actionIntents.createIfAbsent(intent());

    const first = repositories.actionIntents.claimPlanned('intent-1', nowMs);
    const second = repositories.actionIntents.claimPlanned('intent-1', nowMs);

    expect(first).toMatchObject({ state: 'executing', attemptCount: 1, startedAtMs: nowMs });
    expect(second).toBeUndefined();
  });

  it('guards terminal and confirmation transitions by their expected source state', () => {
    const { repositories } = setup();
    repositories.actionIntents.createIfAbsent(intent());
    expect(repositories.actionIntents.markConfirmedIfSucceededOrUncertain('intent-1', nowMs)).toBe(
      false,
    );
    expect(repositories.actionIntents.claimPlanned('intent-1', nowMs)).toBeDefined();
    expect(repositories.actionIntents.markSucceededIfExecuting('intent-1', nowMs + 1)).toBe(true);
    expect(
      repositories.actionIntents.markConfirmedIfSucceededOrUncertain('intent-1', nowMs + 2),
    ).toBe(true);
    expect(repositories.actionIntents.markUncertainIfExecuting('intent-1', nowMs + 3)).toBe(false);
    expect(repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'confirmed',
      finishedAtMs: nowMs + 2,
    });
  });

  it('honors not-before and expiry conditions atomically', () => {
    const { repositories } = setup();
    repositories.actionIntents.createIfAbsent(
      intent({ notBeforeMs: nowMs + 10_000, expiresAtMs: nowMs + 20_000 }),
    );
    expect(repositories.actionIntents.claimPlanned('intent-1', nowMs)).toBeUndefined();
    expect(repositories.actionIntents.claimPlanned('intent-1', nowMs + 10_000)).toMatchObject({
      state: 'executing',
    });

    const expired = setup();
    expired.repositories.actionIntents.createIfAbsent(
      intent({ id: 'intent-2', dedupeKey: 'cycle-2', expiresAtMs: nowMs }),
    );
    expect(expired.repositories.actionIntents.claimPlanned('intent-2', nowMs)).toBeUndefined();
  });

  it('moves interrupted execution to uncertain and supports safe retryable transitions', () => {
    const { repositories } = setup();
    repositories.actionIntents.createIfAbsent(intent());
    expect(repositories.actionIntents.claimPlanned('intent-1', nowMs)).toBeDefined();
    expect(repositories.actionIntents.recoverExecuting('intent-1', nowMs + 1)).toBe(true);
    expect(repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'uncertain',
      lastErrorCode: 'ACTION_RECOVERY_REQUIRED',
    });
    expect(repositories.actionIntents.markUncertainIfExecuting('intent-1', nowMs + 2)).toBe(false);
  });
});
