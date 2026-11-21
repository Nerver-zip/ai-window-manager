import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DispatchAuthorizationError } from '../../../src/providers/dispatch-authorization.js';
import {
  OPENCODE_GO_DEFAULT_TRIGGER_MODEL,
  OPENCODE_GO_FIVE_HOUR_WINDOW,
  OPENCODE_GO_MONTHLY_WINDOW,
  OPENCODE_GO_WEEKLY_WINDOW,
  OpenCodeGoProvider,
  openCodeWindowKindForMeter,
  openCodeWindowSnapshot,
  type OpenCodeGoProviderOptions,
} from '../../../src/providers/opencode/index.js';
import { openCodeProcessEnvironment } from '../../../src/providers/opencode/transport.js';
import { fakeClaude as fakeProcess, type FakeScript } from '../claude-code/support.js';

const NOW = '2026-11-21T12:00:00.000Z';
const SESSION_ID = 'ses_0123456789abABCDEFGHIJKLMN';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'awm-opencode-test-'));
  directories.push(directory);
  return directory;
}

function fixtureRun(name: string): FakeScript {
  return {
    lines: [readFileSync(`tests/fixtures/providers/opencode/${name}`, 'utf8').trim()],
    exitCode: 0,
  };
}

function provider(
  scripts: FakeScript[],
  options: Partial<OpenCodeGoProviderOptions> = {},
): { adapter: OpenCodeGoProvider; spawn: ReturnType<typeof fakeProcess>; root: string } {
  const root = tempDirectory();
  const spawn = fakeProcess(scripts);
  const adapter = new OpenCodeGoProvider({
    homeDirectory: path.join(root, 'home'),
    workspaceDirectory: path.join(root, 'workspace'),
    executable: '/opt/opencode/bin/opencode',
    now: () => new Date(NOW),
    spawnProcess: spawn,
    generateSessionId: () => SESSION_ID,
    ...options,
  });
  return { adapter, spawn, root };
}

const request = {
  intentId: 'intent-1',
  reasonCode: 'MANUAL_TRIGGER_REQUESTED',
  windowKind: OPENCODE_GO_FIVE_HOUR_WINDOW,
};

function meterFor(
  kind: 'rolling' | 'weekly' | 'monthly',
  overrides: Partial<{ percent: number; limited: boolean; resetsAt: string }> = {},
) {
  return { kind, percent: 10, limited: false, resetsAt: '2026-11-21T15:00:00.000Z', ...overrides };
}

