import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { ActionExecutor, type ActionExecutorPhase } from '../../src/scheduler/action-executor.js';
import { FakeClock } from '../../src/scheduler/clock.js';
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
  options: { triggerResult?: 'succeeded' | 'failed' | 'uncertain' | 'rejected' } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-executor-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock('2026-09-14T08:00:00.000Z');
  const fake = new FakeProvider(clock, {
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
  repositories.providers.upsert(provider);
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
  repositories.schedulePolicies.upsert(policy);
  const intent: ActionIntentRecord = {
    id: 'intent-1',
    providerId: 'fake',
    policyId: 'policy-1',
    actionType: 'trigger_window',
    dedupeKey: 'fake:trigger_window:policy-1:2026-09-14T08:00:00.000Z',
    state: 'planned',
    scheduledForMs: nowMs,
    notBeforeMs: null,
    expiresAtMs: nowMs + 30_000,
    attemptCount: 0,
    reasonCode: 'TARGET_RESET_WINDOW_MATCH',
    explanation: { windowKind: 'five_hour', reasonCode: 'TARGET_RESET_WINDOW_MATCH' },
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
    get triggerCount() {
      return triggerCount;
    },
    executor(extra: Partial<ConstructorParameters<typeof ActionExecutor>[0]> = {}) {
      return new ActionExecutor({
        clock,
        db,
        repositories,
        adapters: new Map([['fake', adapter]]),
        ...extra,
      });
    },
  };
}

describe('ActionExecutor', () => {
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

    const report = await context.executor().executeDue();

    expect(report.confirmedIntentIds).toEqual(['intent-1']);
    expect(context.triggerCount).toBe(1);
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

  it('skips expired, already-satisfied, and unsupported intents without dispatch', async () => {
    const expired = setup();
    expired.clock.advanceMs(31_000);
    await expired.executor().executeDue();
    expect(expired.repositories.actionIntents.get('intent-1')?.state).toBe('skipped');
    expect(expired.triggerCount).toBe(0);

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
