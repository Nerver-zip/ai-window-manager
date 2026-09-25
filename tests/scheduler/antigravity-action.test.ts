import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AntigravityProvider } from '../../src/providers/antigravity/provider.js';
import { ActionExecutor } from '../../src/scheduler/action-executor.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';
import { scriptedProcessFactory } from '../providers/antigravity/support.js';

const groups = [
  {
    name: 'Gemini Models',
    windows: [
      ['antigravity_gemini_five_hour', '5h'],
      ['antigravity_gemini_weekly', 'weekly'],
    ] as const,
  },
  {
    name: 'Claude and GPT Models',
    windows: [
      ['antigravity_claude_gpt_five_hour', '5h'],
      ['antigravity_claude_gpt_weekly', 'weekly'],
    ] as const,
  },
];

const targets = [
  ['antigravity_gemini_five_hour', 'gemini-3.8-flash-low'],
  ['antigravity_gemini_weekly', 'gemini-3.8-flash-low'],
  ['antigravity_claude_gpt_five_hour', 'claude-sonnet-4-6'],
  ['antigravity_claude_gpt_weekly', 'claude-sonnet-4-6'],
] as const;

const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function usageOutput(targetWindowKind: string, targetActive: boolean): string {
  return JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: groups.map((group) => ({
          name: group.name,
          buckets: group.windows.map(([windowKind, window]) => ({
            id: windowKind,
            window,
            remaining_fraction: windowKind === targetWindowKind ? (targetActive ? 0.99 : 1) : 0.5,
          })),
        })),
      },
    },
  });
}

function setup(targetWindowKind: string, triggerOutput: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-agy-action-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock('2026-09-24T12:00:00.000Z');
  const nowMs = clock.now().getTime();
  let targetActive = false;
  let dispatchCount = 0;
  let dispatchedArgs: string[] = [];
  const activationOnDispatch =
    (JSON.parse(triggerOutput) as { status?: unknown }).status === 'SUCCESS';
  const adapter = new AntigravityProvider({
    id: 'antigravity',
    executable: '/opt/antigravity/bin/agy',
    triggerEnabled: true,
    actionTimeoutSeconds: 30,
    triggerModels: {
      gemini: 'gemini-3.8-flash-low',
      claudeGpt: 'claude-sonnet-4-6',
    },
    now: () => clock.now(),
    spawnProcess: scriptedProcessFactory((process, args) => {
      if (args[1] === '/usage') {
        process.complete(usageOutput(targetWindowKind, targetActive));
      } else {
        dispatchCount += 1;
        dispatchedArgs = args;
        process.complete(triggerOutput);
        if (activationOnDispatch) targetActive = true;
      }
    }),
  });
  repositories.providers.upsert({
    id: 'antigravity',
    kind: 'antigravity',
    enabled: true,
    mode: 'automation',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  repositories.schedulePolicies.upsert({
    id: targetWindowKind.startsWith('antigravity_claude_gpt_')
      ? 'activation-antigravity-claude-gpt'
      : 'activation-antigravity-gemini',
    providerId: 'antigravity',
    scope: targetWindowKind.startsWith('antigravity_claude_gpt_') ? 'claude_gpt' : 'gemini',
    kind: 'auto',
    enabled: true,
    timezone: 'UTC',
    config: { windowKind: targetWindowKind },
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  repositories.actionIntents.createIfAbsent({
    id: 'agy-intent',
    providerId: 'antigravity',
    policyId: targetWindowKind.startsWith('antigravity_claude_gpt_')
      ? 'activation-antigravity-claude-gpt'
      : 'activation-antigravity-gemini',
    actionType: 'trigger_window',
    dedupeKey: `antigravity:trigger_window:${targetWindowKind.startsWith('antigravity_claude_gpt_') ? 'activation-antigravity-claude-gpt' : 'activation-antigravity-gemini'}:${targetWindowKind}:cycle-1`,
    state: 'planned',
    scheduledForMs: nowMs,
    notBeforeMs: null,
    expiresAtMs: nowMs + 60_000,
    attemptCount: 0,
    reasonCode: 'TARGET_RESET_WINDOW_MATCH',
    explanation: {
      windowKind: targetWindowKind,
      policyUpdatedAtMs: nowMs,
    },
    lastErrorCode: null,
    createdAtMs: nowMs,
    startedAtMs: null,
    finishedAtMs: null,
    updatedAtMs: nowMs,
  });
  resources.push({ db, dir });
  const executor = new ActionExecutor({
    clock,
    db,
    repositories,
    adapters: new Map([['antigravity', adapter]]),
  });

  return {
    db,
    repositories,
    executor,
    setTargetActive(value: boolean) {
      targetActive = value;
    },
    get dispatchCount() {
      return dispatchCount;
    },
    get dispatchedArgs() {
      return dispatchedArgs;
    },
  };
}

describe('Antigravity trigger through the durable executor', () => {
  it.each(targets)(
    'dispatches and confirms only %s through the selected model',
    async (windowKind, expectedModel) => {
      const context = setup(
        windowKind,
        JSON.stringify({ status: 'SUCCESS', response: 'Hello.', num_turns: 1 }),
      );

      const report = await context.executor.executeDue();

      expect(report.confirmedIntentIds).toEqual(['agy-intent']);
      expect(context.dispatchCount).toBe(1);
      expect(context.dispatchedArgs).toEqual([
        '-p',
        'Hi!',
        '--model',
        expectedModel,
        '--output-format',
        'json',
        '--print-timeout',
        '30s',
        '--sandbox',
      ]);
      expect(context.repositories.actionIntents.get('agy-intent')).toMatchObject({
        state: 'confirmed',
        attemptCount: 1,
      });
    },
  );

  it('does not retry an authentication-looking result after spawn and confirms only by later observation', async () => {
    const context = setup(
      'antigravity_gemini_weekly',
      JSON.stringify({
        status: 'ERROR',
        error: 'Authentication required before the prompt could run.',
      }),
    );

    await expect(context.executor.executeDue()).resolves.toMatchObject({
      uncertainIntentIds: ['agy-intent'],
    });
    expect(context.repositories.actionIntents.get('agy-intent')?.state).toBe('uncertain');

    await context.executor.executeDue();
    expect(context.dispatchCount).toBe(1);

    context.setTargetActive(true);
    await expect(context.executor.executeDue()).resolves.toMatchObject({
      confirmedIntentIds: ['agy-intent'],
    });
    expect(context.repositories.actionIntents.get('agy-intent')?.state).toBe('confirmed');
    expect(context.dispatchCount).toBe(1);
  });

  it('skips a durable intent when the persisted family no longer matches its canonical policy', async () => {
    const context = setup(
      'antigravity_gemini_five_hour',
      JSON.stringify({ status: 'SUCCESS', response: 'Hello.', num_turns: 1 }),
    );
    const policy = context.repositories.schedulePolicies.get('activation-antigravity-gemini');
    if (!policy) throw new Error('Gemini policy missing');
    context.repositories.schedulePolicies.upsert({ ...policy, scope: 'claude_gpt' });

    const report = await context.executor.executeDue();

    expect(report.skippedIntentIds).toEqual(['agy-intent']);
    expect(context.dispatchCount).toBe(0);
    expect(context.repositories.actionIntents.get('agy-intent')).toMatchObject({
      state: 'skipped',
      lastErrorCode: 'ACTION_POLICY_CHANGED',
    });
  });
});
