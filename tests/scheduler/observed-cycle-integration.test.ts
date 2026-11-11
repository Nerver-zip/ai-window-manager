import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import type { ProviderObservation } from '../../src/domain/types.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { Reconciler } from '../../src/scheduler/reconciler.js';
import { ActionExecutor } from '../../src/scheduler/action-executor.js';
import { legacyAutoDedupeKey } from '../../src/scheduler/planner.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';
import { readScheduling } from '../../src/web/scheduling-api.js';

const dirs: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-real-cycle-'));
  dirs.push(dir);
  const file = path.join(dir, 'awm.db');
  let db = openDatabase(file);
  databases.push(db);
  let repositories = createRepositories(db);
  const clock = new FakeClock('2026-09-30T04:28:00Z');
  const at = clock.now().getTime();
  repositories.providers.upsert({
    id: 'codex',
    kind: 'codex',
    enabled: true,
    mode: 'automation',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: at,
    updatedAtMs: at,
  });
  repositories.schedulePolicies.upsert({
    id: 'activation-codex',
    providerId: 'codex',
    kind: 'auto',
    enabled: true,
    timezone: 'America/Sao_Paulo',
    config: { windowKind: 'codex_codex_primary' },
    createdAtMs: at,
    updatedAtMs: at,
  });
  let anchoredReset: number | undefined;
  let triggerCount = 0;
  let anchorOnTrigger = true;
  let failure = false;
  const adapter: ProviderAdapter = {
    id: 'codex',
    capabilities: () => ({
      usageRead: { supported: true, contract: 'official_supported' },
      resetRead: { supported: true, contract: 'official_supported' },
      windowTrigger: { supported: true, contract: 'official_supported', consumesQuota: true },
    }),
    health: () => Promise.resolve('UP'),
    inspect: () => {
      if (failure) throw new Error('synthetic offline');
      const now = clock.now().getTime();
      if (anchoredReset !== undefined && now >= anchoredReset) anchoredReset = undefined;
      const observedAt = clock.now().toISOString();
      return Promise.resolve({
        providerId: 'codex',
        health: 'UP',
        observedAt,
        staleAfterSeconds: 300,
        windows: [
          {
            providerId: 'codex',
            windowKind: 'codex_codex_primary',
            observedAt,
            phase: { value: 'UNKNOWN', confidence: 'unknown', source: 'inferred', observedAt },
            durationSeconds: {
              value: 18_000,
              confidence: 'exact',
              source: 'official_supported',
              observedAt,
            },
            resetAt: {
              value: new Date(anchoredReset ?? now + 18_000_000).toISOString(),
              confidence: 'exact',
              source: 'official_supported',
              observedAt,
            },
            usageRatio: { value: 0, confidence: 'exact', source: 'official_supported', observedAt },
          },
        ],
      } satisfies ProviderObservation);
    },
    triggerWindow: () => {
      triggerCount++;
      if (anchorOnTrigger) anchoredReset = clock.now().getTime() + 18_000_000;
      return Promise.resolve({
        status: 'succeeded' as const,
        occurredAt: clock.now().toISOString(),
        confirmationHint: 'CODEX_TURN_COMPLETED',
      });
    },
  };
  const services = () => ({
    reconciler: new Reconciler({
      db,
      repositories,
      clock,
      adapters: new Map([['codex', adapter]]),
    }),
    executor: new ActionExecutor({
      isProviderRuntimeChanging: () => false,
      db,
      repositories,
      clock,
      adapters: new Map([['codex', adapter]]),
    }),
  });
  return {
    adapter,
    clock,
    services,
    get repositories() {
      return repositories;
    },
    get db() {
      return db;
    },
    get triggerCount() {
      return triggerCount;
    },
    set anchorOnTrigger(value: boolean) {
      anchorOnTrigger = value;
    },
    set failure(value: boolean) {
      failure = value;
    },
    reopen() {
      db.close();
      db = openDatabase(file);
      databases.push(db);
      repositories = createRepositories(db);
    },
  };
}

type WeeklyAllowanceState = {
  present?: boolean;
  resetVerified?: boolean;
  resetAtMs?: number;
  addNewAllowance?: boolean;
  observedAtMs?: number;
};

