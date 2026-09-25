import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import type { ProviderObservation } from '../../src/domain/types.js';
import { parseProviderObservation } from '../../src/domain/schemas.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { Reconciler, type ReconcilerInput } from '../../src/scheduler/reconciler.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ProviderRecord,
  type ProviderStateRecord,
  type SchedulePolicyRecord,
} from '../../src/storage/repositories.js';

const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function setup(initial = '2026-09-14T07:59:00.000Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-reconcile-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock(initial);
  const fake = new FakeProvider(clock, { windowDurationSeconds: 18_000 });
  let inspectCount = 0;
  let triggerCount = 0;
  const adapter: ProviderAdapter = {
    id: fake.id,
    capabilities: () => fake.capabilities(),
    health: (ctx) => fake.health(ctx),
    inspect: async (ctx) => {
      inspectCount += 1;
      return fake.inspect(ctx);
    },
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
    id: 'policy-1',
    providerId: 'fake',
    kind: 'target_reset',
    enabled: true,
    timezone: 'UTC',
    config: {
      windowKind: 'five_hour',
      targetResetAt: '2026-09-14T13:00:00.000Z',
      toleranceSeconds: 30,
    },
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
    get inspectCount() {
      return inspectCount;
    },
    get triggerCount() {
      return triggerCount;
    },
    reconciler: (extra: Partial<ReconcilerInput> = {}) =>
      new Reconciler({
        clock,
        db,
        repositories,
        adapters: new Map([['fake', adapter]]),
        idFactory: () => 'intent-1',
        ...extra,
      }),
  };
}