describe('openCodeWindowSnapshot', () => {
  it('maps the three Go meters to stable window kinds', () => {
    expect(openCodeWindowKindForMeter('rolling')).toBe(OPENCODE_GO_FIVE_HOUR_WINDOW);
    expect(openCodeWindowKindForMeter('weekly')).toBe(OPENCODE_GO_WEEKLY_WINDOW);
    expect(openCodeWindowKindForMeter('monthly')).toBe(OPENCODE_GO_MONTHLY_WINDOW);
  });

  it('treats consumption with a future reset as an anchored active window', () => {
    const snapshot = openCodeWindowSnapshot('opencode_go', meterFor('rolling'), NOW);
    expect(snapshot.phase).toMatchObject({ value: 'ACTIVE', confidence: 'high' });
    expect(snapshot.resetAt?.value).toBe('2026-11-21T15:00:00.000Z');
    expect(snapshot.durationSeconds?.value).toBe(18_000);
    expect(snapshot.startedAt?.value).toBe('2026-11-21T10:00:00.000Z');
    expect(snapshot.usageRatio?.value).toBeCloseTo(0.1);
    expect(snapshot.remainingRatio?.value).toBeCloseTo(0.9);
  });

  it('leaves zero consumption with a future reset UNKNOWN for the temporal tracker', () => {
    // Before the first request the server reports the rolling reset five hours out.
    const snapshot = openCodeWindowSnapshot(
      'opencode_go',
      meterFor('rolling', { percent: 0, resetsAt: '2026-11-21T17:00:00.000Z' }),
      NOW,
    );
    expect(snapshot.phase).toMatchObject({ value: 'UNKNOWN', confidence: 'unknown' });
    expect(snapshot.usageRatio?.value).toBe(0);
  });

  it('marks a limited or full meter exhausted', () => {
    expect(
      openCodeWindowSnapshot('opencode_go', meterFor('rolling', { limited: true }), NOW).phase,
    ).toMatchObject({ value: 'EXHAUSTED', confidence: 'high' });
    expect(
      openCodeWindowSnapshot('opencode_go', meterFor('weekly', { percent: 100 }), NOW).phase.value,
    ).toBe('EXHAUSTED');
  });

  it('never treats an elapsed reset as a new allowance', () => {
    const snapshot = openCodeWindowSnapshot(
      'opencode_go',
      meterFor('rolling', { resetsAt: NOW }),
      NOW,
    );
    expect(snapshot.phase).toMatchObject({ value: 'RESET_DUE', confidence: 'high' });
    expect(snapshot.usageRatio).toBeUndefined();
  });

  it('claims no fixed duration for the billing-period monthly window', () => {
    const snapshot = openCodeWindowSnapshot(
      'opencode_go',
      meterFor('monthly', { resetsAt: '2026-12-01T00:00:00.000Z' }),
      NOW,
    );
    expect(snapshot.windowKind).toBe(OPENCODE_GO_MONTHLY_WINDOW);
    expect(snapshot.durationSeconds).toBeUndefined();
    expect(snapshot.startedAt).toBeUndefined();
    expect(snapshot.phase.value).toBe('ACTIVE');
  });

  it.each([
    ['rolling', '2026-11-22T00:00:00.000Z'],
    ['weekly', '2026-12-05T00:00:00.000Z'],
    ['monthly', '2027-01-30T00:00:00.000Z'],
  ] as const)('fails closed when the %s reset is implausibly far away', (kind, resetsAt) => {
    expect(() => openCodeWindowSnapshot('opencode_go', meterFor(kind, { resetsAt }), NOW)).toThrow(
      expect.objectContaining({ code: 'SCHEMA_CHANGED' }),
    );
  });
});

describe('OpenCodeGoProvider construction and capabilities', () => {
  it('validates options', () => {
    const base = { homeDirectory: '/tmp/awm-oc-home' };
    expect(() => new OpenCodeGoProvider({ homeDirectory: ' ' })).toThrow(/homeDirectory/);
    expect(() => new OpenCodeGoProvider({ ...base, triggerModel: 'gpt-5' })).toThrow(/opencode-go/);
    expect(() => new OpenCodeGoProvider({ ...base, triggerModel: 'opencode-go/x; rm' })).toThrow(
      /opencode-go/,
    );
    expect(() => new OpenCodeGoProvider({ ...base, readTimeoutMs: 0 })).toThrow(/readTimeoutMs/);
    expect(() => new OpenCodeGoProvider({ ...base, actionTimeoutMs: 999_999 })).toThrow(
      /actionTimeoutMs/,
    );
    expect(() => new OpenCodeGoProvider({ ...base, id: 'Bad Id' })).toThrow();
    expect(new OpenCodeGoProvider(base).id).toBe('opencode_go');
  });

  it('advertises the start capability only for the 5-hour window when enabled', async () => {
    const off = provider([]).adapter.capabilities();
    expect(off.usageRead).toMatchObject({ supported: true, contract: 'official_client_internal' });
    expect(off.windowTrigger).toMatchObject({ supported: false, consumesQuota: true });
    expect(off.windowTrigger.supportedWindowKinds).toBeUndefined();

    const { adapter } = provider([], { triggerEnabled: true });
    expect(adapter.capabilities().windowTrigger).toMatchObject({
      supported: true,
      consumesQuota: true,
      supportedWindowKinds: [OPENCODE_GO_FIVE_HOUR_WINDOW],
    });
    expect(await adapter.health({})).toBe('UNAVAILABLE');
  });
});