function installWeeklyAllowance(
  context: ReturnType<typeof setup>,
  getState: (nowMs: number) => WeeklyAllowanceState,
): void {
  const inspect = context.adapter.inspect.bind(context.adapter);
  context.adapter.inspect = async (providerContext) => {
    const observation = await inspect(providerContext);
    const nowMs = context.clock.now().getTime();
    const state = getState(nowMs);
    if (state.present === false && !state.addNewAllowance) return observation;
    const observedAt = new Date(state.observedAtMs ?? nowMs).toISOString();
    const makeWindow = (
      windowKind: string,
      phase: 'ACTIVE' | 'INACTIVE',
      resetAtMs: number,
      usageRatio: number,
    ) => ({
      providerId: 'codex',
      windowKind,
      observedAt,
      phase: {
        value: phase,
        source: 'observed' as const,
        confidence: 'exact' as const,
        observedAt,
      },
      durationSeconds: {
        value: 604_800,
        source: 'official_supported' as const,
        confidence: 'exact' as const,
        observedAt,
      },
      resetAt: {
        value: new Date(resetAtMs).toISOString(),
        source: 'official_supported' as const,
        confidence: 'exact' as const,
        observedAt,
      },
      usageRatio: {
        value: usageRatio,
        source: 'official_supported' as const,
        confidence: 'exact' as const,
        observedAt,
      },
    });
    const windows = [...observation.windows];
    if (state.present !== false) {
      const verified = state.resetVerified === true;
      windows.push(
        makeWindow(
          'codex_weekly',
          verified ? 'INACTIVE' : 'ACTIVE',
          verified
            ? nowMs + 604_800_000
            : (state.resetAtMs ?? Date.parse('2026-10-07T04:28:00.000Z')),
          verified ? 0 : 0.9,
        ),
      );
    }
    if (state.addNewAllowance) {
      windows.push(makeWindow('codex_new_shared', 'INACTIVE', nowMs + 604_800_000, 0));
    }
    return { ...observation, windows } satisfies ProviderObservation;
  };
}

