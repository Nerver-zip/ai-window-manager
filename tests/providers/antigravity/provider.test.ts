import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_TRIGGER_MESSAGE,
  AntigravityProvider as ExportedAntigravityProvider,
  containsAuthenticationMarker,
  parseAntigravityActionEnvelope,
  parseAntigravityUsageEnvelope,
} from '../../../src/providers/antigravity/index.js';
import { AntigravityProvider } from '../../../src/providers/antigravity/provider.js';
import { AntigravityOutputError } from '../../../src/providers/antigravity/protocol.js';
import {
  outputProcessFactory,
  scriptedProcessFactory,
  type FakeAntigravityProcess,
} from './support.js';

const observedAt = '2030-01-01T12:00:00.000Z';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/providers/antigravity/usage/${name}`, import.meta.url),
    'utf8',
  );
}

function actionFixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/providers/antigravity/actions/${name}`, import.meta.url),
    'utf8',
  );
}

function providerFor(
  output: string,
  overrides: Partial<ConstructorParameters<typeof AntigravityProvider>[0]> = {},
): AntigravityProvider {
  return new AntigravityProvider({
    executable: '/opt/antigravity/bin/agy',
    now: () => new Date(observedAt),
    spawnProcess: outputProcessFactory(output),
    ...overrides,
  });
}

