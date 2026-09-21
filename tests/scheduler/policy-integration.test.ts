import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { ActionReasonCode, ActionExecutor } from '../../src/scheduler/action-executor.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { Reconciler } from '../../src/scheduler/reconciler.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ProviderRecord,
  type SchedulePolicyKind,
  type SchedulePolicyRecord,
} from '../../src/storage/repositories.js';

const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

type PlanningPolicy = Exclude<SchedulePolicyKind, 'target_reset' | 'work_window'>;

interface IntegrationContext {
  db: ReturnType<typeof openDatabase>;
  dir: string;
  repositories: ReturnType<typeof createRepositories>;
  clock: FakeClock;
  fake: FakeProvider;
  adapter: ProviderAdapter;
  policy: SchedulePolicyRecord;
  get triggerCount(): number;
}

function createContext(
  kind: PlanningPolicy,
  config: Record<string, unknown>,
  initial = '2026-09-19T07:59:00.000Z',
): IntegrationContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-policy-integration-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock(initial);
  const fake = new FakeProvider(clock, { windowDurationSeconds: 18_000 });
  let triggerCount = 0;
  const adapter: ProviderAdapter = {
    id: fake.id,
    capabilities: () => fake.capabilities(),
    health: (ctx) => fake.health(ctx),
    inspect: (ctx) => fake.inspect(ctx),
    triggerWindow: async (ctx, request) => {
      triggerCount += 1;
      return fake.triggerWindow(ctx, request);
    },
  };
  const nowMs = clock.now().getTime();
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
    id: 'activation-policy',
    providerId: 'fake',
    kind,
    enabled: true,
    timezone: 'UTC',
    config,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  repositories.providers.upsert(provider);
  repositories.schedulePolicies.upsert(policy);
  resources.push({ db, dir });
  return {
    db,
    dir,
    repositories,
    clock,
    fake,
    adapter,
    policy,
    get triggerCount() {
      return triggerCount;
    },
  };
}

function reconciler(context: IntegrationContext): Reconciler {
  return new Reconciler({
    clock: context.clock,
    db: context.db,
    repositories: context.repositories,
    adapters: new Map([['fake', context.adapter]]),
    idFactory: () => 'planned-intent',
  });
}