describe('Reconciler', () => {
  it('evaluates Antigravity families independently but plans only one provider-wide action', async () => {
    const context = setup();
    const provider = context.repositories.providers.get('fake');
    if (!provider) throw new Error('provider missing');
    context.repositories.providers.upsert({ ...provider, enabled: false });
    context.repositories.providers.upsert({ ...provider, id: 'antigravity', kind: 'antigravity' });
    const nowMs = context.clock.now().getTime();
    const observed = await context.fake.inspect({});
    const sourceWindow = observed.windows[0];
    if (!sourceWindow) throw new Error('fake window missing');
    const antigravityObservation = parseProviderObservation({
      ...observed,
      providerId: 'antigravity',
      windows: [
        {
          ...sourceWindow,
          providerId: 'antigravity',
          windowKind: 'antigravity_gemini_five_hour',
          phase: { ...sourceWindow.phase, value: 'INACTIVE', confidence: 'exact' },
        },
        {
          ...sourceWindow,
          providerId: 'antigravity',
          windowKind: 'antigravity_claude_gpt_weekly',
          phase: { ...sourceWindow.phase, value: 'INACTIVE', confidence: 'exact' },
          durationSeconds: {
            value: 604_800,
            source: 'observed',
            confidence: 'exact',
            observedAt: observed.observedAt,
          },
        },
      ],
    });
    context.repositories.providerState.upsert({
      providerId: 'antigravity',
      health: 'UP',
      observedAtMs: nowMs,
      staleAfterMs: antigravityObservation.staleAfterSeconds * 1000,
      observation: antigravityObservation,
      lastSuccessAtMs: nowMs,
      lastErrorCode: null,
      updatedAtMs: nowMs,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'activation-antigravity-gemini',
      providerId: 'antigravity',
      scope: 'gemini',
      requiresReview: false,
      kind: 'auto',
      enabled: true,
      timezone: 'UTC',
      config: { windowKind: 'antigravity_gemini_five_hour' },
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'activation-antigravity-claude-gpt',
      providerId: 'antigravity',
      scope: 'claude_gpt',
      requiresReview: false,
      kind: 'auto',
      enabled: true,
      timezone: 'UTC',
      config: { windowKind: 'antigravity_claude_gpt_weekly' },
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    const adapter: ProviderAdapter = { ...context.adapter, id: 'antigravity' };
    const report = await new Reconciler({
      clock: context.clock,
      db: context.db,
      repositories: context.repositories,
      adapters: new Map([['antigravity', adapter]]),
      idFactory: () => 'intent-1',
    }).reconcile();

    expect(report.createdIntentIds).toEqual(['intent-1']);
    expect(context.repositories.actionIntents.listOpen()).toMatchObject([
      { policyId: 'activation-antigravity-claude-gpt' },
    ]);
    const geminiDecision = report.decisions.find(
      (item) => item.policyId === 'activation-antigravity-gemini',
    );
    const claudeDecision = report.decisions.find(
      (item) => item.policyId === 'activation-antigravity-claude-gpt',
    );
    expect(claudeDecision?.decision.kind).toBe('START');
    expect(geminiDecision?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'ACTION_ALREADY_PENDING',
    });
    expect(context.triggerCount).toBe(0);
  });

  it('does not plan or create intents from a migration policy until its family is reviewed', async () => {
    const context = setup();
    const provider = context.repositories.providers.get('fake');
    if (!provider) throw new Error('provider missing');
    context.repositories.providers.upsert({ ...provider, enabled: false });
    context.repositories.providers.upsert({ ...provider, id: 'antigravity', kind: 'antigravity' });
    const nowMs = context.clock.now().getTime();
    const observed = await context.fake.inspect({});
    const sourceWindow = observed.windows[0];
    if (!sourceWindow) throw new Error('fake window missing');
    const antigravityObservation = parseProviderObservation({
      ...observed,
      providerId: 'antigravity',
      windows: [
        {
          ...sourceWindow,
          providerId: 'antigravity',
          windowKind: 'antigravity_gemini_five_hour',
          phase: { ...sourceWindow.phase, value: 'INACTIVE', confidence: 'exact' },
        },
      ],
    });
    context.repositories.providerState.upsert({
      providerId: 'antigravity',
      health: 'UP',
      observedAtMs: nowMs,
      staleAfterMs: antigravityObservation.staleAfterSeconds * 1000,
      observation: antigravityObservation,
      lastSuccessAtMs: nowMs,
      lastErrorCode: null,
      updatedAtMs: nowMs,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'activation-antigravity-gemini',
      providerId: 'antigravity',
      scope: 'gemini',
      requiresReview: true,
      kind: 'auto',
      enabled: true,
      timezone: 'UTC',
      config: { windowKind: 'antigravity_gemini_five_hour' },
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    const adapter: ProviderAdapter = { ...context.adapter, id: 'antigravity' };
    const report = await new Reconciler({
      clock: context.clock,
      db: context.db,
      repositories: context.repositories,
      adapters: new Map([['antigravity', adapter]]),
      idFactory: () => 'intent-1',
    }).reconcile();

    expect(report.createdIntentIds).toEqual([]);
    expect(context.repositories.actionIntents.listOpen()).toEqual([]);
    expect(context.repositories.events.list('antigravity')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'schedule_policy_review_required',
          reasonCode: 'POLICY_REVIEW_REQUIRED',
          data: { policyId: 'activation-antigravity-gemini', scope: 'gemini' },
        }),
      ]),
    );
    expect(context.triggerCount).toBe(0);
  });

  it('persists observations, plans one intent at the target, and never triggers the provider', async () => {
    const context = setup();
    const reconciler = context.reconciler();

    const before = await reconciler.reconcile();
    expect(before.decisions[0]?.decision).toMatchObject({
      kind: 'noop',
      reasonCode: 'TARGET_NOT_DUE',
    });
    expect(context.repositories.actionIntents.listOpen()).toHaveLength(0);

    context.clock.advanceMs(61_000);
    const due = await reconciler.reconcile();
    expect(due.createdIntentIds).toEqual(['intent-1']);
    expect(context.repositories.actionIntents.listOpen()).toHaveLength(1);
    expect(context.repositories.providerState.get('fake')).toMatchObject({
      health: 'UP',
      observation: { windows: [{ phase: { value: 'INACTIVE' } }] },
    });
    expect(context.repositories.windowSamples.list('fake')).toHaveLength(2);
    expect(context.triggerCount).toBe(0);

    await reconciler.reconcile();
    await reconciler.reconcile();
    expect(context.repositories.actionIntents.listOpen()).toHaveLength(1);
    expect(
      context.repositories.actionIntents.getByDedupeKey(
        'fake:trigger_window:policy-1:2026-09-14T08:00:00.000Z',
      ),
    ).toMatchObject({ id: 'intent-1', state: 'planned' });
    expect(context.triggerCount).toBe(0);
  });

  it('reopens SQLite state and deduplicates the same target cycle', async () => {
    const context = setup();
    const reconciler = context.reconciler();
    await reconciler.reconcile();
    context.clock.advanceMs(61_000);
    await reconciler.reconcile();
    context.db.close();

    const reopenedDb = openDatabase(path.join(context.dir, 'awm.db'));
    const reopenedRepositories = createRepositories(reopenedDb);
    const reopened = new Reconciler({
      clock: context.clock,
      db: reopenedDb,
      repositories: reopenedRepositories,
      adapters: new Map([['fake', context.adapter]]),
      idFactory: () => 'intent-after-restart',
    });
    const report = await reopened.reconcile();

    expect(report.decisions[0]?.decision).toMatchObject({ kind: 'create_intent' });
    expect(reopenedRepositories.actionIntents.listOpen()).toHaveLength(1);
    expect(reopenedRepositories.actionIntents.listOpen()[0]?.id).toBe('intent-1');
    expect(reopenedRepositories.providerState.get('fake')?.observation).not.toBeNull();
    reopenedDb.close();
    const resource = resources[0];
    if (resource) resource.db = reopenedDb;
  });

  it('retains last-known-good observation after an authentication failure', async () => {
    const context = setup();
    const reconciler = context.reconciler();
    await reconciler.reconcile();
    const previous = context.repositories.providerState.get('fake')?.observation;
    context.fake.setInspectionFailure('AUTH_REQUIRED');
    context.clock.advanceMs(61_000);

    const report = await reconciler.reconcile();
    const state = context.repositories.providerState.get('fake');
    expect(report.decisions).toEqual([]);
    expect(state).toMatchObject({ health: 'AUTH_REQUIRED', lastErrorCode: 'AUTH_REQUIRED' });
    expect(state?.observation).toEqual(previous);
    expect(context.repositories.windowSamples.list('fake')).toHaveLength(1);
    expect(context.repositories.events.list('fake')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'provider_auth_required', reasonCode: 'AUTH_REQUIRED' }),
      ]),
    );
  });

  it('does not create an intent from stale persisted state', async () => {
    const context = setup();
    const staleObservation: ProviderObservation = {
      providerId: 'fake',
      health: 'UP',
      observedAt: '2026-09-14T06:00:00.000Z',
      staleAfterSeconds: 60,
      windows: [
        {
          providerId: 'fake',
          windowKind: 'five_hour',
          observedAt: '2026-09-14T06:00:00.000Z',
          phase: {
            value: 'INACTIVE',
            source: 'observed',
            confidence: 'exact',
            observedAt: '2026-09-14T06:00:00.000Z',
          },
          durationSeconds: {
            value: 18_000,
            source: 'official_supported',
            confidence: 'exact',
            observedAt: '2026-09-14T06:00:00.000Z',
          },
        },
      ],
    };
    context.repositories.providerState.upsert({
      providerId: 'fake',
      health: 'UP',
      observedAtMs: Date.parse(staleObservation.observedAt),
      staleAfterMs: staleObservation.staleAfterSeconds * 1000,
      observation: staleObservation,
      lastSuccessAtMs: Date.parse(staleObservation.observedAt),
      lastErrorCode: null,
      updatedAtMs: context.clock.now().getTime(),
    } satisfies ProviderStateRecord);

    const report = await context.reconciler().reconcile();
    expect(report.decisions[0]?.decision).toMatchObject({
      kind: 'noop',
      reasonCode: 'OBSERVATION_STALE',
    });
    expect(context.repositories.actionIntents.listOpen()).toHaveLength(0);
  });

  it('skips disabled providers and records a missing runtime adapter safely', async () => {
    const disabled = setup();
    const record = disabled.repositories.providers.get('fake');
    if (!record) throw new Error('test provider missing');
    disabled.repositories.providers.upsert({ ...record, enabled: false });
    expect((await disabled.reconciler().reconcile()).inspectedProviderIds).toEqual([]);

    const missing = setup();
    const health: string[] = [];
    const report = await missing
      .reconciler({
        adapters: new Map(),
        onInspectionFailure: (providerId, value) => health.push(`${providerId}:${value}`),
      })
      .reconcile();
    expect(report.decisions).toEqual([]);
    expect(health).toEqual(['fake:UNAVAILABLE']);
    expect(missing.repositories.providerState.get('fake')).toMatchObject({
      health: 'UNAVAILABLE',
      observation: null,
      lastErrorCode: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('does not inspect or schedule a provider while its client runtime is changing', async () => {
    const context = setup();
    const report = await context.reconciler({ isProviderRuntimeChanging: () => true }).reconcile();

    expect(context.inspectCount).toBe(0);
    expect(report.inspectedProviderIds).toEqual([]);
    expect(report.decisions).toEqual([]);
    expect(context.repositories.providerState.get('fake')).toBeUndefined();
  });

  it('maps non-UP observations and typed inspection errors to bounded failure states', async () => {
    const context = setup();
    let response: ProviderObservation = {
      providerId: 'fake',
      health: 'UNAVAILABLE',
      observedAt: context.clock.now().toISOString(),
      windows: [],
      staleAfterSeconds: 10,
    };
    let thrown: unknown;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      inspect: () => {
        if (thrown !== undefined) {
          const error = thrown instanceof Error ? thrown : new Error('inspection failed');
          return Promise.reject(error);
        }
        return Promise.resolve(response);
      },
    };
    const reconciler = context.reconciler({ adapters: new Map([['fake', adapter]]) });

    for (const [health, expected] of [
      ['UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
      ['DEGRADED', 'INVALID_PROVIDER_RESPONSE'],
      ['ERROR', 'INSPECTION_FAILED'],
    ] as const) {
      response = { ...response, health };
      context.clock.advanceMs(61_000);
      await reconciler.reconcile();
      expect(context.repositories.providerState.get('fake')?.lastErrorCode).toBe(expected);
    }

    for (const [code, expected] of [
      ['AUTH_REQUIRED', 'AUTH_REQUIRED'],
      ['ETIMEDOUT', 'PROVIDER_UNAVAILABLE'],
      ['EOF', 'PROVIDER_UNAVAILABLE'],
      ['INVALID_PROVIDER_RESPONSE', 'INVALID_PROVIDER_RESPONSE'],
      ['other', 'INSPECTION_FAILED'],
    ] as const) {
      thrown = Object.assign(new Error(code), { code });
      context.clock.advanceMs(61_000);
      await reconciler.reconcile();
      expect(context.repositories.providerState.get('fake')?.lastErrorCode).toBe(expected);
    }

    response = { ...response, providerId: 'other' };
    thrown = undefined;
    context.clock.advanceMs(61_000);
    await reconciler.reconcile();
    expect(context.repositories.providerState.get('fake')?.lastErrorCode).toBe(
      'INVALID_PROVIDER_RESPONSE',
    );
  });

  it('coalesces overlapping reconcile calls', async () => {
    const context = setup();
    let release!: () => void;
    const inspection = new Promise<ProviderObservation>((resolve) => {
      release = () => {
        void context.fake.inspect({}).then(resolve);
      };
    });
    const adapter: ProviderAdapter = {
      ...context.adapter,
      inspect: () => inspection,
    };
    const reconciler = context.reconciler({ adapters: new Map([['fake', adapter]]) });
    const first = reconciler.reconcile();
    expect(reconciler.isRunning()).toBe(true);
    await Promise.resolve();
    await expect(reconciler.reconcile()).resolves.toMatchObject({ skipped: true });
    release();
    await first;
    expect(reconciler.isRunning()).toBe(false);
  });

  it('does not emit duplicate identical failure events and handles policy/config boundaries', async () => {
    const context = setup();
    const record = context.repositories.providers.get('fake');
    if (!record) throw new Error('test provider missing');
    context.repositories.schedulePolicies.upsert({
      id: 'disabled',
      providerId: 'fake',
      kind: 'target_reset',
      enabled: false,
      timezone: 'UTC',
      config: { targetResetAt: '2026-09-14T13:00:00.000Z' },
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'manual',
      providerId: 'fake',
      kind: 'manual',
      enabled: true,
      timezone: 'UTC',
      config: {},
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'invalid-target',
      providerId: 'fake',
      kind: 'target_reset',
      enabled: true,
      timezone: 'UTC',
      config: { targetResetAt: 'not-an-instant' },
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'missing-window',
      providerId: 'fake',
      kind: 'target_reset',
      enabled: true,
      timezone: 'UTC',
      config: { targetResetAt: '2026-09-14T13:00:00.000Z', windowKind: 'weekly' },
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'bad-tolerance',
      providerId: 'fake',
      kind: 'target_reset',
      enabled: true,
      timezone: 'UTC',
      config: { targetResetAt: '2026-09-14T13:00:00.000Z', toleranceSeconds: 'bad' },
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'non-object',
      providerId: 'fake',
      kind: 'target_reset',
      enabled: true,
      timezone: 'UTC',
      config: 'invalid',
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    });

    const reconciler = context.reconciler();
    await reconciler.reconcile();
    const firstFailureCount = context.repositories.events
      .list('fake')
      .filter((event) => event.type === 'scheduler_noop').length;
    await reconciler.reconcile();
    const secondFailureCount = context.repositories.events
      .list('fake')
      .filter((event) => event.type === 'scheduler_noop').length;
    expect(firstFailureCount).toBeGreaterThan(0);
    expect(secondFailureCount).toBe(firstFailureCount);
  });

  it('does not execute legacy scheduling alongside the activation policy', async () => {
    const context = setup();
    const provider = context.repositories.providers.get('fake');
    if (!provider) throw new Error('test provider missing');
    context.repositories.schedulePolicies.upsert({
      id: 'activation-fake',
      providerId: 'fake',
      kind: 'manual',
      enabled: true,
      timezone: 'UTC',
      config: {},
      createdAtMs: provider.createdAtMs,
      updatedAtMs: provider.updatedAtMs,
    });

    const report = await context.reconciler().reconcile();
    expect(report.decisions).toHaveLength(1);
    expect(report.decisions[0]?.policyId).toBe('activation-fake');
    expect(report.decisions[0]?.decision).toMatchObject({ reasonCode: 'MANUAL_POLICY' });
    expect(context.repositories.actionIntents.listOpen()).toHaveLength(0);
  });

  it('records a reset for the affected window even when another window stays active', async () => {
    const context = setup();
    context.repositories.schedulePolicies.delete('policy-1');
    let inspection = 0;
    const makeObservation = (
      primaryPhase: 'ACTIVE' | 'INACTIVE',
      weeklyPhase: 'ACTIVE' | 'INACTIVE',
    ): ProviderObservation => {
      const observedAt = context.clock.now().toISOString();
      const makeWindow = (windowKind: string, phase: 'ACTIVE' | 'INACTIVE') => ({
        providerId: 'fake',
        windowKind,
        observedAt,
        phase: {
          value: phase,
          source: 'observed' as const,
          confidence: 'exact' as const,
          observedAt,
        },
        durationSeconds: {
          value: 18_000,
          source: 'official_supported' as const,
          confidence: 'exact' as const,
          observedAt,
        },
      });
      return {
        providerId: 'fake',
        health: 'UP',
        observedAt,
        staleAfterSeconds: 300,
        windows: [makeWindow('primary', primaryPhase), makeWindow('weekly', weeklyPhase)],
      };
    };
    const adapter: ProviderAdapter = {
      ...context.adapter,
      inspect: () =>
        Promise.resolve(
          inspection++ === 0
            ? makeObservation('ACTIVE', 'ACTIVE')
            : makeObservation('INACTIVE', 'ACTIVE'),
        ),
    };
    const service = context.reconciler({ adapters: new Map([['fake', adapter]]) });
    await service.reconcile();
    context.clock.advanceMs(61_000);
    await service.reconcile();

    expect(
      context.repositories.events
        .list('fake')
        .filter((event) => event.type === 'unexpected_reset_detected'),
    ).toEqual([
      expect.objectContaining({
        reasonCode: 'UNEXPECTED_WINDOW_RESET',
        data: { windowKind: 'primary', retainedForScheduling: true },
      }),
    ]);
  });
});
