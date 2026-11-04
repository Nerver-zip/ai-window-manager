import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_FIVE_HOUR_WINDOW,
  CLAUDE_CODE_SEVEN_DAY_WINDOW,
  ClaudeCodeProvider,
  type ClaudeCodeProviderOptions,
} from '../../../src/providers/claude-code/index.js';
import { DispatchAuthorizationError } from '../../../src/providers/dispatch-authorization.js';
import {
  INIT_EVENT,
  USAGE_RESULT,
  authStatus,
  fakeClaude,
  meter,
  usageMessage,
  usageReport,
  usageRun,
  type FakeScript,
} from './support.js';

const NOW = '2026-11-03T12:00:00.000Z';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'awm-claude-test-'));
  directories.push(directory);
  return directory;
}

function provider(
  scripts: FakeScript[],
  options: Partial<ClaudeCodeProviderOptions> = {},
): { adapter: ClaudeCodeProvider; spawn: ReturnType<typeof fakeClaude> } {
  const root = tempDirectory();
  const spawn = fakeClaude(scripts);
  const adapter = new ClaudeCodeProvider({
    configDirectory: path.join(root, 'state'),
    workspaceDirectory: path.join(root, 'workspace'),
    executable: '/opt/claude-code/bin/claude',
    now: () => new Date(NOW),
    spawnProcess: spawn,
    ...options,
  });
  return { adapter, spawn };
}

const request = {
  intentId: 'intent-1',
  dedupeKey: 'claude_code:trigger_window:manual:claude_code_five_hour:1',
  reasonCode: 'MANUAL_TRIGGER_REQUESTED',
  windowKind: CLAUDE_CODE_FIVE_HOUR_WINDOW,
};

describe('ClaudeCodeProvider capabilities', () => {
  it('is monitor-only unless the explicit trigger gate is enabled', () => {
    const { adapter } = provider([]);
    expect(adapter.id).toBe('claude_code');
    const capabilities = adapter.capabilities();
    expect(capabilities.usageRead).toMatchObject({
      supported: true,
      contract: 'official_supported',
    });
    expect(capabilities.resetRead).toMatchObject({
      supported: true,
      contract: 'official_supported',
    });
    expect(capabilities.windowTrigger).toMatchObject({
      supported: false,
      contract: 'unknown',
      consumesQuota: true,
    });
    expect(adapter.capabilities().windowTrigger.supportedWindowKinds).toBeUndefined();
  });

  it('advertises only the exact five-hour target when enabled', () => {
    const { adapter } = provider([], { triggerEnabled: true });
    expect(adapter.capabilities().windowTrigger).toMatchObject({
      supported: true,
      contract: 'official_supported',
      consumesQuota: true,
      supportedWindowKinds: [CLAUDE_CODE_FIVE_HOUR_WINDOW],
    });
    expect(adapter.capabilities().windowTrigger.notes).toContain('weekly');
  });

  it('validates construction options', () => {
    const base = { configDirectory: '/tmp/awm-claude-state' };
    expect(() => new ClaudeCodeProvider({ configDirectory: ' ' })).toThrow(/configDirectory/);
    expect(() => new ClaudeCodeProvider({ ...base, readTimeoutMs: 0 })).toThrow(/readTimeoutMs/);
    expect(() => new ClaudeCodeProvider({ ...base, actionTimeoutMs: 120_001 })).toThrow(
      /actionTimeoutMs/,
    );
    expect(() => new ClaudeCodeProvider({ ...base, triggerModel: 'gpt-5' })).toThrow(
      /triggerModel/,
    );
    expect(() => new ClaudeCodeProvider({ ...base, id: 'Bad Id' })).toThrow();
    expect(new ClaudeCodeProvider({ ...base, triggerModel: 'claude-haiku-5-5' }).id).toBe(
      'claude_code',
    );
  });
});