describe('activation policy integration', () => {
  it('executes one planned fixed activation through ActionExecutor and observes it active', async () => {
    const context = createContext('fixed', {
      windowKind: 'five_hour',
      anchorLocalTime: '08:00',
      toleranceSeconds: 30,
    });
    const service = reconciler(context);
    await service.reconcile();
    context.clock.advanceMs(60_000);
    await service.reconcile();

    const executor = new ActionExecutor({
      clock: context.clock,
      db: context.db,
      repositories: context.repositories,
      adapters: new Map([['fake', context.adapter]]),
    });
    const report = await executor.executeDue();

    expect(report.confirmedIntentIds).toEqual(['planned-intent']);
    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('planned-intent')).toMatchObject({
      state: 'confirmed',
    });
    expect((await context.fake.inspect({})).windows[0]?.phase.value).toBe('ACTIVE');

    context.clock.advanceMs(1_000);
    await service.reconcile();
    expect(context.repositories.actionIntents.get('planned-intent')).toMatchObject({
      state: 'confirmed',
    });
    expect(context.triggerCount).toBe(1);
  });

  it('does not dispatch a planned activation when a manual window appears first', async () => {
    const context = createContext('fixed', {
      windowKind: 'five_hour',
      anchorLocalTime: '08:00',
      toleranceSeconds: 30,
    });
    context.clock.advanceMs(60_000);
    await reconciler(context).reconcile();
    context.fake.setPhase('ACTIVE');

    const executor = new ActionExecutor({
      clock: context.clock,
      db: context.db,
      repositories: context.repositories,
      adapters: new Map([['fake', context.adapter]]),
    });
    const report = await executor.executeDue();

    expect(report.skippedIntentIds).toEqual(['planned-intent']);
    expect(context.repositories.actionIntents.get('planned-intent')).toMatchObject({
      state: 'skipped',
      lastErrorCode: ActionReasonCode.AlreadySatisfied,
    });
    expect(context.triggerCount).toBe(0);
  });

  it('starts an inactive window for Auto and then waits after observation confirms Active', async () => {
    const context = createContext('auto', { windowKind: 'five_hour' });
    const service = reconciler(context);
    const planned = await service.reconcile();
    expect(planned.createdIntentIds).toEqual(['planned-intent']);

    const executor = new ActionExecutor({
      clock: context.clock,
      db: context.db,
      repositories: context.repositories,
      adapters: new Map([['fake', context.adapter]]),
    });
    await executor.executeDue();
    expect(context.triggerCount).toBe(1);

    context.clock.advanceMs(31_000);
    const next = await service.reconcile();
    expect(next.createdIntentIds).toEqual([]);
    expect(next.decisions[0]?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'CURRENT_WINDOW_ACTIVE',
    });
    expect(context.repositories.actionIntents.get('planned-intent')).toMatchObject({
      state: 'confirmed',
    });
  });

  it('fails closed when the selected activation window is not reported', async () => {
    const context = createContext('auto', { windowKind: 'weekly' });
    const report = await reconciler(context).reconcile();

    expect(report.createdIntentIds).toEqual([]);
    expect(report.decisions[0]?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'WINDOW_NOT_REPORTED',
    });
    expect(context.repositories.actionIntents.listOpen('fake')).toHaveLength(0);
  });

  it.each([
    [
      'fixed',
      'fixed' as const,
      { windowKind: 'five_hour', anchorLocalTime: '08:00', toleranceSeconds: 30 },
    ],
    [
      'custom schedule',
      'custom_schedule' as const,
      { windowKind: 'five_hour', times: ['08:00', '18:00'], toleranceSeconds: 30 },
    ],
    [
      'active hours',
      'active_hours' as const,
      { windowKind: 'five_hour', periods: [{ start: '08:00', end: '12:00' }] },
    ],
  ] as const)(
    '%s creates one durable intent and never triggers FakeProvider while planning',
    async (_label, kind, config) => {
      const context = createContext(kind, config);
      const service = reconciler(context);

      const beforeAnchor = await service.reconcile();
      expect(beforeAnchor.createdIntentIds).toEqual([]);
      expect(context.repositories.actionIntents.listOpen('fake')).toHaveLength(0);

      context.clock.advanceMs(60_000);
      const atAnchor = await service.reconcile();
      expect(atAnchor.createdIntentIds).toEqual(['planned-intent']);
      expect(context.repositories.actionIntents.listOpen('fake')).toHaveLength(1);
      expect(context.triggerCount).toBe(0);

      const repeated = await service.reconcile();
      expect(repeated.createdIntentIds).toEqual([]);
      expect(repeated.decisions[0]?.decision).toMatchObject({
        kind: 'WAIT',
        reasonCode: 'ACTION_ALREADY_PENDING',
      });
      expect(context.repositories.actionIntents.listOpen('fake')).toHaveLength(1);
      expect(context.triggerCount).toBe(0);
    },
  );

  it('reopens SQLite state and does not create a duplicate fixed-policy intent', async () => {
    const context = createContext('fixed', {
      windowKind: 'five_hour',
      anchorLocalTime: '08:00',
      toleranceSeconds: 30,
    });
    const service = reconciler(context);
    await service.reconcile();
    context.clock.advanceMs(60_000);
    await service.reconcile();
    expect(context.repositories.actionIntents.listOpen('fake')).toHaveLength(1);

    context.db.close();
    const reopenedDb = openDatabase(path.join(context.dir, 'awm.db'));
    const reopenedRepositories = createRepositories(reopenedDb);
    resources[0]!.db = reopenedDb;
    const reopenedContext: IntegrationContext = {
      ...context,
      db: reopenedDb,
      repositories: reopenedRepositories,
    };

    const report = await reconciler(reopenedContext).reconcile();
    expect(report.createdIntentIds).toEqual([]);
    expect(report.decisions[0]?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'ACTION_ALREADY_PENDING',
    });
    expect(reopenedRepositories.actionIntents.listOpen('fake')).toHaveLength(1);
    expect(reopenedRepositories.providerState.get('fake')?.observation).not.toBeNull();
    expect(context.triggerCount).toBe(0);
  });

  it('invalidates an old planned intent when its persisted policy changes', async () => {
    const context = createContext('fixed', {
      windowKind: 'five_hour',
      anchorLocalTime: '08:00',
      toleranceSeconds: 30,
    });
    context.clock.advanceMs(60_000);
    await reconciler(context).reconcile();
    const oldIntent = context.repositories.actionIntents.get('planned-intent');
    expect(oldIntent).toMatchObject({ state: 'planned' });

    const policy = context.repositories.schedulePolicies.get(context.policy.id);
    if (!policy) throw new Error('activation policy was not persisted');
    context.repositories.schedulePolicies.upsert({
      ...policy,
      config: { windowKind: 'five_hour', anchorLocalTime: '09:00', toleranceSeconds: 30 },
      updatedAtMs: context.clock.now().getTime() + 1,
    });

    const executor = new ActionExecutor({
      clock: context.clock,
      db: context.db,
      repositories: context.repositories,
      adapters: new Map([['fake', context.adapter]]),
    });
    const report = await executor.executeDue();

    expect(report.skippedIntentIds).toEqual(['planned-intent']);
    expect(context.repositories.actionIntents.get('planned-intent')).toMatchObject({
      state: 'skipped',
      lastErrorCode: ActionReasonCode.PolicyChanged,
    });
    expect(context.triggerCount).toBe(0);
  });
});