describe('real observed cycle planning/execution', () => {
  it('retries only a read-only ambiguous preflight, not the quota-consuming action', async () => {
    const context = setup();
    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const planned = await services.reconciler.reconcile();
    context.clock.advanceMs(5_000);
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(0);
    expect(context.repositories.actionIntents.get(planned.createdIntentIds[0]!)?.state).toBe(
      'failed_retryable',
    );
    context.clock.advanceMs(10_000);
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(1);
  });

  it('makes an existing cycle intent visible as WAIT in history and persisted schedule reads', async () => {
    const context = setup();
    context.anchorOnTrigger = false;
    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const report = await services.reconciler.reconcile();
    const id = report.createdIntentIds[0]!;
    await services.executor.executeDue();
    // Simulate a legacy confirmed action with no observed anchoring effect.
    context.repositories.actionIntents.markConfirmedIfSucceededOrUncertain(
      id,
      context.clock.now().getTime(),
    );
    context.clock.advanceMs(30_000);
    const duplicate = await services.reconciler.reconcile();
    expect(duplicate.createdIntentIds).toEqual([]);
    expect(duplicate.decisions[0]?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'ACTION_ALREADY_RECORDED',
    });
    expect(
      context.repositories.events
        .list('codex')
        .some((event) => event.reasonCode === 'ACTION_ALREADY_RECORDED'),
    ).toBe(true);
    const view = readScheduling({
      repositories: context.repositories,
      clock: context.clock,
      adapters: new Map([['codex', context.adapter]]),
    });
    expect(view.providers[0]?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'ACTION_ALREADY_RECORDED',
    });
    expect(context.triggerCount).toBe(1);
  });

  it('does not dispatch a planned action whose observed cycle no longer matches', async () => {
    const context = setup();
    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const report = await services.reconciler.reconcile();
    const cycle = context.repositories.windowCycles.get('codex', 'codex_codex_primary')!;
    context.repositories.windowCycles.upsert({ ...cycle, cycleAtMs: cycle.cycleAtMs + 1 });
    await services.executor.executeDue();
    expect(context.repositories.actionIntents.get(report.createdIntentIds[0]!)?.lastErrorCode).toBe(
      'ACTION_WINDOW_CYCLE_CHANGED',
    );
    expect(context.triggerCount).toBe(0);
  });
  it('replays the incident: no extra 03:00 turn, one new turn at the real 06:28 expiry, restart-safe', async () => {
    const context = setup();
    let services = context.services();
    expect((await services.reconciler.reconcile()).createdIntentIds).toEqual([]);
    context.clock.advanceMs(30_000);
    const first = await services.reconciler.reconcile();
    expect(first.createdIntentIds).toHaveLength(1);
    const firstIntent = context.repositories.actionIntents.get(first.createdIntentIds[0]!)!;
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(1);
    // Turn completed is not proof that the reset is anchored.
    expect(context.repositories.actionIntents.get(firstIntent.id)?.state).toBe('uncertain');
    context.clock.advanceMs(30_000);
    expect((await services.executor.executeDue()).confirmedIntentIds).toEqual([firstIntent.id]);
    context.reopen();
    services = context.services();
    context.clock.advanceMs(Date.parse('2026-09-30T06:00:00Z') - context.clock.now().getTime());
    const middle = await services.reconciler.reconcile();
    expect(middle.createdIntentIds).toEqual([]);
    expect(middle.decisions[0]?.decision.reasonCode).toBe('CURRENT_WINDOW_ACTIVE');
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(1);
    context.clock.advanceMs(Date.parse('2026-09-30T09:28:30Z') - context.clock.now().getTime());
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const next = await services.reconciler.reconcile();
    expect(next.createdIntentIds).toHaveLength(1);
    const second = context.repositories.actionIntents.get(next.createdIntentIds[0]!)!;
    expect(second.dedupeKey).not.toBe(firstIntent.dedupeKey);
    expect(second.explanation).toMatchObject({ observedCycleAt: '2026-09-30T09:28:30.000Z' });
    for (let i = 0; i < 4; i++) await services.reconciler.reconcile();
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(2);
    context.clock.advanceMs(30_000);
    await services.executor.executeDue();
    context.reopen();
    services = context.services();
    await services.reconciler.reconcile();
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(2);
    expect(context.repositories.actionIntents.get(second.id)?.state).toBe('confirmed');
  });

  it('keeps a completed but unanchored action uncertain without retry across rolling polls/restarts', async () => {
    const context = setup();
    context.anchorOnTrigger = false;
    let services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const planned = await services.reconciler.reconcile();
    await services.executor.executeDue();
    context.reopen();
    services = context.services();
    for (let i = 0; i < 4; i++) {
      context.clock.advanceMs(30_000);
      await services.reconciler.reconcile();
      await services.executor.executeDue();
    }
    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get(planned.createdIntentIds[0]!)?.state).toBe(
      'uncertain',
    );
  });

  it('keeps the auto identity stable when a shared weekly window disappears and returns', async () => {
    const context = setup();
    context.anchorOnTrigger = false;
    let allowancePresent = true;
    installWeeklyAllowance(context, () => ({ present: allowancePresent }));
    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const planned = await services.reconciler.reconcile();
    expect(planned.createdIntentIds).toHaveLength(1);
    const original = context.repositories.actionIntents.get(planned.createdIntentIds[0]!)!;
    expect(original.dedupeKey).toContain('availability:');
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(1);
    context.repositories.actionIntents.markConfirmedIfSucceededOrUncertain(
      original.id,
      context.clock.now().getTime(),
    );
    const originalTargetCycle = context.repositories.windowCycles.get(
      'codex',
      'codex_codex_primary',
    )!;
    const originalWeeklyCycle = context.repositories.windowCycles.get('codex', 'codex_weekly')!;

    allowancePresent = false;
    context.clock.advanceMs(30_000);
    const omitted = await services.reconciler.reconcile();
    expect(omitted.createdIntentIds).toEqual([]);
    expect(omitted.decisions[0]?.decision.kind).toBe('WAIT');
    expect(context.repositories.actionIntents.get(original.id)?.attemptCount).toBe(1);

    allowancePresent = true;
    context.clock.advanceMs(30_000);
    const reappeared = await services.reconciler.reconcile();
    expect(reappeared.createdIntentIds).toEqual([]);
    expect(reappeared.decisions[0]?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'ACTION_ALREADY_RECORDED',
    });
    expect(context.repositories.windowCycles.get('codex', 'codex_weekly')?.cycleAtMs).toBe(
      originalWeeklyCycle.cycleAtMs,
    );
    expect(context.repositories.windowCycles.get('codex', 'codex_codex_primary')?.cycleAtMs).toBe(
      originalTargetCycle.cycleAtMs,
    );
    expect(context.triggerCount).toBe(1);
  });

  it('does not start a new five-hour window when only the shared weekly cycle resets', async () => {
    const context = setup();
    const resetAtMs = context.clock.now().getTime() + 90_000;
    let resetVerified = false;
    installWeeklyAllowance(context, () => ({ resetAtMs, resetVerified }));
    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const planned = await services.reconciler.reconcile();
    expect(planned.createdIntentIds).toHaveLength(1);
    const originalIntent = context.repositories.actionIntents.get(planned.createdIntentIds[0]!)!;
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get(originalIntent.id)?.attemptCount).toBe(1);
    context.clock.advanceMs(30_000);
    await services.reconciler.reconcile();
    const targetBefore = context.repositories.windowCycles.get('codex', 'codex_codex_primary')!;
    const weeklyBefore = context.repositories.windowCycles.get('codex', 'codex_weekly')!;
    expect(targetBefore.anchoredResetAtMs).not.toBeNull();

    context.clock.advanceMs(30_000);
    resetVerified = true;
    const weeklyReset = await services.reconciler.reconcile();
    expect(weeklyReset.createdIntentIds).toEqual([]);
    expect(weeklyReset.decisions[0]?.decision.kind).toBe('WAIT');
    const targetAfter = context.repositories.windowCycles.get('codex', 'codex_codex_primary')!;
    const weeklyAfter = context.repositories.windowCycles.get('codex', 'codex_weekly')!;
    expect(targetAfter.cycleAtMs).toBe(targetBefore.cycleAtMs);
    expect(targetAfter.anchoredResetAtMs).toBe(targetBefore.anchoredResetAtMs);
    expect(weeklyAfter.cycleAtMs).toBeGreaterThan(weeklyBefore.cycleAtMs);
    expect(context.repositories.actionIntents.get(originalIntent.id)?.state).not.toBe(
      'resolved_unknown',
    );
    expect(context.triggerCount).toBe(1);
  });

  it('blocks a new-format terminal intent when a new allowance member appears without a cycle advance', async () => {
    const context = setup();
    context.anchorOnTrigger = false;
    let addNewAllowance = false;
    installWeeklyAllowance(context, () => ({ present: true, addNewAllowance }));
    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const planned = await services.reconciler.reconcile();
    expect(planned.createdIntentIds).toHaveLength(1);
    const original = context.repositories.actionIntents.get(planned.createdIntentIds[0]!)!;
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(1);
    context.repositories.actionIntents.markConfirmedIfSucceededOrUncertain(
      original.id,
      context.clock.now().getTime(),
    );
    expect(context.repositories.actionIntents.get(original.id)?.dedupeKey).toContain(
      'availability:',
    );

    addNewAllowance = true;
    context.clock.advanceMs(30_000);
    const inconsistent = await services.reconciler.reconcile();
    expect(inconsistent.createdIntentIds).toEqual([]);
    expect(inconsistent.decisions[0]?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'AUTO_OPPORTUNITY_GENERATION_UNCHANGED',
    });
    expect(context.repositories.actionIntents.listOpen('codex')).toEqual([]);
    expect(context.repositories.actionIntents.get(original.id)?.attemptCount).toBe(1);
    expect(context.triggerCount).toBe(1);
  });

  it('fails closed for a legacy skipped row when dispatch history is gone but attempts exist', async () => {
    const context = setup();
    context.anchorOnTrigger = false;
    installWeeklyAllowance(context, () => ({ present: true }));
    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const planned = await services.reconciler.reconcile();
    expect(planned.createdIntentIds).toHaveLength(1);
    const original = context.repositories.actionIntents.get(planned.createdIntentIds[0]!)!;
    await services.executor.executeDue();
    expect(context.triggerCount).toBe(1);

    const explanation = { ...(original.explanation as Record<string, unknown>) };
    delete explanation.eligibilityGeneration;
    const cycleAt = String(explanation.observedCycleAt);
    context.repositories.actionIntents.setState(
      original.id,
      'skipped',
      context.clock.now().getTime(),
      {
        attemptCount: 1,
        lastErrorCode: 'ACTION_ALLOWANCE_EXHAUSTED',
        finishedAtMs: context.clock.now().getTime(),
      },
    );
    context.db
      .prepare(`UPDATE action_intents SET dedupe_key = ?, explanation_json = ? WHERE id = ?`)
      .run(
        legacyAutoDedupeKey('codex', 'activation-codex', 'codex_codex_primary', cycleAt),
        JSON.stringify(explanation),
        original.id,
      );
    context.db
      .prepare(
        `DELETE FROM events WHERE provider_id = 'codex' AND type = 'action_dispatch_started'
         AND json_extract(data_json, '$.intentId') = ?`,
      )
      .run(original.id);
    expect(context.repositories.actionIntents.wasDispatchStarted(original.id, 'codex')).toBe(false);

    context.clock.advanceMs(30_000);
    const afterPruning = await services.reconciler.reconcile();
    expect(afterPruning.createdIntentIds).toEqual([]);
    expect(afterPruning.decisions[0]?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'AUTO_OPPORTUNITY_GENERATION_UNCHANGED',
    });
    expect(context.repositories.actionIntents.get(original.id)?.attemptCount).toBe(1);
    expect(context.triggerCount).toBe(1);
  });

  it('creates one new auto opportunity after a verified shared weekly cycle change', async () => {
    const context = setup();
    const inspect = context.adapter.inspect.bind(context.adapter);
    const startMs = context.clock.now().getTime();
    const weeklyResetAtMs = startMs + 60_000;
    let inspectionCount = 0;
    let weeklyResetVerified = false;
    context.adapter.inspect = async (providerContext) => {
      inspectionCount += 1;
      const observation = await inspect(providerContext);
      const nowMs = context.clock.now().getTime();
      const exhausted = !weeklyResetVerified && inspectionCount >= 3;
      const observedAt = context.clock.now().toISOString();
      return {
        ...observation,
        windows: [
          ...observation.windows,
          {
            providerId: 'codex',
            windowKind: 'codex_weekly',
            observedAt,
            phase: {
              value: exhausted ? 'EXHAUSTED' : weeklyResetVerified ? 'INACTIVE' : 'ACTIVE',
              source: 'observed',
              confidence: 'exact',
              observedAt,
            },
            durationSeconds: {
              value: 604_800,
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
            resetAt: {
              value: new Date(
                weeklyResetVerified ? nowMs + 604_800_000 : weeklyResetAtMs,
              ).toISOString(),
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
            usageRatio: {
              value: exhausted ? 1 : weeklyResetVerified ? 0 : 0.9,
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
          },
        ],
      } satisfies ProviderObservation;
    };

    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const planned = await services.reconciler.reconcile();
    expect(planned.createdIntentIds).toHaveLength(1);
    const oldIntent = context.repositories.actionIntents.get(planned.createdIntentIds[0]!)!;
    await services.executor.executeDue();
    expect(context.repositories.actionIntents.get(oldIntent.id)).toMatchObject({
      state: 'skipped',
      attemptCount: 0,
      lastErrorCode: 'ACTION_ALLOWANCE_EXHAUSTED',
    });
    expect(context.triggerCount).toBe(0);

    context.clock.advanceMs(31_000);
    weeklyResetVerified = true;
    const afterReset = await services.reconciler.reconcile();
    expect(afterReset.createdIntentIds).toHaveLength(1);
    const newIntent = context.repositories.actionIntents.get(afterReset.createdIntentIds[0]!)!;
    expect(newIntent.id).not.toBe(oldIntent.id);
    expect(newIntent.dedupeKey).not.toBe(oldIntent.dedupeKey);
    expect(newIntent.explanation).toMatchObject({ windowKind: 'codex_codex_primary' });

    await services.executor.executeDue();
    await services.reconciler.reconcile();
    await services.executor.executeDue();
    expect(context.repositories.actionIntents.get(oldIntent.id)).toMatchObject({
      state: 'skipped',
      attemptCount: 0,
    });
    expect(context.triggerCount).toBe(1);
  });

  it('keeps a legacy skipped dedupe row until a consumed allowance cycle advances', async () => {
    const context = setup();
    const inspect = context.adapter.inspect.bind(context.adapter);
    const startMs = context.clock.now().getTime();
    const weeklyResetAtMs = startMs + 60_000;
    let inspectionCount = 0;
    let weeklyResetVerified = false;
    context.adapter.inspect = async (providerContext) => {
      inspectionCount += 1;
      const observation = await inspect(providerContext);
      const nowMs = context.clock.now().getTime();
      const exhausted = !weeklyResetVerified && inspectionCount >= 3;
      const observedAt = context.clock.now().toISOString();
      return {
        ...observation,
        windows: [
          ...observation.windows,
          {
            providerId: 'codex',
            windowKind: 'codex_weekly',
            observedAt,
            phase: {
              value: exhausted ? 'EXHAUSTED' : weeklyResetVerified ? 'INACTIVE' : 'ACTIVE',
              source: 'observed',
              confidence: 'exact',
              observedAt,
            },
            durationSeconds: {
              value: 604_800,
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
            resetAt: {
              value: new Date(
                weeklyResetVerified ? nowMs + 604_800_000 : weeklyResetAtMs,
              ).toISOString(),
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
            usageRatio: {
              value: exhausted ? 1 : weeklyResetVerified ? 0 : 0.9,
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
          },
        ],
      } satisfies ProviderObservation;
    };

    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const planned = await services.reconciler.reconcile();
    const oldId = planned.createdIntentIds[0]!;
    await services.executor.executeDue();
    const skipped = context.repositories.actionIntents.get(oldId)!;
    expect(skipped).toMatchObject({
      state: 'skipped',
      attemptCount: 0,
      lastErrorCode: 'ACTION_ALLOWANCE_EXHAUSTED',
    });
    expect(context.repositories.actionIntents.wasDispatchStarted(oldId, 'codex')).toBe(false);

    const oldExplanation = { ...(skipped.explanation as Record<string, unknown>) };
    delete oldExplanation.eligibilityGeneration;
    const cycleAt = String(oldExplanation.observedCycleAt);
    context.db
      .prepare('UPDATE action_intents SET dedupe_key = ?, explanation_json = ? WHERE id = ?')
      .run(
        legacyAutoDedupeKey('codex', 'activation-codex', 'codex_codex_primary', cycleAt),
        JSON.stringify(oldExplanation),
        oldId,
      );

    const unchanged = await services.reconciler.reconcile();
    expect(unchanged.createdIntentIds).toEqual([]);
    expect(unchanged.decisions[0]?.decision.reasonCode).toBe(
      'AUTO_OPPORTUNITY_GENERATION_UNCHANGED',
    );

    context.clock.advanceMs(31_000);
    weeklyResetVerified = true;
    const advanced = await services.reconciler.reconcile();
    expect(advanced.createdIntentIds).toHaveLength(1);
    const next = context.repositories.actionIntents.get(advanced.createdIntentIds[0]!)!;
    expect(next.id).not.toBe(oldId);
    expect(next.dedupeKey).not.toBe(skipped.dedupeKey);
    const repeated = await services.reconciler.reconcile();
    expect(repeated.createdIntentIds).toEqual([]);
    expect(context.triggerCount).toBe(0);
    await services.executor.executeDue();
    await services.executor.executeDue();
    expect(context.repositories.actionIntents.get(oldId)).toMatchObject({
      state: 'skipped',
      attemptCount: 0,
      dedupeKey: legacyAutoDedupeKey('codex', 'activation-codex', 'codex_codex_primary', cycleAt),
    });
    expect(context.repositories.actionIntents.get(next.id)?.attemptCount).toBe(1);
    expect(context.triggerCount).toBe(1);
  });

  it('releases an old uncertain start after 600 reads and dispatches one new verified opportunity', async () => {
    const context = setup();
    context.anchorOnTrigger = false;
    const startMs = context.clock.now().getTime();
    const weeklyResetAtMs = startMs + 60 * 60 * 1000;
    const inspect = context.adapter.inspect.bind(context.adapter);
    const trigger = context.adapter.triggerWindow!.bind(context.adapter);
    let dispatchCount = 0;
    context.adapter.inspect = async (providerContext) => {
      const observation = await inspect(providerContext);
      const nowMs = context.clock.now().getTime();
      const weeklyResetVerified = nowMs >= weeklyResetAtMs;
      const observedAt = context.clock.now().toISOString();
      return {
        ...observation,
        windows: [
          ...observation.windows,
          {
            providerId: 'codex',
            windowKind: 'codex_weekly',
            observedAt,
            phase: {
              value: weeklyResetVerified ? 'INACTIVE' : 'ACTIVE',
              source: 'observed',
              confidence: 'exact',
              observedAt,
            },
            durationSeconds: {
              value: 604_800,
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
            resetAt: {
              value: new Date(
                weeklyResetVerified ? nowMs + 604_800_000 : weeklyResetAtMs,
              ).toISOString(),
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
            usageRatio: {
              value: weeklyResetVerified ? 0 : 0.9,
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
          },
        ],
      } satisfies ProviderObservation;
    };
    context.adapter.triggerWindow = async (providerContext, request) => {
      dispatchCount += 1;
      const result = await trigger(providerContext, request);
      return dispatchCount === 1
        ? { ...result, status: 'uncertain', errorCode: 'SYNTHETIC_OUTCOME_UNKNOWN' }
        : result;
    };

    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    const planned = await services.reconciler.reconcile();
    expect(planned.createdIntentIds).toHaveLength(1);
    const oldIntent = context.repositories.actionIntents.get(planned.createdIntentIds[0]!)!;
    await services.executor.executeDue();
    expect(context.repositories.actionIntents.get(oldIntent.id)).toMatchObject({
      state: 'uncertain',
      attemptCount: 1,
      confirmationAttemptCount: 0,
    });
    expect(context.triggerCount).toBe(1);

    context.failure = true;
    for (let check = 0; check < 600; check += 1) {
      const pending = context.repositories.actionIntents.get(oldIntent.id)!;
      if (pending.confirmationNotBeforeMs !== null) {
        context.clock.advanceMs(pending.confirmationNotBeforeMs - context.clock.now().getTime());
      }
      await services.executor.executeDue();
    }
    expect(context.repositories.actionIntents.get(oldIntent.id)).toMatchObject({
      state: 'uncertain',
      attemptCount: 1,
      confirmationAttemptCount: 600,
    });
    expect(context.triggerCount).toBe(1);

    context.failure = false;
    for (let check = 0; check < 2; check += 1) {
      const pending = context.repositories.actionIntents.get(oldIntent.id)!;
      context.clock.advanceMs(pending.confirmationNotBeforeMs! - context.clock.now().getTime());
      await services.executor.executeDue();
    }
    expect(context.repositories.actionIntents.get(oldIntent.id)).toMatchObject({
      state: 'resolved_unknown',
      attemptCount: 1,
      confirmationAttemptCount: 602,
    });
    expect(context.triggerCount).toBe(1);
    expect(
      context.repositories.events
        .list('codex')
        .filter((event) => event.type === 'action_resolved_unknown'),
    ).toHaveLength(1);

    const nextOpportunity = await services.reconciler.reconcile();
    expect(nextOpportunity.createdIntentIds).toHaveLength(1);
    const newIntent = context.repositories.actionIntents.get(nextOpportunity.createdIntentIds[0]!)!;
    expect(newIntent.id).not.toBe(oldIntent.id);
    expect(newIntent.dedupeKey).not.toBe(oldIntent.dedupeKey);
    await services.executor.executeDue();
    await services.executor.executeDue();
    expect(context.repositories.actionIntents.get(oldIntent.id)).toMatchObject({
      state: 'resolved_unknown',
      attemptCount: 1,
      confirmationAttemptCount: 602,
    });
    expect(context.repositories.actionIntents.get(newIntent.id)?.attemptCount).toBe(1);
    expect(context.triggerCount).toBe(2);
  });

  it('preserves last-known-good lifecycle through inspection failure', async () => {
    const context = setup();
    const services = context.services();
    await services.reconciler.reconcile();
    context.clock.advanceMs(30_000);
    await services.reconciler.reconcile();
    const before = context.repositories.windowCycles.get('codex', 'codex_codex_primary');
    const good = context.repositories.providerState.get('codex')?.observation;
    context.failure = true;
    context.clock.advanceMs(30_000);
    await services.reconciler.reconcile();
    await services.executor.executeDue();
    expect(context.repositories.providerState.get('codex')?.observation).toEqual(good);
    expect(context.repositories.windowCycles.get('codex', 'codex_codex_primary')).toEqual(before);
    expect(context.triggerCount).toBe(0);
  });
});
