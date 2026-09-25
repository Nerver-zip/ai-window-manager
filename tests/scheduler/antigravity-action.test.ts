import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AntigravityProvider } from '../../src/providers/antigravity/provider.js';
import { ActionExecutor } from '../../src/scheduler/action-executor.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';
import {
  scriptedProcessFactory,
  streamingActionProcessFactory,
  SYNTHETIC_ANTIGRAVITY_CONVERSATION_ID,
} from '../providers/antigravity/support.js';

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

function usageOutput(activeWindowKinds: ReadonlySet<string>): string {
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
            remaining_fraction: activeWindowKinds.has(windowKind) ? 0.99 : 1,
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
  const activeWindowKinds = new Set<string>();
  let dispatchCount = 0;
  let dispatchedArgs: string[] = [];
  let dispatchedPrompt: string | undefined;
  const activationOnDispatch =
    (JSON.parse(triggerOutput) as { status?: unknown }).status === 'SUCCESS';
  const usageProcessFactory = scriptedProcessFactory((process) => {
    process.complete(usageOutput(activeWindowKinds));
  });
  const actionProcessFactory = streamingActionProcessFactory(
    triggerOutput,
    (input) => {
      const userEvent = input
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string; message?: { content?: string } })
        .find((event) => event.event === 'user');
      dispatchedPrompt = userEvent?.message?.content;
      if (dispatchedPrompt === 'Hi!') {
        dispatchCount += 1;
        if (activationOnDispatch) {
          const windowKinds = dispatchedArgs.includes('claude-sonnet-4-6')
            ? ['antigravity_claude_gpt_five_hour', 'antigravity_claude_gpt_weekly']
            : ['antigravity_gemini_five_hour', 'antigravity_gemini_weekly'];
          for (const windowKind of windowKinds) activeWindowKinds.add(windowKind);
        }
      }
    },
    SYNTHETIC_ANTIGRAVITY_CONVERSATION_ID,
  );
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
    spawnProcess: (executable, args, options) => {
      if (args[1] === '/usage') {
        return usageProcessFactory(executable, args, options);
      }
      dispatchedArgs = args;
      return actionProcessFactory(executable, args, options);
    },
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
  const addIntent = (id: string, windowKind: string): void => {
    const scope = windowKind.startsWith('antigravity_claude_gpt_') ? 'claude_gpt' : 'gemini';
    const policyId = `activation-antigravity-${scope === 'claude_gpt' ? 'claude-gpt' : 'gemini'}`;
    repositories.schedulePolicies.upsert({
      id: policyId,
      providerId: 'antigravity',
      scope,
      kind: 'auto',
      enabled: true,
      timezone: 'UTC',
      config: { windowKind },
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    repositories.actionIntents.createIfAbsent({
      id,
      providerId: 'antigravity',
      policyId,
      actionType: 'trigger_window',
      dedupeKey: `antigravity:trigger_window:${policyId}:${windowKind}:cycle-1`,
      state: 'planned',
      scheduledForMs: nowMs,
      notBeforeMs: null,
      expiresAtMs: nowMs + 60_000,
      attemptCount: 0,
      reasonCode: 'TARGET_RESET_WINDOW_MATCH',
      explanation: { windowKind, policyUpdatedAtMs: nowMs },
      lastErrorCode: null,
      createdAtMs: nowMs,
      startedAtMs: null,
      finishedAtMs: null,
      updatedAtMs: nowMs,
    });
  };
  addIntent('agy-intent', targetWindowKind);
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
    addIntent,
    setTargetActive(value: boolean) {
      if (value) activeWindowKinds.add(targetWindowKind);
      else activeWindowKinds.delete(targetWindowKind);
    },
    get dispatchCount() {
      return dispatchCount;
    },
    get dispatchedArgs() {
      return dispatchedArgs;
    },
    get dispatchedPrompt() {
      return dispatchedPrompt;
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
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--model',
        expectedModel,
        '--print-timeout',
        '30s',
        '--sandbox',
      ]);
      expect(context.dispatchedPrompt).toBe('Hi!');
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

  it('serializes Gemini and Claude/GPT actions across ticks', async () => {
    const context = setup(
      'antigravity_gemini_five_hour',
      JSON.stringify({ status: 'SUCCESS', response: 'Hello.', num_turns: 1 }),
    );
    context.addIntent('agy-z-claude-intent', 'antigravity_claude_gpt_five_hour');

    const first = await context.executor.executeDue();
    expect(first.confirmedIntentIds).toEqual(['agy-intent']);
    expect(context.repositories.actionIntents.get('agy-z-claude-intent')?.state).toBe('planned');
    expect(context.dispatchCount).toBe(1);

    const next = await context.executor.executeDue();
    expect(next.confirmedIntentIds).toEqual(['agy-z-claude-intent']);
    expect(context.repositories.actionIntents.get('agy-z-claude-intent')).toMatchObject({
      state: 'confirmed',
      attemptCount: 1,
    });
    expect(context.dispatchCount).toBe(2);
    expect(context.dispatchedArgs).toContain('claude-sonnet-4-6');
  });
});
