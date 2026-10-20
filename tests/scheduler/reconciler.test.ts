import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import type { ProviderObservation, WindowSnapshot } from '../../src/domain/types.js';
import { trackWindowCycles } from '../../src/scheduler/window-cycle.js';
import { parseProviderObservation } from '../../src/domain/schemas.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { Reconciler, type ReconcilerInput } from '../../src/scheduler/reconciler.js';
import { ReconcileWorker } from '../../src/scheduler/reconcile-worker.js';
import { ProviderInspectionCoordinator } from '../../src/providers/inspection-coordinator.js';
import { createCommandApi } from '../../src/web/api-commands.js';
import { ProviderReadBackoff } from '../../src/storage/provider-read-backoff.js';
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

type AntigravityScope = 'gemini' | 'claude_gpt' | 'argon';

const ANTIGRAVITY_WINDOW_KINDS: Record<AntigravityScope, string> = {
  gemini: 'antigravity_gemini_five_hour',
  claude_gpt: 'antigravity_claude_gpt_weekly',
  argon: 'antigravity_argon_weekly',
};

const ANTIGRAVITY_POLICY_IDS: Record<AntigravityScope, string> = {
  gemini: 'activation-antigravity-gemini',
  claude_gpt: 'activation-antigravity-claude-gpt',
  argon: 'activation-antigravity-argon',
};

function prepareAntigravity(context: ReturnType<typeof setup>): number {
  const provider = context.repositories.providers.get('fake');
  if (!provider) throw new Error('provider missing');
  context.repositories.providers.upsert({ ...provider, enabled: false });
  context.repositories.providers.upsert({ ...provider, id: 'antigravity', kind: 'antigravity' });
  return context.clock.now().getTime();
}

function makeAntigravityWindow(
  scope: AntigravityScope,
  observedAt: string,
  options: {
    phase?: WindowSnapshot['phase']['value'];
    confidence?: WindowSnapshot['phase']['confidence'];
    usageRatio?: number;
    resetAt?: string | null;
  } = {},
): WindowSnapshot {
  const phase = options.phase ?? 'INACTIVE';
  const confidence = options.confidence ?? (phase === 'UNKNOWN' ? 'unknown' : 'high');
  const usageRatio = options.usageRatio ?? 0;
  const durationSeconds = scope === 'gemini' ? 18_000 : 604_800;
  const resetAt =
    options.resetAt === null
      ? undefined
      : (options.resetAt ??
        new Date(Date.parse(observedAt) + durationSeconds * 1000).toISOString());

  return {
    providerId: 'antigravity',
    windowKind: ANTIGRAVITY_WINDOW_KINDS[scope],
    observedAt,
    phase: {
      value: phase,
      source: phase === 'UNKNOWN' ? 'inferred' : 'observed',
      confidence,
      observedAt,
    },
    durationSeconds: {
      value: durationSeconds,
      source: 'observed',
      confidence: 'exact',
      observedAt,
    },
    ...(resetAt
      ? {
          resetAt: {
            value: resetAt,
            source: 'observed' as const,
            confidence: 'exact' as const,
            observedAt,
          },
        }
      : {}),
    usageRatio: { value: usageRatio, source: 'inferred', confidence: 'exact', observedAt },
    remainingRatio: {
      value: 1 - usageRatio,
      source: 'inferred',
      confidence: 'exact',
      observedAt,
    },
  };
}

function storeAntigravityObservation(
  context: ReturnType<typeof setup>,
  windows: WindowSnapshot[],
  options: { observedAt?: string; staleAfterSeconds?: number } = {},
): ProviderObservation {
  const nowMs = context.clock.now().getTime();
  const observation = parseProviderObservation({
    providerId: 'antigravity',
    health: 'UP',
    observedAt: options.observedAt ?? context.clock.now().toISOString(),
    staleAfterSeconds: options.staleAfterSeconds ?? 60,
    windows,
  });
  const trackedObservation = trackWindowCycles(observation, context.repositories);
  context.repositories.providerState.upsert({
    providerId: 'antigravity',
    health: 'UP',
    observedAtMs: Date.parse(trackedObservation.observedAt),
    staleAfterMs: trackedObservation.staleAfterSeconds * 1000,
    observation: trackedObservation,
    lastSuccessAtMs: nowMs,
    lastErrorCode: null,
    updatedAtMs: nowMs,
  });
  return trackedObservation;
}