describe('OpenCodeGoProvider.inspect', () => {
  it('reads the usage route through a private standalone server in an isolated home', async () => {
    const { adapter, spawn, root } = provider([fixtureRun('usage-go.json')]);
    const observation = await adapter.inspect({});

    expect(observation.health).toBe('UP');
    expect(observation.windows.map((window) => window.windowKind)).toEqual([
      OPENCODE_GO_FIVE_HOUR_WINDOW,
      OPENCODE_GO_WEEKLY_WINDOW,
      OPENCODE_GO_MONTHLY_WINDOW,
    ]);
    expect(await adapter.health({})).toBe('UP');
    expect(JSON.stringify(observation)).not.toContain('wrk_synthetic');
    expect(JSON.stringify(observation)).not.toContain('Synthetic Workspace');

    const [call] = spawn.invocations;
    expect(call?.executable).toBe('/opt/opencode/bin/opencode');
    expect(call?.args).toEqual(['--standalone', 'api', 'GET', '/api/experimental/usage/limits']);
    expect(call?.options).toMatchObject({ shell: false, cwd: path.join(root, 'workspace') });
    expect(statSync(path.join(root, 'home')).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(root, 'workspace')).mode & 0o777).toBe(0o700);
  });

  it('classifies a missing Console sign-in as AUTH_REQUIRED', async () => {
    const { adapter } = provider([fixtureRun('usage-signed-out.json')]);
    expect(await adapter.inspect({})).toMatchObject({
      health: 'AUTH_REQUIRED',
      summary: 'OPENCODE_GO_AUTH_REQUIRED',
      windows: [],
    });
  });

  it('classifies a workspace without a Go subscription as degraded', async () => {
    const { adapter } = provider([fixtureRun('usage-no-go.json')]);
    expect(await adapter.inspect({})).toMatchObject({
      health: 'DEGRADED',
      summary: 'OPENCODE_GO_NOT_SUBSCRIBED',
    });
  });

  it.each([
    [
      'missing executable',
      { spawnError: true },
      'UNAVAILABLE',
      'OPENCODE_GO_EXECUTABLE_UNAVAILABLE',
    ],
    ['non-zero exit', { lines: ['{}'], exitCode: 1 }, 'ERROR', 'OPENCODE_GO_OUTPUT_INVALID'],
    ['non-JSON output', { lines: ['boom'], exitCode: 0 }, 'ERROR', 'OPENCODE_GO_OUTPUT_INVALID'],
    [
      'web-app fallback (route gone)',
      { lines: ['<!doctype html><html></html>'], exitCode: 0 },
      'ERROR',
      'OPENCODE_GO_CONTRACT_CHANGED',
    ],
    [
      'changed meter schema',
      { lines: ['{"data":{"workspace":{"id":"w"},"go":{"rolling":1}}}'], exitCode: 0 },
      'ERROR',
      'OPENCODE_GO_CONTRACT_CHANGED',
    ],
  ] as const)('fails closed on %s', async (_name, script, health, summary) => {
    const { adapter } = provider([script as FakeScript]);
    expect(await adapter.inspect({})).toMatchObject({ health, summary, windows: [] });
    expect(await adapter.health({})).toBe(health);
  });

  it('reports a timeout and an abort as unavailable without trusting partial output', async () => {
    const hung = provider([{ hang: true }], { readTimeoutMs: 20 });
    expect(await hung.adapter.inspect({})).toMatchObject({
      health: 'UNAVAILABLE',
      summary: 'OPENCODE_GO_PROVIDER_TIMEOUT',
    });

    const controller = new AbortController();
    controller.abort();
    const aborted = provider([fixtureRun('usage-go.json')]);
    expect(await aborted.adapter.inspect({ signal: controller.signal })).toMatchObject({
      health: 'UNAVAILABLE',
      summary: 'OPENCODE_GO_PROVIDER_UNAVAILABLE',
    });
  });

  it('rejects oversized output and an invalid clock', async () => {
    const huge = provider([{ raw: 'x'.repeat(300 * 1024), exitCode: 0 }]);
    expect(await huge.adapter.inspect({})).toMatchObject({ summary: 'OPENCODE_GO_OUTPUT_INVALID' });

    const badClock = provider([fixtureRun('usage-go.json')], { now: () => new Date(Number.NaN) });
    expect(await badClock.adapter.inspect({})).toMatchObject({
      health: 'ERROR',
      summary: 'OPENCODE_GO_OUTPUT_INVALID',
    });
  });

  it('fails closed when the working directory cannot be created', async () => {
    const root = tempDirectory();
    const spawn = fakeProcess([fixtureRun('usage-go.json')]);
    const adapter = new OpenCodeGoProvider({
      homeDirectory: '/proc/awm-cannot-create/home',
      workspaceDirectory: path.join(root, 'workspace'),
      now: () => new Date(NOW),
      spawnProcess: spawn,
    });
    expect(await adapter.inspect({})).toMatchObject({ health: 'ERROR' });
    expect(spawn.invocations).toHaveLength(0);
  });
});

