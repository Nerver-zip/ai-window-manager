import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { ActionExecutor, type ActionExecutorPhase } from '../../src/scheduler/action-executor.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { ProviderCleanupWorker } from '../../src/scheduler/provider-cleanup.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ActionIntentRecord,
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

function setup(
  options: {
    triggerResult?: 'succeeded' | 'failed' | 'uncertain' | 'rejected';
    targetWindowKind?: string | null;
    providerId?: string;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-executor-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock('2026-09-14T08:00:00.000Z');
  const providerId = options.providerId ?? 'fake';
  const fake = new FakeProvider(clock, {
    id: providerId,
    windowDurationSeconds: 18_000,
    ...(options.triggerResult ? { triggerResult: options.triggerResult } : {}),
  });
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
    id: providerId,
    kind: providerId === 'codex' ? 'codex' : 'fake',
    enabled: true,
    mode: 'automation',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  repositories.providers.upsert(provider);
  const policy: SchedulePolicyRecord = {
    id: 'policy-1',
    providerId,
    kind: 'target_reset',
    enabled: true,
    timezone: 'UTC',
    config: { windowKind: 'five_hour' },
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  repositories.schedulePolicies.upsert(policy);
  const intent: ActionIntentRecord = {
    id: 'intent-1',
    providerId,
    policyId: 'policy-1',
    actionType: 'trigger_window',
    dedupeKey: `${providerId}:trigger_window:policy-1:2026-09-14T08:00:00.000Z`,
    state: 'planned',
    scheduledForMs: nowMs,
    notBeforeMs: null,
    expiresAtMs: nowMs + 30_000,
    attemptCount: 0,
    reasonCode: 'TARGET_RESET_WINDOW_MATCH',
    explanation:
      options.targetWindowKind === null
        ? { reasonCode: 'TARGET_RESET_WINDOW_MATCH' }
        : {
            windowKind: options.targetWindowKind ?? 'five_hour',
            reasonCode: 'TARGET_RESET_WINDOW_MATCH',
          },
    lastErrorCode: null,
    createdAtMs: nowMs,
    startedAtMs: null,
    finishedAtMs: null,
    updatedAtMs: nowMs,
  };
  repositories.actionIntents.createIfAbsent(intent);
  resources.push({ db, dir });
  return {
    db,
    dir,
    clock,
    fake,
    adapter,
    repositories,
    intent,
    providerId,
    get triggerCount() {
      return triggerCount;
    },
    executor(extra: Partial<ConstructorParameters<typeof ActionExecutor>[0]> = {}) {
      return new ActionExecutor({
        clock,
        db,
        repositories,
        adapters: new Map([[providerId, adapter]]),
        ...extra,
      });
    },
  };
}

describe('ActionExecutor', () => {
  it('defers a planned trigger while its provider executable is changing', async () => {
    const context = setup();
    const inspect = vi.spyOn(context.adapter, 'inspect');
    const report = await context
      .executor({
        isProviderRuntimeChanging: (providerId) => providerId === context.providerId,
      })
      .executeDue();

    expect(report.processedIntentIds).toEqual([]);
    expect(report.confirmedIntentIds).toEqual([]);
    expect(context.repositories.actionIntents.get(context.intent.id)?.state).toBe('planned');
    expect(inspect).not.toHaveBeenCalled();
    expect(context.triggerCount).toBe(0);
  });

  it('coalesces overlapping ticks on the same executor instance', async () => {
    const context = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = context.executor({
      onPhase: async (phase) => {
        if (phase === 'after_claim') await gate;
      },
    });

    const first = executor.executeDue();
    await Promise.resolve();
    await expect(executor.executeDue()).resolves.toMatchObject({ skipped: true });
    release();
    await first;
  });

  it('claims, dispatches, confirms and audits a successful FakeProvider action', async () => {
    const context = setup();
    const trigger = context.adapter.triggerWindow?.bind(context.adapter);
    if (!trigger) throw new Error('fake trigger missing');
    let dispatchedWindowKind: string | undefined;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: (ctx, request) => {
        dispatchedWindowKind = request.windowKind;
        return trigger(ctx, request);
      },
    };

    const report = await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();

    expect(report.confirmedIntentIds).toEqual(['intent-1']);
    expect(context.triggerCount).toBe(1);
    expect(dispatchedWindowKind).toBe('five_hour');
    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'confirmed',
      attemptCount: 1,
    });
    expect(context.repositories.events.list('fake').map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'action_intent_claimed',
        'action_dispatch_started',
        'action_succeeded',
        'action_confirmed',
      ]),
    );
  });

  it('accepts the Codex turn-completed confirmation as the action outcome', async () => {
    const context = setup();
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: () =>
        Promise.resolve({
          status: 'succeeded' as const,
          occurredAt: context.clock.now().toISOString(),
          confirmationHint: 'CODEX_TURN_COMPLETED',
        }),
    };

    const report = await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();

    expect(report.confirmedIntentIds).toEqual(['intent-1']);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
  });

  it('persists a Codex cleanup obligation before trigger dispatch and keeps it after uncertainty', async () => {
    const context = setup({ providerId: 'codex' });
    let obligationVisibleAtDispatch = false;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: async (ctx) => {
        await ctx.registerCleanupArtifact?.({
          kind: 'codex_thread',
          externalId: 'synthetic-thread-id',
        });
        obligationVisibleAtDispatch =
          context.repositories.providerCleanupJobs.listDue(context.clock.now().getTime()).length ===
          1;
        return {
          status: 'uncertain',
          occurredAt: context.clock.now().toISOString(),
          errorCode: 'CODEX_TURN_OUTCOME_UNKNOWN',
        };
      },
    };

    await context.executor({ adapters: new Map([[context.providerId, adapter]]) }).executeDue();

    expect(obligationVisibleAtDispatch).toBe(true);
    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'uncertain',
    });
    expect(context.repositories.providerCleanupJobs.listDue(context.clock.now().getTime())).toEqual(
      [
        expect.objectContaining({
          artifactKind: 'codex_thread',
          state: 'pending',
          attemptCount: 0,
          lastErrorCode: null,
        }),
      ],
    );
    expect(JSON.stringify(context.repositories.events.list(context.providerId))).not.toContain(
      'synthetic-thread-id',
    );
  });

  it('retries cleanup after restart without repeating an uncertain Codex turn', async () => {
    const context = setup({ providerId: 'codex' });
    let triggerAttempts = 0;
    let cleanupAttempts = 0;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: async (ctx) => {
        triggerAttempts += 1;
        await ctx.registerCleanupArtifact?.({
          kind: 'codex_thread',
          externalId: 'synthetic-restart-thread-id',
        });
        return {
          status: 'uncertain',
          occurredAt: context.clock.now().toISOString(),
          errorCode: 'CODEX_TURN_OUTCOME_UNKNOWN',
        };
      },
      cleanupArtifact: () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw Object.assign(new Error('private'), { code: 'TIMEOUT' });
        return Promise.resolve();
      },
    };

    await context.executor({ adapters: new Map([[context.providerId, adapter]]) }).executeDue();
    expect(triggerAttempts).toBe(1);
    expect(context.repositories.actionIntents.get(context.intent.id)?.state).toBe('uncertain');
    expect(
      context.repositories.providerCleanupJobs.listDue(context.clock.now().getTime()),
    ).toHaveLength(1);

    context.db.close();
    const reopenedDb = openDatabase(path.join(context.dir, 'awm.db'));
    const reopenedRepositories = createRepositories(reopenedDb);
    resources.push({ db: reopenedDb, dir: context.dir });

    const worker = new ProviderCleanupWorker({
      clock: context.clock,
      repositories: reopenedRepositories,
      adapters: new Map([[context.providerId, adapter]]),
      retryBaseMs: 1_000,
      retryMaxMs: 4_000,
    });
    expect(await worker.runDue()).toMatchObject({ attempted: 1, deleted: 0, retryable: 1 });
    expect(reopenedRepositories.actionIntents.get(context.intent.id)?.state).toBe('uncertain');
    context.clock.advanceMs(1_000);
    expect(await worker.runDue()).toMatchObject({ attempted: 1, deleted: 1, retryable: 0 });
    expect(
      reopenedDb
        .prepare('SELECT 1 FROM provider_cleanup_jobs WHERE provider_id = ? AND artifact_kind = ?')
        .get(context.providerId, 'codex_thread'),
    ).toBeUndefined();

    const reopenedExecutor = new ActionExecutor({
      clock: context.clock,
      db: reopenedDb,
      repositories: reopenedRepositories,
      adapters: new Map([[context.providerId, adapter]]),
    });
    await reopenedExecutor.executeDue();
    expect(triggerAttempts).toBe(1);
    expect(cleanupAttempts).toBe(2);
  });

  it('allows an explicitly requested manual trigger when Codex phase is unknown', async () => {
    const context = setup();
    context.clock.advanceMs(31_000);
    const nowMs = context.clock.now().getTime();
    context.repositories.actionIntents.createIfAbsent({
      ...context.intent,
      id: 'manual-intent',
      dedupeKey: 'fake:trigger_window:manual:unknown-phase',
      reasonCode: 'MANUAL_TRIGGER_REQUESTED',
      scheduledForMs: nowMs,
      expiresAtMs: nowMs + 300_000,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      explanation: {
        decision: 'manual_trigger',
        reasonCode: 'MANUAL_TRIGGER_REQUESTED',
        windowKind: 'five_hour',
      },
    });
    let dispatches = 0;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      inspect: async () => {
        const observation = await context.fake.inspect({});
        return {
          ...observation,
          windows: observation.windows.map((window) => ({
            ...window,
            phase: { ...window.phase, value: 'UNKNOWN', confidence: 'unknown' },
          })),
        };
      },
      triggerWindow: () => {
        dispatches += 1;
        return Promise.resolve({
          status: 'succeeded' as const,
          occurredAt: context.clock.now().toISOString(),
          confirmationHint: 'CODEX_TURN_COMPLETED',
        });
      },
    };

    const report = await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();

    expect(report.confirmedIntentIds).toContain('manual-intent');
    expect(dispatches).toBe(1);
  });

  it('does not duplicate side effects across repeated ticks or concurrent claims', async () => {
    const context = setup();
    const first = context.executor();
    const second = context.executor();

    await Promise.all([first.executeDue(), second.executeDue()]);
    await first.executeDue();
    await first.executeDue();

    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
  });

  it('atomically serializes trigger claims across policies for one provider', () => {
    const context = setup();
    const nowMs = context.clock.now().getTime();
    const policy = context.repositories.schedulePolicies.get('policy-1');
    if (!policy) throw new Error('test policy missing');
    context.repositories.schedulePolicies.upsert({ ...policy, id: 'policy-2' });
    context.repositories.actionIntents.createIfAbsent({
      ...context.intent,
      id: 'intent-2',
      policyId: 'policy-2',
      dedupeKey: 'fake:trigger_window:policy-2:2026-09-14T08:00:00.000Z',
    });

    expect(context.repositories.actionIntents.claimPlanned('intent-1', nowMs)?.state).toBe(
      'executing',
    );
    expect(context.repositories.actionIntents.claimPlanned('intent-2', nowMs)).toBeUndefined();
    expect(context.repositories.actionIntents.markSucceededIfExecuting('intent-1', nowMs)).toBe(
      true,
    );
    expect(context.repositories.actionIntents.claimPlanned('intent-2', nowMs)).toBeUndefined();
    expect(
      context.repositories.actionIntents.markConfirmedIfSucceededOrUncertain('intent-1', nowMs),
    ).toBe(true);
    expect(context.repositories.actionIntents.claimPlanned('intent-2', nowMs)?.state).toBe(
      'executing',
    );
  });

  it('dispatches at most one trigger per provider during a single execution tick', async () => {
    const context = setup();
    const policy = context.repositories.schedulePolicies.get('policy-1');
    if (!policy) throw new Error('test policy missing');
    context.repositories.schedulePolicies.upsert({ ...policy, id: 'policy-2' });
    context.repositories.actionIntents.createIfAbsent({
      ...context.intent,
      id: 'intent-2',
      policyId: 'policy-2',
      dedupeKey: 'fake:trigger_window:policy-2:2026-09-14T08:00:00.000Z',
    });

    await context.executor().executeDue();

    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
    expect(context.repositories.actionIntents.get('intent-2')?.state).toBe('planned');
  });

  it('skips an intent with no exact target rather than defaulting to the first window', async () => {
    const context = setup({ targetWindowKind: null });

    await context.executor().executeDue();

    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'skipped',
      lastErrorCode: 'ACTION_TARGET_WINDOW_MISSING',
    });
    expect(context.triggerCount).toBe(0);
  });

  it('does not inspect or dispatch an intent before its not-before time', async () => {
    const context = setup();
    const inspect = vi.spyOn(context.adapter, 'inspect');
    context.db
      .prepare('UPDATE action_intents SET not_before_ms = ? WHERE id = ?')
      .run(context.clock.now().getTime() + 60_000, context.intent.id);

    const report = await context.executor().executeDue();

    expect(report.processedIntentIds).toEqual([]);
    expect(context.repositories.actionIntents.get(context.intent.id)?.state).toBe('planned');
    expect(inspect).not.toHaveBeenCalled();
    expect(context.triggerCount).toBe(0);
  });

  it('requires an enabled automation provider and a registered runtime adapter', async () => {
    const disabled = setup();
    const disabledProvider = disabled.repositories.providers.get(disabled.providerId);
    if (!disabledProvider) throw new Error('provider missing');
    disabled.repositories.providers.upsert({ ...disabledProvider, enabled: false });
    await disabled.executor().executeDue();
    expect(disabled.repositories.actionIntents.get(disabled.intent.id)).toMatchObject({
      state: 'skipped',
      lastErrorCode: 'ACTION_PROVIDER_UNAVAILABLE',
    });
    expect(disabled.triggerCount).toBe(0);

    const manualOnly = setup();
    const manualProvider = manualOnly.repositories.providers.get(manualOnly.providerId);
    if (!manualProvider) throw new Error('provider missing');
    manualOnly.repositories.providers.upsert({ ...manualProvider, mode: 'monitor_only' });
    await manualOnly.executor().executeDue();
    expect(manualOnly.repositories.actionIntents.get(manualOnly.intent.id)?.state).toBe('skipped');
    expect(manualOnly.triggerCount).toBe(0);

    const missingAdapter = setup();
    await missingAdapter.executor({ adapters: new Map() }).executeDue();
    expect(missingAdapter.repositories.actionIntents.get(missingAdapter.intent.id)?.state).toBe(
      'skipped',
    );
    expect(missingAdapter.triggerCount).toBe(0);
  });

  it('invalidates an intent when the policy target changes even at the same timestamp', async () => {
    const context = setup();
    const policy = context.repositories.schedulePolicies.get('policy-1');
    if (!policy) throw new Error('policy missing');
    context.repositories.schedulePolicies.upsert({ ...policy, config: { windowKind: 'weekly' } });

    await context.executor().executeDue();

    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'skipped',
      lastErrorCode: 'ACTION_POLICY_CHANGED',
    });
    expect(context.triggerCount).toBe(0);
  });

  it('rechecks policy after fresh inspection before crossing the dispatch boundary', async () => {
    const context = setup();
    const adapter: ProviderAdapter = {
      ...context.adapter,
      inspect: async (ctx) => {
        const observation = await context.fake.inspect(ctx);
        const policy = context.repositories.schedulePolicies.get('policy-1');
        if (!policy) throw new Error('policy missing');
        context.repositories.schedulePolicies.upsert({
          ...policy,
          config: { windowKind: 'weekly' },
        });
        return observation;
      },
    };

    await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();

    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'skipped',
      lastErrorCode: 'ACTION_POLICY_CHANGED',
    });
    expect(context.triggerCount).toBe(0);
  });

  it('skips disabled or malformed saved policy targets instead of reinterpreting an intent', async () => {
    const disabled = setup();
    const disabledPolicy = disabled.repositories.schedulePolicies.get('policy-1');
    if (!disabledPolicy) throw new Error('policy missing');
    disabled.repositories.schedulePolicies.upsert({ ...disabledPolicy, enabled: false });
    await disabled.executor().executeDue();
    expect(disabled.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'skipped',
      lastErrorCode: 'ACTION_POLICY_CHANGED',
    });

    const malformedTarget = setup();
    const policy = malformedTarget.repositories.schedulePolicies.get('policy-1');
    if (!policy) throw new Error('policy missing');
    malformedTarget.repositories.schedulePolicies.upsert({ ...policy, config: {} });
    await malformedTarget.executor().executeDue();
    expect(malformedTarget.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'skipped',
      lastErrorCode: 'ACTION_POLICY_CHANGED',
    });
    expect(disabled.triggerCount + malformedTarget.triggerCount).toBe(0);
  });

  it('allows an exact-target manual intent without a schedule policy', async () => {
    const context = setup();
    context.db.prepare('UPDATE action_intents SET policy_id = NULL WHERE id = ?').run('intent-1');

    await context.executor().executeDue();

    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
    expect(context.triggerCount).toBe(1);
  });

  it('skips expired, already-satisfied, and unsupported intents without dispatch', async () => {
    const expired = setup();
    expired.clock.advanceMs(31_000);
    await expired.executor().executeDue();
    expect(expired.repositories.actionIntents.get('intent-1')?.state).toBe('skipped');
    expect(expired.triggerCount).toBe(0);

    const exact = setup();
    exact.clock.advanceMs(30_000);
    const exactNowMs = exact.clock.now().getTime();
    exact.repositories.actionIntents.createIfAbsent({
      ...exact.intent,
      id: 'exact-intent',
      dedupeKey: 'fake:trigger_window:policy-1:exact',
      scheduledForMs: exactNowMs,
      expiresAtMs: exactNowMs,
      explanation: { windowKind: 'five_hour', toleranceSeconds: 0 },
      createdAtMs: exactNowMs,
      updatedAtMs: exactNowMs,
    });
    await exact.executor().executeDue();
    expect(exact.repositories.actionIntents.get('exact-intent')?.state).toBe('confirmed');
    expect(exact.triggerCount).toBe(1);

    const active = setup();
    active.fake.setPhase('ACTIVE');
    await active.executor().executeDue();
    expect(active.repositories.actionIntents.get('intent-1')?.state).toBe('skipped');
    expect(active.triggerCount).toBe(0);

    const unsupported = setup();
    const unsupportedAdapter: ProviderAdapter = {
      ...unsupported.adapter,
      capabilities: () => ({
        ...unsupported.fake.capabilities(),
        windowTrigger: { supported: false, contract: 'unknown', consumesQuota: 'unknown' },
      }),
    };
    await unsupported.executor({ adapters: new Map([['fake', unsupportedAdapter]]) }).executeDue();
    expect(unsupported.repositories.actionIntents.get('intent-1')?.state).toBe('skipped');
    expect(unsupported.triggerCount).toBe(0);

    const throwing = setup();
    const throwingAdapter: ProviderAdapter = {
      ...throwing.adapter,
      capabilities: () => {
        throw new Error('capabilities unavailable');
      },
    };
    await throwing.executor({ adapters: new Map([['fake', throwingAdapter]]) }).executeDue();
    expect(throwing.repositories.actionIntents.get('intent-1')?.state).toBe('skipped');
    expect(throwing.triggerCount).toBe(0);

    const missingMethod = setup();
    const adapterWithoutMethod: ProviderAdapter = {
      id: 'fake',
      capabilities: () => missingMethod.fake.capabilities(),
      health: (ctx) => missingMethod.fake.health(ctx),
      inspect: (ctx) => missingMethod.fake.inspect(ctx),
    };
    await missingMethod
      .executor({ adapters: new Map([['fake', adapterWithoutMethod]]) })
      .executeDue();
    expect(missingMethod.repositories.actionIntents.get('intent-1')?.state).toBe('skipped');
    expect(missingMethod.triggerCount).toBe(0);

    const wrongWindow = setup();
    const wrongWindowAdapter: ProviderAdapter = {
      ...wrongWindow.adapter,
      capabilities: () => ({
        ...wrongWindow.fake.capabilities(),
        windowTrigger: {
          supported: true,
          supportedWindowKinds: ['weekly'],
          contract: 'official_client_internal',
          consumesQuota: true,
        },
      }),
    };
    await wrongWindow.executor({ adapters: new Map([['fake', wrongWindowAdapter]]) }).executeDue();
    expect(wrongWindow.repositories.actionIntents.get('intent-1')?.state).toBe('skipped');
    expect(wrongWindow.triggerCount).toBe(0);
  });

  it('classifies authentication, provider identity and malformed preflight failures safely', async () => {
    const authRequired = setup();
    const authAdapter: ProviderAdapter = {
      ...authRequired.adapter,
      inspect: async () => {
        const observation = await authRequired.fake.inspect({});
        return { ...observation, health: 'AUTH_REQUIRED' };
      },
    };
    await authRequired.executor({ adapters: new Map([['fake', authAdapter]]) }).executeDue();
    expect(authRequired.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'failed_retryable',
      lastErrorCode: 'AUTH_REQUIRED',
    });

    const wrongIdentity = setup();
    const identityAdapter: ProviderAdapter = {
      ...wrongIdentity.adapter,
      inspect: async () => {
        const observation = await wrongIdentity.fake.inspect({});
        return {
          ...observation,
          providerId: 'unexpected-provider',
          windows: observation.windows.map((window) => ({
            ...window,
            providerId: 'unexpected-provider',
          })),
        };
      },
    };
    await wrongIdentity.executor({ adapters: new Map([['fake', identityAdapter]]) }).executeDue();
    expect(wrongIdentity.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'failed_retryable',
      lastErrorCode: 'PROVIDER_UNAVAILABLE',
    });

    const malformed = setup();
    const malformedAdapter: ProviderAdapter = {
      ...malformed.adapter,
      inspect: () => Promise.reject(new Error('synthetic malformed response')),
    };
    await malformed.executor({ adapters: new Map([['fake', malformedAdapter]]) }).executeDue();
    expect(malformed.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'failed_retryable',
      lastErrorCode: 'INSPECTION_FAILED',
    });
  });

  it('keeps uncertain outcomes uncertain and never blindly retries', async () => {
    const context = setup();
    let triggerCalls = 0;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: async (ctx, request) => {
        triggerCalls += 1;
        const sideEffect = await context.fake.triggerWindow(ctx, request);
        return { ...sideEffect, status: 'uncertain' };
      },
    };

    await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();
    await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();

    expect(triggerCalls).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
  });

  it('does not resolve a persisted uncertain result when its provider adapter is unavailable', async () => {
    const context = setup();
    context.repositories.actionIntents.setState(
      'intent-1',
      'uncertain',
      context.clock.now().getTime(),
    );

    await context.executor({ adapters: new Map() }).executeDue();

    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('uncertain');
    expect(context.triggerCount).toBe(0);
  });

  it('uses a bounded uncertain state for a failed dispatch without a trustworthy error code', async () => {
    const context = setup();
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: () =>
        Promise.resolve({
          status: 'failed',
          occurredAt: context.clock.now().toISOString(),
        }),
    };

    await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();

    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'uncertain',
      lastErrorCode: 'ACTION_DISPATCH_UNCERTAIN',
    });
  });

  it('keeps rejected dispatch terminal and ambiguous failed dispatch uncertain', async () => {
    const rejected = setup();
    let rejectedMetric: string | undefined;
    const rejectingAdapter: ProviderAdapter = {
      ...rejected.adapter,
      triggerWindow: () =>
        Promise.resolve({
          status: 'rejected',
          occurredAt: rejected.clock.now().toISOString(),
        }),
    };
    await rejected
      .executor({
        adapters: new Map([['fake', rejectingAdapter]]),
        onTrigger: (_providerId, result) => {
          rejectedMetric = result;
        },
      })
      .executeDue();
    expect(rejected.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'failed_terminal',
      lastErrorCode: 'ACTION_DISPATCH_REJECTED',
    });
    expect(rejectedMetric).toBe('rejected');
    expect(rejected.triggerCount).toBe(0);

    const ambiguous = setup();
    const failedAfterPossibleDispatch: ProviderAdapter = {
      ...ambiguous.adapter,
      triggerWindow: () =>
        Promise.resolve({
          status: 'failed',
          occurredAt: ambiguous.clock.now().toISOString(),
          errorCode: 'REMOTE_RESPONSE_LOST',
        }),
    };
    await ambiguous
      .executor({ adapters: new Map([['fake', failedAfterPossibleDispatch]]) })
      .executeDue();
    expect(ambiguous.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'uncertain',
      lastErrorCode: 'REMOTE_RESPONSE_LOST',
    });
    expect(ambiguous.triggerCount).toBe(0);
  });

  it('moves a claimed intent to failed_retryable for a definitely pre-dispatch result', async () => {
    const context = setup();
    let dispatches = 0;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: () => {
        dispatches += 1;
        return Promise.resolve({
          status: 'failed',
          occurredAt: context.clock.now().toISOString(),
          errorCode: 'PROCESS_START_FAILED',
        });
      },
    };

    await context
      .executor({ adapters: new Map([['fake', adapter]]), retryDelayMs: 5_000 })
      .executeDue();

    expect(dispatches).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'failed_retryable',
      notBeforeMs: context.clock.now().getTime() + 5_000,
      lastErrorCode: 'PROCESS_START_FAILED',
    });
  });

  it('suppresses duplicate claim history when a retryable pre-dispatch action is retried', async () => {
    const context = setup();
    let dispatches = 0;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: () => {
        dispatches += 1;
        return Promise.resolve({
          status: 'failed',
          occurredAt: context.clock.now().toISOString(),
          errorCode: 'PROCESS_START_FAILED',
        });
      },
    };
    const executor = context.executor({ adapters: new Map([['fake', adapter]]) });

    await executor.executeDue();
    context.clock.advanceMs(5_000);
    await executor.executeDue();

    expect(dispatches).toBe(2);
    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'failed_retryable',
      attemptCount: 2,
    });
    expect(
      context.repositories.events
        .list('fake', { limit: 200 })
        .filter((event) => event.type === 'action_intent_claimed'),
    ).toHaveLength(1);
  });

  it('treats an unclassified dispatch exception as uncertain rather than retryable', async () => {
    const context = setup();
    let triggerMetric: string | undefined;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: () => Promise.reject(new Error('synthetic transport failure')),
    };

    await context
      .executor({
        adapters: new Map([['fake', adapter]]),
        onTrigger: (_providerId, result) => {
          triggerMetric = result;
        },
      })
      .executeDue();

    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'uncertain',
      lastErrorCode: 'ACTION_DISPATCH_UNCERTAIN',
    });
    expect(triggerMetric).toBe('uncertain');
    expect(context.triggerCount).toBe(0);
  });

  it('maps a known pre-dispatch exception to retryable after claim', async () => {
    const context = setup();
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: () => {
        return Promise.reject(
          Object.assign(new Error('provider unavailable before send'), {
            code: 'PROVIDER_NOT_AVAILABLE',
          }),
        );
      },
    };

    await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();

    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'failed_retryable',
      lastErrorCode: 'PROVIDER_NOT_AVAILABLE',
    });
  });

  it('keeps a timeout after possible dispatch uncertain and never retries the turn', async () => {
    const context = setup();
    let dispatches = 0;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      triggerWindow: () => {
        dispatches += 1;
        return Promise.reject(Object.assign(new Error('response timeout'), { code: 'ETIMEDOUT' }));
      },
    };

    await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();
    await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();

    expect(dispatches).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'uncertain',
      lastErrorCode: 'ETIMEDOUT',
    });
  });

  it('recovers a crash after claim without dispatching', async () => {
    const context = setup();
    let crashed = false;
    const onPhase = (phase: ActionExecutorPhase) => {
      if (phase === 'after_claim' && !crashed) {
        crashed = true;
        throw new Error('simulated crash after claim');
      }
    };

    await expect(context.executor({ onPhase }).executeDue()).rejects.toThrow('simulated crash');
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('executing');
    await context.executor().executeDue();

    expect(context.triggerCount).toBe(0);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('uncertain');
  });

  it('recovers a crash immediately before dispatch without dispatching', async () => {
    const context = setup();
    let crashed = false;
    const onPhase = (phase: ActionExecutorPhase) => {
      if (phase === 'before_dispatch' && !crashed) {
        crashed = true;
        throw new Error('simulated crash before dispatch');
      }
    };

    await expect(context.executor({ onPhase }).executeDue()).rejects.toThrow(
      'simulated crash before dispatch',
    );
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('executing');
    await context.executor().executeDue();
    expect(context.triggerCount).toBe(0);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('uncertain');
  });

  it('recovers a side effect after a crash before result persistence', async () => {
    const context = setup();
    let crashed = false;
    const onPhase = (phase: ActionExecutorPhase) => {
      if (phase === 'after_dispatch_before_result' && !crashed) {
        crashed = true;
        throw new Error('simulated crash after dispatch');
      }
    };

    await expect(context.executor({ onPhase }).executeDue()).rejects.toThrow('simulated crash');
    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('executing');
    await context.executor().executeDue();

    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
  });

  it('recovers a persisted succeeded result when confirmation crashes', async () => {
    const context = setup();
    let crashed = false;
    const onPhase = (phase: ActionExecutorPhase) => {
      if (phase === 'after_succeeded_before_confirmation' && !crashed) {
        crashed = true;
        throw new Error('simulated confirmation crash');
      }
    };

    await expect(context.executor({ onPhase }).executeDue()).rejects.toThrow(
      'simulated confirmation crash',
    );
    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('succeeded');
    await context.executor().executeDue();

    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
  });

  it('turns a failed confirmation into uncertain and later confirms by observation', async () => {
    const context = setup();
    let inspections = 0;
    const adapter: ProviderAdapter = {
      ...context.adapter,
      inspect: async (ctx) => {
        inspections += 1;
        if (inspections === 2)
          throw Object.assign(new Error('confirmation timeout'), { code: 'ETIMEDOUT' });
        return context.fake.inspect(ctx);
      },
    };

    await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('uncertain');
    await context.executor({ adapters: new Map([['fake', adapter]]) }).executeDue();

    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
  });

  it('recovers a crash during confirmation without redispatching', async () => {
    const context = setup();
    let crashed = false;
    const onPhase = (phase: ActionExecutorPhase) => {
      if (phase === 'during_confirmation' && !crashed) {
        crashed = true;
        throw new Error('simulated confirmation crash');
      }
    };

    await expect(context.executor({ onPhase }).executeDue()).rejects.toThrow(
      'simulated confirmation crash',
    );
    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('succeeded');
    await context.executor().executeDue();
    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
  });

  it('does not dispatch when preflight is unavailable and allows a later safe retry', async () => {
    const context = setup();
    context.fake.setInspectionFailure('UNAVAILABLE');
    await context.executor().executeDue();
    expect(context.repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'failed_retryable',
      lastErrorCode: 'PROVIDER_UNAVAILABLE',
    });
    expect(context.triggerCount).toBe(0);

    context.clock.advanceMs(5_000);
    context.fake.setInspectionFailure();
    await context.executor().executeDue();
    expect(context.triggerCount).toBe(1);
    expect(context.repositories.actionIntents.get('intent-1')?.state).toBe('confirmed');
  });
});