function addAntigravityPolicy(
  context: ReturnType<typeof setup>,
  scope: AntigravityScope,
  options: { kind?: 'manual' | 'auto'; requiresReview?: boolean } = {},
): SchedulePolicyRecord {
  const nowMs = context.clock.now().getTime();
  const policy: SchedulePolicyRecord = {
    id: ANTIGRAVITY_POLICY_IDS[scope],
    providerId: 'antigravity',
    scope,
    requiresReview: options.requiresReview ?? false,
    kind: options.kind ?? 'auto',
    enabled: true,
    timezone: 'UTC',
    config: { windowKind: ANTIGRAVITY_WINDOW_KINDS[scope] },
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  context.repositories.schedulePolicies.upsert(policy);
  return policy;
}

function antigravityReconciler(context: ReturnType<typeof setup>): Reconciler {
  const adapter: ProviderAdapter = { ...context.adapter, id: 'antigravity' };
  return new Reconciler({
    clock: context.clock,
    db: context.db,
    repositories: context.repositories,
    adapters: new Map([['antigravity', adapter]]),
    idFactory: () => 'intent-1',
  });
}

describe('Reconciler', () => {
  it('retains a manual hint during shared outage backoff and reads once after recovery', async () => {
    const context = setup();
    const backoff = new ProviderReadBackoff({
      db: context.db,
      clock: context.clock,
      random: () => 0,
      pollIntervalMs: () => 30_000,
    });
    const inspections = new ProviderInspectionCoordinator({ backoff });
    const reconciler = context.reconciler({ inspections });
    const worker = new ReconcileWorker({
      providerIds: ['fake'],
      intervalMs: 30_000,
      work: async (hints) => (await reconciler.reconcile(hints)).inspectedProviderIds,
      onError: () => {},
    });
    backoff.failed('fake', 'confirmation', 'unavailable');
    for (let n = 0; n < 100; n++) worker.request('fake');
    await worker.runOnce();
    expect(context.inspectCount).toBe(0);
    expect(worker.pendingProviderIds()).toEqual(['fake']);
    context.clock.advanceMs(30_000);
    await worker.runOnce();
    expect(context.inspectCount).toBe(1);
    expect(worker.pendingProviderIds()).toEqual([]);
    expect(backoff.retryAtMs('fake', 'preflight')).toBe(0);
    await worker.stop();
    await inspections.close();
  });

  it('consumes an accepted inspect command through asynchronous wakeup even when not due', async () => {
    const context = setup();
    const inspections = new ProviderInspectionCoordinator();
    const reconciler = context.reconciler({ inspections });
    const errors: unknown[] = [];
    const worker = new ReconcileWorker({
      providerIds: ['fake'],
      intervalMs: 30_000,
      work: async (hints) => (await reconciler.reconcile(hints)).inspectedProviderIds,
      onError: (error) => errors.push(error),
    });
    await worker.runOnce();
    expect(context.inspectCount).toBe(1);
    context.clock.advanceMs(1000);
    await worker.runOnce();
    expect(context.inspectCount).toBe(1);
    worker.start();
    const commands = createCommandApi({
      clock: context.clock,
      repositories: context.repositories,
      adapters: new Map([['fake', context.adapter]]),
      requestReconcile: (id) => {
        worker.request(id);
      },
    });
    expect(commands.inspect('fake').statusCode).toBe(202);
    expect(context.inspectCount).toBe(1);
    await worker.runOnce();
    for (let n = 0; n < 15; n++) await Promise.resolve();
    expect(context.inspectCount).toBe(2);
    expect(worker.pendingProviderIds()).toEqual([]);
    expect(context.repositories.providerState.get('fake')?.observedAtMs).toBe(
      context.clock.now().getTime(),
    );
    expect(context.triggerCount).toBe(0);
    expect(errors).toEqual([]);
    await worker.stop();
    await inspections.close();
  });

  it('keeps forced-read hints deferred while disabled or auth/runtime coordination is active', async () => {
    const context = setup();
    let changing = true;
    const reconciler = context.reconciler({ isProviderRuntimeChanging: () => changing });
    const worker = new ReconcileWorker({
      providerIds: ['fake'],
      intervalMs: 30_000,
      work: async (hints) => (await reconciler.reconcile(hints)).inspectedProviderIds,
      onError: () => {},
    });
    worker.request('fake');
    await worker.runOnce();
    expect(context.inspectCount).toBe(0);
    expect(worker.pendingProviderIds()).toEqual(['fake']);
    changing = false;
    const provider = context.repositories.providers.get('fake')!;
    context.repositories.providers.upsert({ ...provider, enabled: false });
    await worker.runOnce();
    expect(context.inspectCount).toBe(0);
    expect(worker.pendingProviderIds()).toEqual(['fake']);
    context.repositories.providers.upsert(provider);
    await worker.runOnce();
    expect(context.inspectCount).toBe(1);
    expect(worker.pendingProviderIds()).toEqual([]);
    await worker.stop();
  });

  it('keeps Gemini, Claude/GPT and Argon starts serialized provider-wide', async () => {
    const context = setup();
    const nowMs = prepareAntigravity(context);
    const observedAt = new Date(nowMs).toISOString();
    storeAntigravityObservation(
      context,
      (['gemini', 'claude_gpt', 'argon'] as const).map((scope) =>
        makeAntigravityWindow(scope, observedAt),
      ),
    );
    for (const scope of ['gemini', 'claude_gpt', 'argon'] as const) {
      addAntigravityPolicy(context, scope);
    }

    const report = await antigravityReconciler(context).reconcile();
    const starts = report.decisions.filter((item) => item.decision.kind === 'START');
    const waiting = report.decisions.filter(
      (item) =>
        item.decision.kind === 'WAIT' && item.decision.reasonCode === 'ACTION_ALREADY_PENDING',
    );

    expect(report.createdIntentIds).toEqual(['intent-1']);
    expect(starts).toHaveLength(1);
    expect(waiting).toHaveLength(2);
    expect(report.decisions).toHaveLength(3);
    expect(context.repositories.actionIntents.listOpen()).toMatchObject([
      { policyId: starts[0]?.policyId },
    ]);
    expect(context.triggerCount).toBe(0);
  });

  it('keeps Argon manual and review-gated by default, then still blocks it after review', async () => {
    const context = setup();
    prepareAntigravity(context);
    const observedAt = context.clock.now().toISOString();
    storeAntigravityObservation(context, [makeAntigravityWindow('argon', observedAt)]);
    const policy = addAntigravityPolicy(context, 'argon', {
      kind: 'manual',
      requiresReview: true,
    });

    const reviewReport = await antigravityReconciler(context).reconcile();
    expect(reviewReport.decisions).toEqual([]);
    expect(context.repositories.actionIntents.listOpen()).toEqual([]);
    expect(context.repositories.events.list('antigravity')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'schedule_policy_review_required',
          reasonCode: 'POLICY_REVIEW_REQUIRED',
          data: { policyId: policy.id, scope: 'argon' },
        }),
      ]),
    );

    context.repositories.schedulePolicies.upsert({ ...policy, requiresReview: false });
    const reviewedReport = await antigravityReconciler(context).reconcile();
    expect(reviewedReport.decisions[0]?.decision).toMatchObject({
      kind: 'NONE',
      reasonCode: 'MANUAL_POLICY',
    });
    expect(context.repositories.actionIntents.listOpen()).toEqual([]);
    expect(context.triggerCount).toBe(0);
  });

  it.each([
    { state: 'unobserved' as const, expectedReason: 'WINDOW_NOT_REPORTED' },
    { state: 'stale' as const, expectedReason: 'OBSERVATION_STALE' },
    { state: 'unknown' as const, expectedReason: 'WINDOW_PHASE_CONFIDENCE_TOO_LOW' },
  ])(
    'does not create an Argon intent when its observation is $state',
    async ({ state, expectedReason }) => {
      const context = setup();
      prepareAntigravity(context);
      const nowMs = context.clock.now().getTime();
      const observedAtMs = state === 'stale' ? nowMs - 120_000 : nowMs;
      const observedAt = new Date(observedAtMs).toISOString();
      const windows =
        state === 'unobserved'
          ? []
          : [
              makeAntigravityWindow('argon', observedAt, {
                ...(state === 'unknown'
                  ? { phase: 'UNKNOWN' as const, confidence: 'unknown' as const, usageRatio: 0.5 }
                  : {}),
              }),
            ];
      storeAntigravityObservation(context, windows, {
        observedAt,
        staleAfterSeconds: 60,
      });
      addAntigravityPolicy(context, 'argon');

      const report = await antigravityReconciler(context).reconcile();

      expect(report.decisions[0]?.decision).toMatchObject({
        kind: 'WAIT',
        reasonCode: expectedReason,
      });
      expect(report.createdIntentIds).toEqual([]);
      expect(context.repositories.actionIntents.listOpen()).toEqual([]);
      expect(context.triggerCount).toBe(0);
    },
  );

  it.each([
    { resetAt: null, resetDescription: 'missing' },
    { resetAt: '2026-09-14T07:58:00.000Z', resetDescription: 'overdue' },
  ])('does not start a full Argon window with a $resetDescription reset', async ({ resetAt }) => {
    const context = setup();
    prepareAntigravity(context);
    const observedAt = context.clock.now().toISOString();
    const window = makeAntigravityWindow('argon', observedAt, {
      phase: 'UNKNOWN',
      confidence: 'unknown',
      usageRatio: 0,
      resetAt,
    });
    storeAntigravityObservation(context, [window]);
    addAntigravityPolicy(context, 'argon');

    const report = await antigravityReconciler(context).reconcile();
    const decision = report.decisions[0]?.decision;

    expect(
      context.repositories.providerState.get('antigravity')?.observation?.windows[0],
    ).toMatchObject({
      phase: { value: 'UNKNOWN', confidence: 'unknown' },
      usageRatio: { value: 0 },
      remainingRatio: { value: 1 },
    });
    expect(decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'WINDOW_PHASE_CONFIDENCE_TOO_LOW',
      explanation: { phase: 'UNKNOWN', phaseConfidence: 'unknown' },
    });
    expect(report.createdIntentIds).toEqual([]);
    expect(context.repositories.actionIntents.listOpen()).toEqual([]);
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

  it('retains last-known-good usage when provider buckets have ambiguous window identity', async () => {
    const context = setup();
    await context.reconciler().reconcile();
    const previous = context.repositories.providerState.get('fake')?.observation;
    const ambiguousObservation = parseProviderObservation({
      providerId: 'fake',
      health: 'DEGRADED',
      observedAt: context.clock.now().toISOString(),
      staleAfterSeconds: 10,
      windows: [],
      summary: 'PROVIDER_WINDOW_IDENTITY_AMBIGUOUS',
    });
    const ambiguousAdapter: ProviderAdapter = {
      ...context.adapter,
      inspect: () => Promise.resolve(ambiguousObservation),
    };
    const inspectionResults: string[] = [];
    const reconciler = context.reconciler({
      adapters: new Map([['fake', ambiguousAdapter]]),
      onInspection: (_providerId, result) => inspectionResults.push(result),
    });
    context.clock.advanceMs(61_000);

    const report = await reconciler.reconcile();
    const state = context.repositories.providerState.get('fake');

    expect(report.decisions).toEqual([]);
    expect(state).toMatchObject({
      health: 'DEGRADED',
      lastErrorCode: 'PROVIDER_WINDOW_IDENTITY_AMBIGUOUS',
    });
    expect(state?.observation).toEqual(previous);
    expect(context.repositories.windowSamples.list('fake')).toHaveLength(1);
    expect(inspectionResults).toEqual(['invalid_response']);
    const failureEvent = context.repositories.events
      .list('fake')
      .find((event) => event.type === 'provider_inspection_failed');
    expect(failureEvent?.reasonCode).toBe('PROVIDER_WINDOW_IDENTITY_AMBIGUOUS');
    expect(failureEvent?.data).toEqual({
      failureCode: 'PROVIDER_WINDOW_IDENTITY_AMBIGUOUS',
      retainedLastKnownGood: true,
    });
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