describe('AntigravityProvider', () => {
  it('is exported from the provider boundary and keeps triggering disabled by default', () => {
    const provider = providerFor(fixture('usage-json.success.json'));

    expect(ExportedAntigravityProvider).toBe(AntigravityProvider);
    expect(provider.capabilities()).toEqual({
      usageRead: {
        supported: true,
        contract: 'observed_undocumented',
        notes: 'official agy /usage headless JSON output; nested quota fields may drift',
      },
      resetRead: {
        supported: true,
        contract: 'observed_undocumented',
        notes: 'resetAt is preserved only when returned as a valid UTC timestamp',
      },
      windowTrigger: {
        supported: false,
        contract: 'unknown',
        consumesQuota: true,
        notes: 'Quota-consuming prompt action is disabled by the injected trigger gate',
      },
    });
    expect('triggerWindow' in provider).toBe(true);
  });

  it('uses only the injected executable and official usage command', async () => {
    let observedArgs: string[] = [];
    let observedOptions: { shell?: boolean } | undefined;
    const provider = new AntigravityProvider({
      executable: '/custom/agy',
      cwd: '/srv/agy',
      now: () => new Date(observedAt),
      spawnProcess: (executable, args, options) => {
        observedArgs = args;
        observedOptions = options;
        return outputProcessFactory(fixture('usage-json.success.json'))(executable, args, options);
      },
    });

    await provider.inspect({});

    expect(observedArgs).toEqual([
      '-p',
      '/usage',
      '--output-format',
      'json',
      '--print-timeout',
      '30s',
    ]);
    expect(observedOptions).toMatchObject({ shell: false, cwd: '/srv/agy' });
  });

  it('normalizes all supported groups and windows without identity-bearing keys', async () => {
    const provider = providerFor(fixture('usage-json.success.json'));

    const observation = await provider.inspect({});

    expect(observation).toMatchObject({
      providerId: 'antigravity',
      health: 'UP',
      observedAt,
      windows: [
        {
          windowKind: 'antigravity_gemini_weekly',
          phase: { value: 'ACTIVE', source: 'inferred', confidence: 'high' },
          durationSeconds: { value: 604800, source: 'inferred', confidence: 'exact' },
          usageRatio: { value: 0.25, source: 'inferred', confidence: 'exact' },
          remainingRatio: { value: 0.75, source: 'observed', confidence: 'exact' },
          resetAt: { value: '2030-01-03T12:00:00.000Z', source: 'observed' },
        },
        {
          windowKind: 'antigravity_gemini_five_hour',
          phase: { value: 'INACTIVE', source: 'inferred', confidence: 'high' },
          durationSeconds: { value: 18000, source: 'inferred', confidence: 'exact' },
          usageRatio: { value: 0, source: 'inferred' },
        },
        {
          windowKind: 'antigravity_claude_gpt_weekly',
          phase: { value: 'ACTIVE', source: 'inferred', confidence: 'high' },
          durationSeconds: { value: 604800, source: 'inferred', confidence: 'exact' },
          usageRatio: { value: 0.5 },
        },
        {
          windowKind: 'antigravity_claude_gpt_five_hour',
          phase: { value: 'ACTIVE', source: 'inferred', confidence: 'high' },
          durationSeconds: { value: 18000, source: 'inferred', confidence: 'exact' },
          usageRatio: { value: 0.09999999999999998 },
        },
      ],
    });
    expect(JSON.stringify(observation)).not.toContain('synthetic-');
    expect(JSON.stringify(observation)).not.toMatch(/email|account|identity/i);
    await expect(provider.health({})).resolves.toBe('UP');
  });

  it('preserves nullable timing while marking duration provenance as inferred', async () => {
    const observation = await providerFor(fixture('usage-json.partial-null.json')).inspect({});

    expect(observation).toMatchObject({
      health: 'UP',
      windows: [
        {
          windowKind: 'antigravity_gemini_five_hour',
          phase: { value: 'INACTIVE', source: 'inferred', confidence: 'high' },
          durationSeconds: { value: 18000, source: 'inferred', confidence: 'exact' },
          remainingRatio: { value: 1 },
        },
        {
          windowKind: 'antigravity_claude_gpt_weekly',
          phase: { value: 'ACTIVE', source: 'inferred', confidence: 'high' },
          durationSeconds: { value: 604800, source: 'inferred', confidence: 'exact' },
          remainingRatio: { value: 0.42 },
        },
      ],
    });
    for (const window of observation.windows) {
      expect(window.startedAt).toBeUndefined();
      expect(window.resetAt).toBeUndefined();
    }
  });

  it('uses a small bounded tolerance when inferring full or exhausted allowance', async () => {
    const output = fixture('usage-json.success.json').replace(
      '"remaining_fraction": 0.75',
      '"remaining_fraction": 0.000001',
    );
    const observation = await providerFor(output).inspect({});

    expect(observation.windows[0]?.phase).toEqual({
      value: 'EXHAUSTED',
      source: 'inferred',
      confidence: 'high',
      observedAt,
    });

    const almostFull = await providerFor(
      fixture('usage-json.success.json').replace(
        '"remaining_fraction": 0.75',
        '"remaining_fraction": 0.999999',
      ),
    ).inspect({});
    expect(almostFull.windows[0]?.phase).toMatchObject({ value: 'INACTIVE', source: 'inferred' });

    const slightlyUsed = await providerFor(
      fixture('usage-json.success.json').replace(
        '"remaining_fraction": 0.75',
        '"remaining_fraction": 0.9995',
      ),
    ).inspect({});
    expect(slightlyUsed.windows[0]?.phase).toMatchObject({ value: 'ACTIVE', source: 'inferred' });
  });

  it('accepts unknown additive fields at the official CLI boundary', async () => {
    const observation = await providerFor(fixture('usage-json.additive.json')).inspect({});

    expect(observation).toMatchObject({
      health: 'UP',
      windows: [
        {
          windowKind: 'antigravity_gemini_weekly',
          phase: { value: 'ACTIVE', source: 'inferred', confidence: 'high' },
          durationSeconds: { value: 604800, source: 'inferred', confidence: 'exact' },
          remainingRatio: { value: 0.8 },
        },
      ],
    });
  });

  it('does not classify an unrelated group as Gemini or expose it as a trigger target', async () => {
    const output = fixture('usage-json.success.json').replace(
      '"name": "Gemini Models"',
      '"name": "NearGemini Models"',
    );
    const provider = providerFor(output);
    const observation = await provider.inspect({});

    expect(observation.windows[0]?.windowKind).toBe('antigravity_group_1_weekly');

    const triggerProvider = providerFor(actionFixture('trigger-success.json'), {
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
    });
    await expect(
      triggerProvider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-unknown-family',
          dedupeKey: 'dedupe-synthetic-unknown-family',
          reasonCode: 'test',
          windowKind: 'antigravity_group_1_weekly',
        },
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'AGY_TRIGGER_TARGET_UNSUPPORTED',
    });
  });

  it('drops a valid but unreasonable reset instead of inventing timing', async () => {
    const output = fixture('usage-json.additive.json').replace(
      '2030-01-03T12:00:00Z',
      '2032-01-03T12:00:00Z',
    );
    const observation = await providerFor(output).inspect({});

    expect(observation.windows[0]?.resetAt).toBeUndefined();
  });

  it('drops a reset more than one day before the observation', async () => {
    const output = fixture('usage-json.additive.json').replace(
      '2030-01-03T12:00:00Z',
      '2029-12-30T12:00:00Z',
    );
    const observation = await providerFor(output).inspect({});

    expect(observation.windows[0]?.resetAt).toBeUndefined();
  });

  it.each([
    ['malformed JSON', fixture('usage-json.malformed.txt'), 'AGY_PROVIDER_OUTPUT_INVALID'],
    [
      'invalid numeric value',
      fixture('usage-json.invalid-numeric.json'),
      'AGY_PROVIDER_OUTPUT_INVALID',
    ],
  ])('fails closed for %s', async (_name, output, summary) => {
    const observation = await providerFor(output).inspect({});

    expect(observation).toMatchObject({ health: 'UNAVAILABLE', windows: [], summary });
    expect(JSON.stringify(observation)).not.toContain('synthetic-invalid');
  });

  it('classifies an official CLI authentication error without exposing its message', async () => {
    const observation = await providerFor(fixture('usage-json.auth-required.json')).inspect({});

    expect(observation).toMatchObject({
      health: 'AUTH_REQUIRED',
      windows: [],
      summary: 'AGY_AUTH_REQUIRED',
    });
    expect(JSON.stringify(observation)).not.toContain('Sign in');
  });

  it('classifies non-authentication usage errors as unavailable', async () => {
    const observation = await providerFor(
      '{"status":"ERROR","error":"temporary provider failure"}',
    ).inspect({});

    expect(observation).toMatchObject({
      health: 'UNAVAILABLE',
      windows: [],
      summary: 'AGY_PROVIDER_UNAVAILABLE',
    });
  });

  it('maps a missing executable to a safe bounded observation', async () => {
    const provider = new AntigravityProvider({
      executable: '/missing/agy',
      now: () => new Date(observedAt),
      spawnProcess: scriptedProcessFactory((process) =>
        process.fail(Object.assign(new Error('private path'), { code: 'ENOENT' })),
      ),
    });

    const observation = await provider.inspect({});

    expect(observation).toMatchObject({
      health: 'UNAVAILABLE',
      summary: 'AGY_EXECUTABLE_UNAVAILABLE',
    });
    expect(JSON.stringify(observation)).not.toContain('private path');
  });

  it('uses the real usage spawn boundary safely when the executable is absent', async () => {
    const provider = new AntigravityProvider({
      executable: '/definitely/not/an/agy-binary',
      now: () => new Date(observedAt),
    });

    await expect(provider.inspect({})).resolves.toMatchObject({
      health: 'UNAVAILABLE',
      summary: 'AGY_EXECUTABLE_UNAVAILABLE',
      windows: [],
    });
  });

  it('rejects an invalid provider configuration before spawning', () => {
    expect(() => new AntigravityProvider({ executable: ' ' })).toThrow('executable is required');
    expect(
      () => new AntigravityProvider({ executable: 'agy', printTimeoutSeconds: 301 }),
    ).toThrow();
    expect(() => new AntigravityProvider({ executable: 'agy', timeoutMs: 305_001 })).toThrow();
    expect(
      () => new AntigravityProvider({ executable: 'agy', actionTimeoutSeconds: 121 }),
    ).toThrow();
  });

  it('keeps the parser error bounded and safe for malformed input', () => {
    expect(() => parseAntigravityUsageEnvelope({ status: 'SUCCESS' })).toThrow(
      AntigravityOutputError,
    );
    expect(() =>
      parseAntigravityUsageEnvelope({
        status: 'SUCCESS',
        command: { name: 'usage', data: { groups: [] } },
      }),
    ).toThrow(AntigravityOutputError);
    expect(containsAuthenticationMarker(undefined)).toBe(false);
  });

  it('normalizes an invalid inspection clock to a bounded unavailable observation', async () => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      now: () => new Date(Number.NaN),
      spawnProcess: outputProcessFactory(fixture('usage-json.success.json')),
    });

    await expect(provider.inspect({})).resolves.toMatchObject({
      health: 'UNAVAILABLE',
      summary: 'AGY_PROVIDER_OUTPUT_INVALID',
      windows: [],
    });
  });

  it('declares experimental quota-consuming capability for each configured model group', () => {
    const provider = providerFor(fixture('usage-json.success.json'), {
      triggerEnabled: true,
      triggerModels: {
        gemini: 'gemini-3.8-flash-low',
        claudeGpt: 'claude-sonnet-4-6',
      },
    });

    expect(provider.capabilities().windowTrigger).toEqual({
      supported: true,
      contract: 'observed_undocumented',
      consumesQuota: true,
      supportedWindowKinds: [
        'antigravity_gemini_five_hour',
        'antigravity_gemini_weekly',
        'antigravity_claude_gpt_five_hour',
        'antigravity_claude_gpt_weekly',
      ],
      notes:
        'Official agy headless prompt mode; window-positioning effect is experimental and account/CLI-specific',
    });
    expect(ANTIGRAVITY_TRIGGER_MESSAGE).toBe('Hi!');
  });

  it('does not advertise any target when enabled without a configured family model', () => {
    const provider = providerFor(fixture('usage-json.success.json'), {
      triggerEnabled: true,
      triggerModels: {},
    });

    expect(provider.capabilities().windowTrigger).toMatchObject({
      supported: false,
      contract: 'unknown',
      consumesQuota: true,
    });
    expect(provider.capabilities().windowTrigger).not.toHaveProperty('supportedWindowKinds');
  });

  it('does not expose the CLI conversation identifier or response in the action result', async () => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: outputProcessFactory(actionFixture('trigger-success.json')),
    });

    const result = await provider.triggerWindow(
      {},
      {
        intentId: 'intent-synthetic-privacy',
        dedupeKey: 'dedupe-synthetic-privacy',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      },
    );
    expect(result).toMatchObject({ status: 'succeeded' });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-antigravity-conversation|Hello\./);
  });

  it.each([
    ['antigravity_gemini_five_hour', 'gemini-3.8-flash-low'],
    ['antigravity_gemini_weekly', 'gemini-3.8-flash-low'],
    ['antigravity_claude_gpt_five_hour', 'claude-sonnet-4-6'],
    ['antigravity_claude_gpt_weekly', 'claude-sonnet-4-6'],
  ])('uses the configured model for exact target %s', async (windowKind, expectedModel) => {
    let observedArgs: string[] = [];
    let observedShell: boolean | undefined;
    let observedCwd: string | URL | undefined;
    const provider = new AntigravityProvider({
      executable: '/opt/antigravity/bin/agy',
      cwd: '/tmp/awm-antigravity-trigger',
      triggerEnabled: true,
      actionTimeoutSeconds: 30,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: (executable, args, options) => {
        observedArgs = args;
        observedShell = options.shell;
        observedCwd = options.cwd;
        return outputProcessFactory(actionFixture('trigger-success.json'))(
          executable,
          args,
          options,
        );
      },
    });

    const controller = new AbortController();
    await expect(
      provider.triggerWindow(
        { signal: controller.signal },
        {
          intentId: 'intent-synthetic-1',
          dedupeKey: 'dedupe-synthetic-1',
          reasonCode: 'test',
          windowKind,
        },
      ),
    ).resolves.toMatchObject({ status: 'succeeded', occurredAt: observedAt });
    expect(observedArgs).toEqual([
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
    expect(observedShell).toBe(false);
    expect(String(observedCwd)).toMatch(/\/awm-agy-trigger-[^/]+$/);
    if (!observedCwd) throw new Error('trigger workspace was not passed to agy');
    expect(existsSync(observedCwd)).toBe(false);
    expect(observedArgs).not.toContain('--dangerously-skip-permissions');
  });

  it.each([
    ['missing target', undefined, 'AGY_TRIGGER_TARGET_REQUIRED'],
    ['unknown group target', 'antigravity_group_3_five_hour', 'AGY_TRIGGER_TARGET_UNSUPPORTED'],
    ['an inherited object key', 'constructor', 'AGY_TRIGGER_TARGET_UNSUPPORTED'],
  ])('rejects %s before starting the CLI', async (_label, windowKind, errorCode) => {
    let spawnCount = 0;
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error('must not spawn');
      },
    });

    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-2',
          dedupeKey: 'dedupe-synthetic-2',
          reasonCode: 'test',
          ...(windowKind ? { windowKind } : {}),
        },
      ),
    ).resolves.toMatchObject({ status: 'rejected', errorCode });
    expect(spawnCount).toBe(0);
  });

  it('supports a configured family while rejecting a target whose model is missing', async () => {
    let spawnCount = 0;
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low' },
      now: () => new Date(observedAt),
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error('must not spawn');
      },
    });

    expect(provider.capabilities().windowTrigger).toMatchObject({
      supported: true,
      contract: 'observed_undocumented',
      consumesQuota: true,
      supportedWindowKinds: ['antigravity_gemini_five_hour', 'antigravity_gemini_weekly'],
    });
    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-3',
          dedupeKey: 'dedupe-synthetic-3',
          reasonCode: 'test',
          windowKind: 'antigravity_claude_gpt_five_hour',
        },
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'AGY_TRIGGER_MODEL_UNAVAILABLE',
    });
    expect(spawnCount).toBe(0);
  });

  it('rejects an invalid model value and malformed request before spawn', async () => {
    let spawnCount = 0;
    const invalidModelProvider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: '--dangerously-skip-permissions', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error('must not spawn');
      },
    });
    await expect(
      invalidModelProvider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-invalid-model',
          dedupeKey: 'dedupe-synthetic-invalid-model',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({ status: 'rejected', errorCode: 'AGY_TRIGGER_MODEL_UNAVAILABLE' });

    const validModelProvider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error('must not spawn');
      },
    });
    await expect(
      validModelProvider.triggerWindow(
        {},
        {
          intentId: '',
          dedupeKey: 'dedupe-synthetic-invalid-request',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({ status: 'rejected', errorCode: 'AGY_TRIGGER_REQUEST_INVALID' });
    expect(spawnCount).toBe(0);
  });

  it('keeps the trigger disabled by default and never spawns from a rejected request', async () => {
    let spawnCount = 0;
    const provider = new AntigravityProvider({
      executable: 'agy',
      now: () => new Date(observedAt),
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error('must not spawn');
      },
    });

    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-4',
          dedupeKey: 'dedupe-synthetic-4',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({ status: 'rejected', errorCode: 'AGY_TRIGGER_DISABLED' });
    expect(spawnCount).toBe(0);
  });

  it('returns uncertainty for timeout after the action process spawned', async () => {
    let processRef: FakeAntigravityProcess | undefined;
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      actionTimeoutSeconds: 1,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: scriptedProcessFactory(
        (process) => {
          process.start();
        },
        (process) => {
          processRef = process;
        },
      ),
    });

    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-5',
          dedupeKey: 'dedupe-synthetic-5',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'AGY_TRIGGER_OUTCOME_UNKNOWN' });
    expect(processRef?.killSignals).toContain('SIGTERM');
  });

  it('rejects an invalid action clock before spawn and uses a safe timestamp fallback', async () => {
    let spawnCount = 0;
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(Number.NaN),
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error('must not spawn');
      },
    });

    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-invalid',
          dedupeKey: 'dedupe-synthetic-invalid',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'AGY_INVALID_TIME',
      occurredAt: '1970-01-01T00:00:00.000Z',
    });
    const clockThrowsProvider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => {
        throw new Error('private clock diagnostic');
      },
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error('must not spawn');
      },
    });
    await expect(
      clockThrowsProvider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-throwing-clock',
          dedupeKey: 'dedupe-synthetic-throwing-clock',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'AGY_INVALID_TIME',
      occurredAt: '1970-01-01T00:00:00.000Z',
    });
    expect(spawnCount).toBe(0);
  });

  it.each([
    ['malformed JSON', actionFixture('trigger-malformed.txt'), 'AGY_TRIGGER_OUTPUT_INVALID'],
    ['missing completion response', '{"status":"SUCCESS"}', 'AGY_TRIGGER_OUTCOME_UNKNOWN'],
    ['empty output after EOF', '', 'AGY_TRIGGER_OUTPUT_INVALID'],
  ])('treats %s as uncertain without exposing output', async (_label, output, errorCode) => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: outputProcessFactory(output),
    });

    const result = await provider.triggerWindow(
      {},
      {
        intentId: 'intent-synthetic-6',
        dedupeKey: 'dedupe-synthetic-6',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      },
    );
    expect(result).toMatchObject({ status: 'uncertain', errorCode });
    if (output) expect(JSON.stringify(result)).not.toContain(output);
  });

  it('keeps post-spawn authentication output uncertain because dispatch cannot be proven', async () => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: outputProcessFactory(actionFixture('trigger-auth-required.json')),
    });

    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-7',
          dedupeKey: 'dedupe-synthetic-7',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'AGY_TRIGGER_OUTCOME_UNKNOWN' });
  });

  it('classifies an authentication rejection reported in the response field safely', async () => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: outputProcessFactory('{"status":"ERROR","response":"Authentication required"}'),
    });

    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-auth-response',
          dedupeKey: 'dedupe-synthetic-auth-response',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'AGY_TRIGGER_OUTCOME_UNKNOWN' });
  });

  it.each([
    ['missing turn count', '{"status":"SUCCESS","response":"Hello."}'],
    ['multiple turns', '{"status":"SUCCESS","response":"Hello.","num_turns":2}'],
  ])('does not accept success with %s as a confirmed one-turn result', async (_label, output) => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: outputProcessFactory(output),
    });

    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-unverified-turn-count',
          dedupeKey: 'dedupe-synthetic-unverified-turn-count',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({
      status: 'uncertain',
      errorCode: 'AGY_TRIGGER_OUTCOME_UNKNOWN',
    });
  });

  it('validates action envelopes and treats unknown terminal statuses as non-success', async () => {
    expect(() => parseAntigravityActionEnvelope({ status: 'FUTURE_STATUS' })).toThrow();
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: outputProcessFactory('{"status":"CANCELED","response":"stopped"}'),
    });

    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-8',
          dedupeKey: 'dedupe-synthetic-8',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_weekly',
        },
      ),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'AGY_TRIGGER_OUTCOME_UNKNOWN' });
  });
});