describe('openCodeProcessEnvironment', () => {
  it('isolates every base directory and drops inherited credentials', () => {
    const env = openCodeProcessEnvironment('/state/opencode', {
      PATH: '/usr/bin',
      LANG: 'C',
      OPENCODE_API_KEY: 'synthetic-secret',
      OPENCODE_GO_API_KEY: 'synthetic-secret',
      AWM_AUTH_PASSWORD_HASH: 'synthetic-hash',
      HOME: '/home/operator',
      XDG_DATA_HOME: '/home/operator/.local/share',
    });
    expect(env).toEqual({
      HOME: '/state/opencode',
      XDG_DATA_HOME: '/state/opencode/.local/share',
      XDG_CONFIG_HOME: '/state/opencode/.config',
      XDG_STATE_HOME: '/state/opencode/.local/state',
      XDG_CACHE_HOME: '/state/opencode/.cache',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      PATH: '/usr/bin',
      LANG: 'C',
    });
    expect(Object.values(env).join(' ')).not.toContain('synthetic');
  });
});

const GOOD_RUN: FakeScript = {
  lines: [
    { type: 'step_start', sessionID: SESSION_ID, timestamp: 1 },
    { type: 'text', sessionID: SESSION_ID, part: { text: 'model answer that must not leak' } },
    { type: 'step_finish', sessionID: SESSION_ID, timestamp: 2 },
  ],
  exitCode: 0,
};