describe('ClaudeCodeProvider usage reads', () => {
  it('runs only the isolated official /usage local command with a sanitized environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'synthetic-test-key-not-real';
    try {
      const { adapter, spawn } = provider([usageRun([meter({})])]);
      await adapter.inspect({});
      const invocation = spawn.invocations[0]!;
      expect(invocation.executable).toBe('/opt/claude-code/bin/claude');
      expect(invocation.args).toEqual([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '/usage',
      ]);
      expect(invocation.args).not.toContain('--model');
      expect(invocation.options).toMatchObject({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const env = invocation.options.env!;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBe(env.HOME);
      expect(env).toMatchObject({
        DISABLE_AUTOUPDATER: '1',
        DISABLE_UPDATES: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
      });
      expect(String(invocation.options.cwd)).toMatch(/workspace$/);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('normalizes the five-hour and weekly meters into stable distinct windows', async () => {
    const { adapter } = provider([
      usageRun([
        meter({ percent: 25, resets_at: '2026-11-03T15:00:00Z' }),
        meter({
          kind: 'weekly_all',
          group: 'weekly',
          percent: 40.5,
          resets_at: '2026-11-07T09:00:00.000+00:00',
        }),
      ]),
    ]);

    const observation = await adapter.inspect({});

    expect(observation).toMatchObject({
      providerId: 'claude_code',
      health: 'UP',
      observedAt: NOW,
      staleAfterSeconds: 600,
    });
    expect(observation.windows.map((window) => window.windowKind)).toEqual([
      CLAUDE_CODE_FIVE_HOUR_WINDOW,
      CLAUDE_CODE_SEVEN_DAY_WINDOW,
    ]);
    expect(observation.windows[0]).toMatchObject({
      phase: { value: 'ACTIVE', source: 'inferred', confidence: 'high' },
      durationSeconds: { value: 18_000, source: 'official_supported', confidence: 'high' },
      resetAt: { value: '2026-11-03T15:00:00.000Z', source: 'official_supported' },
      usageRatio: { value: 0.25, source: 'official_supported', confidence: 'exact' },
      remainingRatio: { value: 0.75, source: 'inferred' },
      startedAt: { value: '2026-11-03T10:00:00.000Z', confidence: 'medium' },
    });
    expect(observation.windows[1]).toMatchObject({
      phase: { value: 'ACTIVE', confidence: 'high' },
      durationSeconds: { value: 604_800 },
      resetAt: { value: '2026-11-07T09:00:00.000Z' },
      usageRatio: { value: 0.405 },
    });
    await expect(adapter.health({})).resolves.toBe('UP');
    expect(JSON.stringify(observation)).not.toContain('synthetic');
  });

  it('accepts the live authenticated row shape observed on 2026-11-03 (synthetic values)', async () => {
    const { adapter } = provider([
      {
        lines: [
          INIT_EVENT,
          usageMessage({
            session: {
              total_cost_usd: 0,
              total_api_duration_ms: 0,
              total_duration_ms: 0,
              total_lines_added: 0,
              total_lines_removed: 0,
              model_usage: {},
            },
            rate_limits: {
              limits: [
                {
                  kind: 'session',
                  group: 'session',
                  percent: 31,
                  resets_at: '2026-11-03T16:10:00.123456+00:00',
                  scope: null,
                  severity: 'normal',
                  is_active: true,
                },
                {
                  kind: 'weekly_all',
                  group: 'weekly',
                  percent: 9,
                  resets_at: '2026-11-06T13:00:00+00:00',
                  scope: null,
                  severity: 'normal',
                  is_active: false,
                },
              ],
              extra_usage: {
                is_enabled: false,
                monthly_limit: null,
                used_credits: null,
                utilization: null,
              },
            },
          }),
          USAGE_RESULT,
        ],
      },
    ]);
    const observation = await adapter.inspect({});
    expect(observation.health).toBe('UP');
    expect(observation.windows.map((window) => [window.windowKind, window.phase.value])).toEqual([
      [CLAUDE_CODE_FIVE_HOUR_WINDOW, 'ACTIVE'],
      [CLAUDE_CODE_SEVEN_DAY_WINDOW, 'ACTIVE'],
    ]);
    expect(observation.windows[0]?.resetAt?.value).toBe('2026-11-03T16:10:00.123Z');
  });

  it.each([
    {
      label: 'exhausted allowance',
      meter: meter({ percent: 100 }),
      phase: { value: 'EXHAUSTED', confidence: 'high' },
      usage: 1,
    },
    {
      label: 'over-cap utilization clamps to exhausted',
      meter: meter({ percent: 104 }),
      phase: { value: 'EXHAUSTED', confidence: 'high' },
      usage: 1,
    },
    {
      label: 'zero use with a future reset stays unknown for temporal evidence',
      meter: meter({ percent: 0 }),
      phase: { value: 'UNKNOWN', source: 'inferred', confidence: 'unknown' },
      usage: 0,
    },
    {
      label: 'zero-use session without a reset is actionable as never started',
      meter: meter({ percent: 0, resets_at: null }),
      phase: { value: 'INACTIVE', source: 'inferred', confidence: 'high' },
      usage: 0,
    },
    {
      label: 'zero-use weekly meter without a reset remains medium confidence',
      meter: meter({ kind: 'weekly_all', group: 'weekly', percent: 0, resets_at: null }),
      phase: { value: 'INACTIVE', source: 'inferred', confidence: 'medium' },
      usage: 0,
    },
    {
      label: 'zero-use scoped session without a reset remains medium confidence',
      meter: meter({
        percent: 0,
        resets_at: null,
        scope: { model: { display_name: 'Sonnet' } },
      }),
      phase: { value: 'INACTIVE', source: 'inferred', confidence: 'medium' },
      usage: 0,
    },
    {
      label: 'consumption without a reset is inconsistent and unknown',
      meter: meter({ percent: 3, resets_at: null }),
      phase: { value: 'UNKNOWN', confidence: 'unknown' },
      usage: 0.03,
    },
  ])('classifies $label conservatively', async ({ meter: row, phase, usage }) => {
    const { adapter } = provider([usageRun([row])]);
    const [window] = (await adapter.inspect({})).windows;
    expect(window?.phase).toMatchObject(phase);
    expect(window?.usageRatio?.value).toBe(usage);
  });

  it('treats a reset at or before the read as RESET_DUE, never as a fresh allowance', async () => {
    const { adapter } = provider([usageRun([meter({ percent: 0, resets_at: NOW })])]);
    const [window] = (await adapter.inspect({})).windows;
    expect(window).toMatchObject({
      phase: { value: 'RESET_DUE', confidence: 'high' },
      resetAt: { value: NOW },
    });
    expect(window?.usageRatio).toBeUndefined();
    expect(window?.remainingRatio).toBeUndefined();
  });

  it('retains additional server meters without inventing cadence or scheduling semantics', async () => {
    const { adapter } = provider([
      usageRun([
        meter({}),
        meter({
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 12,
          scope: { model: { display_name: 'Sonnet' } },
        }),
        meter({ kind: 'Future Meter', group: 'other', percent: 1, resets_at: null }),
      ]),
    ]);
    const observation = await adapter.inspect({});
    expect(observation.windows.map((window) => window.windowKind)).toEqual([
      CLAUDE_CODE_FIVE_HOUR_WINDOW,
      'claude_code_weekly_scoped_sonnet',
      'claude_code_future_meter',
    ]);
    expect(observation.windows[1]).toMatchObject({
      phase: { value: 'UNKNOWN', source: 'unknown' },
      usageRatio: { value: 0.12 },
    });
    expect(observation.windows[1]?.durationSeconds).toBeUndefined();
    expect(observation.windows[2]?.resetAt).toBeUndefined();
  });

  it('rejects ambiguous window identities without guessing', async () => {
    const { adapter } = provider([usageRun([meter({}), meter({ percent: 30 })])]);
    expect(await adapter.inspect({})).toMatchObject({
      health: 'ERROR',
      summary: 'PROVIDER_WINDOW_IDENTITY_AMBIGUOUS',
      windows: [],
    });
  });

  it.each([
    {
      label: 'reset beyond the window duration',
      row: meter({ resets_at: '2026-11-03T19:00:01Z' }),
    },
    { label: 'non-ISO reset', row: meter({ resets_at: '1793750400' }) },
    { label: 'impossible reset date', row: meter({ resets_at: '2026-13-45T00:00:00Z' }) },
    { label: 'negative percentage', row: meter({ percent: -1 }) },
    { label: 'absurd percentage', row: meter({ percent: 5_000 }) },
    { label: 'non-numeric percentage', row: meter({ percent: '25' }) },
    { label: 'missing kind', row: { group: 'session', percent: 1, resets_at: null } },
  ])('fails closed on schema drift: $label', async ({ row }) => {
    const { adapter } = provider([usageRun([row])]);
    expect(await adapter.inspect({})).toMatchObject({
      health: 'ERROR',
      summary: 'CLAUDE_CODE_CONTRACT_CHANGED',
      windows: [],
    });
  });

  it('fails closed when the report shape changes or carries too many meters', async () => {
    const tooMany = Array.from({ length: 33 }, (_, index) =>
      meter({ kind: `meter_${index}`, resets_at: null, percent: 0 }),
    );
    const { adapter: many } = provider([usageRun(tooMany)]);
    expect((await many.inspect({})).summary).toBe('CLAUDE_CODE_CONTRACT_CHANGED');

    const { adapter: shape } = provider([
      { lines: [INIT_EVENT, usageMessage({ rate_limits: 'nope' }), USAGE_RESULT] },
    ]);
    expect((await shape.inspect({})).summary).toBe('CLAUDE_CODE_CONTRACT_CHANGED');
  });

  it('reports a degraded reading when the server returns no meters', async () => {
    const { adapter } = provider([usageRun([])]);
    expect(await adapter.inspect({})).toMatchObject({
      health: 'DEGRADED',
      summary: 'CLAUDE_CODE_NO_USAGE_WINDOWS',
    });
  });

  it.each([
    {
      label: 'model-produced message (not the local command)',
      lines: [INIT_EVENT, { type: 'assistant', message: { content: [] } }, USAGE_RESULT],
      summary: 'CLAUDE_CODE_CONTRACT_CHANGED',
    },
    {
      label: 'result that reports a model turn',
      lines: [
        INIT_EVENT,
        usageMessage(usageReport([meter({})])),
        { ...USAGE_RESULT, num_turns: 1 },
      ],
      summary: 'CLAUDE_CODE_OUTPUT_INVALID',
    },
    {
      label: 'error result',
      lines: [
        INIT_EVENT,
        usageMessage(usageReport([meter({})])),
        { ...USAGE_RESULT, is_error: true },
      ],
      summary: 'CLAUDE_CODE_OUTPUT_INVALID',
    },
    {
      label: 'missing result',
      lines: [INIT_EVENT, usageMessage(usageReport([meter({})]))],
      summary: 'CLAUDE_CODE_OUTPUT_INVALID',
    },
    {
      label: 'duplicate usage messages',
      lines: [
        INIT_EVENT,
        usageMessage(usageReport([meter({})])),
        usageMessage(usageReport([meter({})])),
        USAGE_RESULT,
      ],
      summary: 'CLAUDE_CODE_OUTPUT_INVALID',
    },
    {
      label: 'malformed JSON line',
      lines: [INIT_EVENT, '{not json', USAGE_RESULT],
      summary: 'CLAUDE_CODE_OUTPUT_INVALID',
    },
    {
      label: 'non-object JSON line',
      lines: [INIT_EVENT, '[1,2]', USAGE_RESULT],
      summary: 'CLAUDE_CODE_OUTPUT_INVALID',
    },
    {
      label: 'init envelope drift',
      lines: [{ type: 'system', subtype: 'init', tools: 'all' }, USAGE_RESULT],
      summary: 'CLAUDE_CODE_CONTRACT_CHANGED',
    },
    {
      label: 'result envelope drift',
      lines: [INIT_EVENT, usageMessage(usageReport([meter({})])), { type: 'result' }],
      summary: 'CLAUDE_CODE_CONTRACT_CHANGED',
    },
  ])('rejects a $label', async ({ lines, summary }) => {
    const { adapter } = provider([{ lines, exitCode: 0 }]);
    expect(await adapter.inspect({})).toMatchObject({ health: 'ERROR', summary, windows: [] });
  });

  it('rejects a nonzero exit even with a plausible report', async () => {
    const { adapter } = provider([{ ...usageRun([meter({})]), exitCode: 1 }]);
    expect((await adapter.inspect({})).summary).toBe('CLAUDE_CODE_OUTPUT_INVALID');
  });

  it('ignores unrelated stream events and unknown fields', async () => {
    const { adapter } = provider([
      {
        lines: [
          { ...INIT_EVENT, future_field: true },
          { type: 'system', subtype: 'hook_started' },
          usageMessage({ ...usageReport([meter({ future: 1 })]), extra: {} }),
          USAGE_RESULT,
        ],
      },
    ]);
    expect((await adapter.inspect({})).health).toBe('UP');
  });

  it('classifies a missing report through the official auth status', async () => {
    const cases: Array<[FakeScript, string, string]> = [
      [
        authStatus({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, 1),
        'AUTH_REQUIRED',
        'CLAUDE_CODE_AUTH_REQUIRED',
      ],
      [
        authStatus({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }),
        'AUTH_REQUIRED',
        'CLAUDE_CODE_SUBSCRIPTION_REQUIRED',
      ],
      [
        authStatus({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: 'operator@example.invalid',
          orgId: '00000000-0000-4000-8000-000000000001',
          subscriptionType: 'pro',
        }),
        'DEGRADED',
        'CLAUDE_CODE_USAGE_UNAVAILABLE',
      ],
      [{ lines: ['not json'], exitCode: 0 }, 'ERROR', 'CLAUDE_CODE_AUTH_STATUS_UNKNOWN'],
    ];
    for (const [auth, health, summary] of cases) {
      const { adapter, spawn } = provider([
        { lines: [INIT_EVENT, usageMessage(), USAGE_RESULT] },
        auth,
      ]);
      expect(await adapter.inspect({})).toMatchObject({ health, summary, windows: [] });
      expect(spawn.invocations[1]?.args).toEqual(['auth', 'status', '--json']);
    }

    const { adapter: nullRows } = provider([
      { lines: [INIT_EVENT, usageMessage(usageReport(null)), USAGE_RESULT] },
      authStatus({ loggedIn: false }, 1),
    ]);
    expect((await nullRows.inspect({})).summary).toBe('CLAUDE_CODE_AUTH_REQUIRED');

    const { adapter: nullRateLimits } = provider([
      { lines: [INIT_EVENT, usageMessage({ rate_limits: null }), USAGE_RESULT] },
      authStatus({ loggedIn: false }, 1),
    ]);
    expect((await nullRateLimits.inspect({})).summary).toBe('CLAUDE_CODE_AUTH_REQUIRED');
  });

  it('maps process failures to bounded unavailable observations', async () => {
    const { adapter: missing } = provider([{ spawnError: true }]);
    expect(await missing.inspect({})).toMatchObject({
      health: 'UNAVAILABLE',
      summary: 'CLAUDE_CODE_EXECUTABLE_UNAVAILABLE',
    });
    await expect(missing.health({})).resolves.toBe('UNAVAILABLE');

    const { adapter: thrown } = provider([{ throwOnSpawn: true }]);
    expect((await thrown.inspect({})).summary).toBe('CLAUDE_CODE_EXECUTABLE_UNAVAILABLE');

    const { adapter: slow, spawn } = provider([{ hang: true }], { readTimeoutMs: 20 });
    expect(await slow.inspect({})).toMatchObject({
      health: 'UNAVAILABLE',
      summary: 'CLAUDE_CODE_PROVIDER_TIMEOUT',
    });
    expect(spawn.children[0]?.kills).toContain('SIGTERM');

    const controller = new AbortController();
    const { adapter: aborted } = provider([{ hang: true }]);
    const pending = aborted.inspect({ signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    expect((await pending).summary).toBe('CLAUDE_CODE_PROVIDER_UNAVAILABLE');

    const preAborted = new AbortController();
    preAborted.abort();
    const { adapter: early } = provider([usageRun([meter({})])]);
    expect((await early.inspect({ signal: preAborted.signal })).summary).toBe(
      'CLAUDE_CODE_PROVIDER_UNAVAILABLE',
    );

    const { adapter: noisy } = provider([{ raw: 'x'.repeat(600 * 1024) }]);
    expect((await noisy.inspect({})).summary).toBe('CLAUDE_CODE_OUTPUT_INVALID');
  });

  it('fails closed on an invalid clock', async () => {
    const { adapter } = provider([usageRun([meter({})])], { now: () => new Date(Number.NaN) });
    expect((await adapter.inspect({})).health).toBe('ERROR');
    let calls = 0;
    const { adapter: late } = provider([usageRun([meter({})])], {
      now: () => (calls++ === 0 ? new Date(NOW) : new Date(Number.NaN)),
    });
    expect((await late.inspect({})).summary).toBe('CLAUDE_CODE_OUTPUT_INVALID');
  });

  it('normalizes against the completion time of the official read', async () => {
    const times = ['2026-11-03T12:00:00.000Z', '2026-11-03T12:00:07.000Z'];
    const { adapter } = provider([usageRun([meter({})])], {
      now: () => new Date(times.shift() ?? '2026-11-03T12:00:07.000Z'),
    });
    expect((await adapter.inspect({})).observedAt).toBe('2026-11-03T12:00:07.000Z');
  });
});

describe('ClaudeCodeProvider auth status', () => {
  it('returns only a one-way account fingerprint and a sanitized plan label', async () => {
    const identity = {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'Operator@Example.invalid',
      orgId: '00000000-0000-4000-8000-000000000001',
      subscriptionType: 'Max',
    };
    const { adapter } = provider([
      authStatus(identity),
      authStatus({ ...identity, email: 'operator@example.invalid ' }),
    ]);
    const first = await adapter.authStatus();
    const second = await adapter.authStatus();
    expect(first).toMatchObject({ state: 'authenticated', subscriptionType: 'max' });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/example|0000-4000/i);
  });

  it('treats unusual or unverifiable output as unknown', async () => {
    const cases: FakeScript[] = [
      authStatus({ loggedIn: false }, 0),
      authStatus({ loggedIn: true, authMethod: 'claude.ai' }, 1),
      authStatus({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.invalid' }),
      authStatus({ loggedIn: 'yes' }),
      authStatus({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'bedrock',
        email: 'a@b.invalid',
        orgId: 'org',
      }),
      { spawnError: true },
      { hang: true },
    ];
    const expected = [
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unsupported_auth',
      'unknown',
      'unknown',
    ];
    for (const [index, script] of cases.entries()) {
      const { adapter } = provider([script]);
      const pending = adapter.authStatus(AbortSignal.timeout(50));
      expect((await pending).state).toBe(expected[index]);
    }
    const { adapter: plan } = provider([
      authStatus({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'a@b.invalid',
        orgId: 'org',
        subscriptionType: 'pro plan!',
      }),
    ]);
    expect(await plan.authStatus()).toMatchObject({ subscriptionType: null });
  });
});

describe('ClaudeCodeProvider trigger', () => {
  const success: FakeScript = {
    lines: [
      INIT_EVENT,
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello there' }] } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_api_ms: 812 },
    ],
    exitCode: 0,
  };

  it('rejects requests while the gate is off or the target is not the five-hour window', async () => {
    const { adapter: off, spawn } = provider([success]);
    expect(await off.triggerWindow({}, request)).toMatchObject({
      status: 'rejected',
      errorCode: 'CLAUDE_CODE_TRIGGER_DISABLED',
    });
    const { adapter } = provider([success], { triggerEnabled: true });
    expect(
      await adapter.triggerWindow({}, { ...request, windowKind: CLAUDE_CODE_SEVEN_DAY_WINDOW }),
    ).toMatchObject({ status: 'rejected', errorCode: 'CLAUDE_CODE_TRIGGER_TARGET_UNSUPPORTED' });
    expect(await adapter.triggerWindow({}, { ...request, intentId: '' })).toMatchObject({
      status: 'rejected',
      errorCode: 'CLAUDE_CODE_TRIGGER_REQUEST_INVALID',
    });
    expect(spawn.invocations).toHaveLength(0);
  });

  it('sends exactly one fixed minimal non-agentic request after the dispatch gate', async () => {
    const order: string[] = [];
    const { adapter, spawn } = provider([success], { triggerEnabled: true });
    const result = await adapter.triggerWindow(
      { assertDispatchAllowed: () => order.push('gate') },
      request,
    );
    expect(result).toEqual({
      status: 'succeeded',
      occurredAt: NOW,
      confirmationHint: 'CLAUDE_CODE_TURN_COMPLETED',
    });
    expect(order).toEqual(['gate']);
    expect(spawn.invocations).toHaveLength(1);
    expect(spawn.invocations[0]?.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--max-turns',
      '1',
      '--disable-slash-commands',
      '--model',
      'haiku',
      'Hi!',
    ]);
    expect(spawn.invocations[0]?.args).not.toContain('--bare');
    expect(JSON.stringify(result)).not.toContain('Hello');
  });

  it('does not start the process when the executor gate refuses dispatch', async () => {
    const { adapter, spawn } = provider([success], { triggerEnabled: true });
    await expect(
      adapter.triggerWindow(
        {
          assertDispatchAllowed: () => {
            throw new DispatchAuthorizationError('POLICY_CHANGED');
          },
        },
        request,
      ),
    ).rejects.toBeInstanceOf(DispatchAuthorizationError);
    expect(spawn.invocations).toHaveLength(0);
  });

  it.each([
    {
      label: 'missing sign-in',
      script: {
        lines: [
          INIT_EVENT,
          { type: 'assistant', error: 'authentication_failed', is_api_error_message: true },
          { type: 'result', subtype: 'success', is_error: true, num_turns: 1, duration_api_ms: 0 },
        ],
        exitCode: 1,
      },
      status: 'failed',
      errorCode: 'AUTH_REQUIRED',
    },
    {
      label: 'tools unexpectedly enabled',
      script: { lines: [{ ...INIT_EVENT, tools: ['Bash'] }], hang: true },
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_INIT_UNEXPECTED',
    },
    {
      label: 'MCP servers loaded',
      script: { lines: [{ ...INIT_EVENT, mcp_servers: [{ name: 'x' }] }], hang: true },
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_INIT_UNEXPECTED',
    },
    {
      label: 'API key billing path instead of the subscription',
      script: { lines: [{ ...INIT_EVENT, apiKeySource: 'ANTHROPIC_API_KEY' }], hang: true },
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_INIT_UNEXPECTED',
    },
    {
      label: 'unapproved model',
      script: { lines: [{ ...INIT_EVENT, model: 'claude-opus-5-5' }], hang: true },
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_INIT_UNEXPECTED',
    },
    {
      label: 'provider API error',
      script: {
        lines: [
          INIT_EVENT,
          { type: 'assistant', error: 'rate_limit', is_api_error_message: true },
          { type: 'result', subtype: 'success', is_error: true },
        ],
        exitCode: 1,
      },
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_API_ERROR',
    },
    {
      label: 'malformed output',
      script: {
        lines: [INIT_EVENT, '{oops', { type: 'result', subtype: 'success', is_error: false }],
      },
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_OUTPUT_INVALID',
    },
    {
      label: 'exit without a result',
      script: { lines: [INIT_EVENT], exitCode: 0 },
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_OUTCOME_UNKNOWN',
    },
    {
      label: 'nonzero exit after a success result',
      script: { ...success, exitCode: 2 },
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_OUTCOME_UNKNOWN',
    },
    {
      label: 'executable missing',
      script: { spawnError: true },
      status: 'failed',
      errorCode: 'PROCESS_START_FAILED',
    },
  ])('classifies $label without retrying', async ({ script, status, errorCode }) => {
    const { adapter, spawn } = provider([script], { triggerEnabled: true });
    expect(await adapter.triggerWindow({}, request)).toMatchObject({ status, errorCode });
    expect(spawn.invocations).toHaveLength(1);
  });

  it('treats a timeout or cancellation after dispatch as uncertain', async () => {
    const { adapter, spawn } = provider([{ lines: [INIT_EVENT], hang: true }], {
      triggerEnabled: true,
      actionTimeoutMs: 20,
    });
    expect(await adapter.triggerWindow({}, request)).toMatchObject({
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_TIMEOUT',
    });
    expect(spawn.children[0]?.kills).toContain('SIGTERM');

    const controller = new AbortController();
    const { adapter: aborted } = provider([{ lines: [INIT_EVENT], hang: true }], {
      triggerEnabled: true,
    });
    const pending = aborted.triggerWindow({ signal: controller.signal }, request);
    setTimeout(() => controller.abort(), 5);
    expect(await pending).toMatchObject({
      status: 'uncertain',
      errorCode: 'CLAUDE_CODE_TRIGGER_ABORTED',
    });
  });

  it('accepts an explicitly configured full model ID only on an exact match', async () => {
    const exact = {
      ...success,
      lines: [{ ...INIT_EVENT, model: 'claude-sonnet-5-5' }, ...success.lines!.slice(1)],
    };
    const { adapter } = provider([exact], {
      triggerEnabled: true,
      triggerModel: 'claude-sonnet-5-5',
    });
    expect((await adapter.triggerWindow({}, request)).status).toBe('succeeded');
  });

  it('fails before dispatch when the workspace cannot be prepared or the clock is invalid', async () => {
    const root = tempDirectory();
    const blocker = path.join(root, 'file');
    writeFileSync(blocker, 'x');
    const spawn = fakeClaude([success]);
    const adapter = new ClaudeCodeProvider({
      configDirectory: path.join(root, 'state'),
      workspaceDirectory: path.join(blocker, 'workspace'),
      triggerEnabled: true,
      now: () => new Date(NOW),
      spawnProcess: spawn,
    });
    expect(await adapter.triggerWindow({}, request)).toMatchObject({
      status: 'failed',
      errorCode: 'PROCESS_START_FAILED',
    });
    expect(spawn.invocations).toHaveLength(0);

    const { adapter: badClock } = provider([success], {
      triggerEnabled: true,
      now: () => new Date(Number.NaN),
    });
    expect(await badClock.triggerWindow({}, request)).toMatchObject({
      status: 'rejected',
      errorCode: 'CLAUDE_CODE_INVALID_TIME',
    });
    const { adapter: throwingClock } = provider([success], {
      triggerEnabled: true,
      now: () => {
        throw new Error('clock');
      },
    });
    expect((await throwingClock.triggerWindow({}, request)).errorCode).toBe(
      'CLAUDE_CODE_INVALID_TIME',
    );
  });
});
