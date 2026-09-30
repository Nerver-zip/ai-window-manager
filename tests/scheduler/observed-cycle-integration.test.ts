import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import type { ProviderObservation } from '../../src/domain/types.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { Reconciler } from '../../src/scheduler/reconciler.js';
import { ActionExecutor } from '../../src/scheduler/action-executor.js';
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