describe('OpenCodeGoProvider.triggerWindow', () => {
  it('registers the exact session before spawning, gates dispatch, and sends one fixed prompt', async () => {
    const order: string[] = [];
    const { adapter, spawn } = provider([GOOD_RUN], { triggerEnabled: true });
    const originalSpawn = spawn;
    const result = await adapter.triggerWindow(
      {
        registerCleanupArtifact: (artifact) => {
          order.push(`register:${artifact.kind}:${artifact.externalId}`);
          expect(originalSpawn.invocations).toHaveLength(0);
          return Promise.resolve();
        },
        assertDispatchAllowed: () => {
          order.push('gate');
          expect(originalSpawn.invocations).toHaveLength(0);
        },
      },
      request,
    );

    expect(order).toEqual([`register:opencode_session:${SESSION_ID}`, 'gate']);
    expect(result).toMatchObject({
      status: 'succeeded',
      confirmationHint: 'OPENCODE_GO_TURN_COMPLETED',
    });
    expect(JSON.stringify(result)).not.toContain('model answer');
    expect(spawn.invocations).toHaveLength(1);
    expect(spawn.invocations[0]?.args).toEqual([
      '--standalone',
      'run',
      '--format',
      'json',
      '--session',
      SESSION_ID,
      '--archived',
      '--model',
      OPENCODE_GO_DEFAULT_TRIGGER_MODEL,
      'Hi!',
    ]);
    expect(spawn.invocations[0]?.args).not.toContain('--auto');
  });

  it('rejects without side effects when disabled, malformed, or aimed at another window', async () => {
    const register = () => Promise.resolve();
    const disabled = provider([GOOD_RUN]);
    expect(
      await disabled.adapter.triggerWindow({ registerCleanupArtifact: register }, request),
    ).toMatchObject({ status: 'rejected', errorCode: 'OPENCODE_GO_TRIGGER_DISABLED' });

    const { adapter, spawn } = provider([GOOD_RUN], { triggerEnabled: true });
    for (const [bad, code] of [
      [{ ...request, intentId: '' }, 'OPENCODE_GO_TRIGGER_REQUEST_INVALID'],
      [
        { ...request, windowKind: OPENCODE_GO_WEEKLY_WINDOW },
        'OPENCODE_GO_TRIGGER_TARGET_UNSUPPORTED',
      ],
      [
        { ...request, windowKind: OPENCODE_GO_MONTHLY_WINDOW },
        'OPENCODE_GO_TRIGGER_TARGET_UNSUPPORTED',
      ],
      [{ ...request, windowKind: undefined }, 'OPENCODE_GO_TRIGGER_TARGET_UNSUPPORTED'],
    ] as const) {
      expect(
        await adapter.triggerWindow({ registerCleanupArtifact: register }, bad as never),
      ).toMatchObject({ status: 'rejected', errorCode: code });
    }
    expect(await adapter.triggerWindow({}, request)).toMatchObject({
      status: 'rejected',
      errorCode: 'OPENCODE_GO_CLEANUP_REGISTRATION_REQUIRED',
    });
    expect(spawn.invocations).toHaveLength(0);

    const badClock = provider([GOOD_RUN], {
      triggerEnabled: true,
      now: () => new Date(Number.NaN),
    });
    expect(
      await badClock.adapter.triggerWindow({ registerCleanupArtifact: register }, request),
    ).toMatchObject({ status: 'rejected', errorCode: 'OPENCODE_GO_INVALID_TIME' });
    const throwingClock = provider([GOOD_RUN], {
      triggerEnabled: true,
      now: () => {
        throw new Error('clock');
      },
    });
    expect(
      await throwingClock.adapter.triggerWindow({ registerCleanupArtifact: register }, request),
    ).toMatchObject({ status: 'rejected', errorCode: 'OPENCODE_GO_INVALID_TIME' });
  });

  it('never dispatches when the cleanup obligation cannot be persisted', async () => {
    const { adapter, spawn } = provider([GOOD_RUN], { triggerEnabled: true });
    const result = await adapter.triggerWindow(
      {
        registerCleanupArtifact: () => Promise.reject(new Error('db locked')),
        assertDispatchAllowed: () => {
          throw new Error('must not be reached');
        },
      },
      request,
    );
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'OPENCODE_GO_CLEANUP_REGISTRATION_FAILED',
    });
    expect(spawn.invocations).toHaveLength(0);
  });

  it('refuses an invalid generated session ID before any side effect', async () => {
    const { adapter, spawn } = provider([GOOD_RUN], {
      triggerEnabled: true,
      generateSessionId: () => 'not-a-session',
    });
    const registered: unknown[] = [];
    const result = await adapter.triggerWindow(
      {
        registerCleanupArtifact: (artifact) => {
          registered.push(artifact);
          return Promise.resolve();
        },
      },
      request,
    );
    expect(result).toMatchObject({ status: 'failed', errorCode: 'OPENCODE_GO_SESSION_ID_INVALID' });
    expect(registered).toEqual([]);
    expect(spawn.invocations).toHaveLength(0);
  });

  it('propagates a withdrawn dispatch authorization before spawning', async () => {
    const { adapter, spawn } = provider([GOOD_RUN], { triggerEnabled: true });
    await expect(
      adapter.triggerWindow(
        {
          registerCleanupArtifact: () => Promise.resolve(),
          assertDispatchAllowed: () => {
            throw new DispatchAuthorizationError('POLICY_CHANGED');
          },
        },
        request,
      ),
    ).rejects.toBeInstanceOf(DispatchAuthorizationError);
    expect(spawn.invocations).toHaveLength(0);
  });

  it('reports a failed start when the client cannot be launched or the model has no route', async () => {
    const ctx = { registerCleanupArtifact: () => Promise.resolve() };
    const missing = provider([{ spawnError: true }], { triggerEnabled: true });
    expect(await missing.adapter.triggerWindow(ctx, request)).toMatchObject({
      status: 'failed',
      errorCode: 'PROCESS_START_FAILED',
    });

    const noRoute = provider(
      [
        {
          lines: [
            {
              type: 'error',
              sessionID: SESSION_ID,
              error: { type: 'provider.no-route', message: 'Model unavailable' },
            },
          ],
          exitCode: 1,
        },
      ],
      { triggerEnabled: true },
    );
    expect(await noRoute.adapter.triggerWindow(ctx, request)).toMatchObject({
      status: 'failed',
      errorCode: 'OPENCODE_GO_MODEL_UNAVAILABLE',
    });
  });

  it('fails the start when the workspace cannot be prepared', async () => {
    const spawn = fakeProcess([GOOD_RUN]);
    const adapter = new OpenCodeGoProvider({
      homeDirectory: '/proc/awm-cannot-create/home',
      now: () => new Date(NOW),
      spawnProcess: spawn,
      triggerEnabled: true,
    });
    expect(
      await adapter.triggerWindow({ registerCleanupArtifact: () => Promise.resolve() }, request),
    ).toMatchObject({ status: 'failed', errorCode: 'PROCESS_START_FAILED' });
    expect(spawn.invocations).toHaveLength(0);
  });

  it.each<[string, FakeScript, string]>([
    [
      'provider error after the turn started',
      {
        lines: [
          { type: 'step_start', sessionID: SESSION_ID },
          { type: 'error', sessionID: SESSION_ID, error: { type: 'provider.no-route' } },
        ],
        exitCode: 1,
      },
      'OPENCODE_GO_TRIGGER_API_ERROR',
    ],
    [
      'a provider error without a route classification',
      {
        lines: [{ type: 'error', sessionID: SESSION_ID, error: { type: 'unknown' } }],
        exitCode: 1,
      },
      'OPENCODE_GO_TRIGGER_API_ERROR',
    ],
    [
      'a different session ID',
      { lines: [{ type: 'step_finish', sessionID: 'ses_otherotherotherotherother' }], exitCode: 0 },
      'OPENCODE_GO_TRIGGER_SESSION_MISMATCH',
    ],
    [
      'a malformed line',
      { lines: [{ type: 'step_finish', sessionID: SESSION_ID }, 'not json'], exitCode: 0 },
      'OPENCODE_GO_TRIGGER_OUTPUT_INVALID',
    ],
    [
      'a clean exit with no completed step',
      { lines: [], exitCode: 0 },
      'OPENCODE_GO_TRIGGER_OUTCOME_UNKNOWN',
    ],
    [
      'a crash after the step finished',
      { lines: [{ type: 'step_finish', sessionID: SESSION_ID }], exitCode: 1 },
      'OPENCODE_GO_TRIGGER_OUTCOME_UNKNOWN',
    ],
  ])('classifies %s as uncertain and never retries', async (_name, script, code) => {
    const { adapter, spawn } = provider([script, GOOD_RUN], {
      triggerEnabled: true,
    });
    const result = await adapter.triggerWindow(
      { registerCleanupArtifact: () => Promise.resolve() },
      request,
    );
    expect(result).toMatchObject({ status: 'uncertain', errorCode: code });
    expect(spawn.invocations).toHaveLength(1);
  });

  it('classifies a timeout, an abort and oversized output as uncertain', async () => {
    const ctx = { registerCleanupArtifact: () => Promise.resolve() };
    const timeout = provider([{ hang: true }], { triggerEnabled: true, actionTimeoutMs: 20 });
    expect(await timeout.adapter.triggerWindow(ctx, request)).toMatchObject({
      status: 'uncertain',
      errorCode: 'OPENCODE_GO_TRIGGER_TIMEOUT',
    });

    const controller = new AbortController();
    const aborted = provider([{ hang: true }], { triggerEnabled: true });
    const pending = aborted.adapter.triggerWindow({ ...ctx, signal: controller.signal }, request);
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toMatchObject({
      status: 'uncertain',
      errorCode: 'OPENCODE_GO_TRIGGER_ABORTED',
    });

    const overflow = provider([{ raw: 'x'.repeat(1024 * 1024 + 10), exitCode: 0 }], {
      triggerEnabled: true,
    });
    expect(await overflow.adapter.triggerWindow(ctx, request)).toMatchObject({
      status: 'uncertain',
      errorCode: 'OPENCODE_GO_TRIGGER_OUTPUT_INVALID',
    });
  });
});

describe('OpenCodeGoProvider.cleanupArtifact', () => {
  const artifact = { kind: 'opencode_session', externalId: SESSION_ID } as const;

  it('deletes exactly the registered session through the official command', async () => {
    const { adapter, spawn } = provider([{ exitCode: 0 }]);
    await expect(adapter.cleanupArtifact({}, artifact)).resolves.toBeUndefined();
    expect(spawn.invocations[0]?.args).toEqual(['--standalone', 'session', 'delete', SESSION_ID]);
  });

  it('treats an already-deleted session as success', async () => {
    const { adapter } = provider([{ exitCode: 1, stderr: `Session not found: ${SESSION_ID}\n` }]);
    await expect(adapter.cleanupArtifact({}, artifact)).resolves.toBeUndefined();
  });

  it.each([
    ['another session being missing', { exitCode: 1, stderr: 'Session not found: ses_other\n' }],
    ['an unexplained failure', { exitCode: 1 }],
    ['a launch failure', { spawnError: true }],
    ['a hang', { hang: true }],
  ] as const)('keeps the job retryable on %s', async (_name, script) => {
    const { adapter } = provider([script]);
    const controller = new AbortController();
    if (_name === 'a hang') setTimeout(() => controller.abort(), 20);
    const failure = await adapter.cleanupArtifact({ signal: controller.signal }, artifact).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as { code: string }).code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it('refuses foreign kinds and IDs without spawning anything', async () => {
    const { adapter, spawn } = provider([{ exitCode: 0 }]);
    for (const bad of [
      { kind: 'codex_thread', externalId: SESSION_ID },
      { kind: 'opencode_session', externalId: 'ses_x' },
      { kind: 'opencode_session', externalId: `${SESSION_ID}; rm -rf /` },
      { kind: 'opencode_session', externalId: '--help' },
    ] as const) {
      await expect(adapter.cleanupArtifact({}, bad as never)).rejects.toMatchObject({
        code: 'OPENCODE_GO_CLEANUP_ARTIFACT_INVALID',
      });
    }
    expect(spawn.invocations).toHaveLength(0);
  });

  it('fails retryably when the state directory cannot be prepared', async () => {
    const spawn = fakeProcess([{ exitCode: 0 }]);
    const adapter = new OpenCodeGoProvider({
      homeDirectory: '/proc/awm-cannot-create/home',
      spawnProcess: spawn,
    });
    await expect(adapter.cleanupArtifact({}, artifact)).rejects.toMatchObject({
      code: 'PROCESS_START_FAILED',
    });
  });
});
