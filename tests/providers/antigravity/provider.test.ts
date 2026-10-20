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
import { observeWindowCycle } from '../../../src/scheduler/window-cycle.js';
import {
  hangingStreamingActionProcessFactory,
  outputProcessFactory,
  scriptedProcessFactory,
  streamingActionProcessFactory,
  type FakeAntigravityProcess,
} from './support.js';

const observedAt = '2030-01-01T12:00:00.000Z';
const cleanupContext = { registerCleanupArtifact: () => Promise.resolve() };

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
  it('timestamps a slow usage response when it completes so rolling resets stay actionable', async () => {
    const startedAtMs = Date.parse(observedAt);
    const durationMs = 18_000_000;
    const times = [0, 7_000, 30_000, 37_000].map((offset) => startedAtMs + offset);
    const outputs = [7_000, 37_000].map((offset) =>
      fixture('usage-json.success.json').replaceAll(
        '2029-12-31T17:00:00Z',
        new Date(startedAtMs + offset + durationMs).toISOString(),
      ),
    );
    let clockIndex = 0;
    let outputIndex = 0;
    const provider = providerFor(outputs[0]!, {
      now: () => new Date(times[clockIndex++]!),
      spawnProcess: (executable, args, options) =>
        outputProcessFactory(outputs[outputIndex++]!)(executable, args, options),
    });

    const first = await provider.inspect({});
    const second = await provider.inspect({});
    const firstWindow = first.windows.find(
      (window) => window.windowKind === 'antigravity_gemini_five_hour',
    );
    const secondWindow = second.windows.find(
      (window) => window.windowKind === 'antigravity_gemini_five_hour',
    );
    expect(first.observedAt).toBe(new Date(startedAtMs + 7_000).toISOString());
    expect(second.observedAt).toBe(new Date(startedAtMs + 37_000).toISOString());
    expect(firstWindow?.resetAt?.value).toBe(
      new Date(startedAtMs + 7_000 + durationMs).toISOString(),
    );
    expect(secondWindow?.resetAt?.value).toBe(
      new Date(startedAtMs + 37_000 + durationMs).toISOString(),
    );
    expect(firstWindow).toBeDefined();
    expect(secondWindow).toBeDefined();
    const baseline = observeWindowCycle(firstWindow!);
    expect(observeWindowCycle(secondWindow!, baseline.cycle).window.phase).toMatchObject({
      value: 'INACTIVE',
      confidence: 'high',
    });
  });
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

  it('rejects distinct quota buckets that resolve to the same window identity', async () => {
    type Bucket = {
      id: string;
      window: '5h' | 'weekly';
      remaining_fraction: number;
      reset_time?: string | null;
    };
    const payload = JSON.parse(fixture('usage-json.success.json')) as {
      command: { data: { groups: Array<{ buckets: Bucket[] }> } };
    };
    const weeklyBuckets = payload.command.data.groups[0]!.buckets;
    weeklyBuckets.push({
      ...weeklyBuckets[0]!,
      id: 'synthetic-gemini-second-weekly',
      remaining_fraction: 0.5,
    });
    const provider = providerFor(JSON.stringify(payload));

    const observation = await provider.inspect({});

    expect(observation).toMatchObject({
      health: 'DEGRADED',
      windows: [],
      summary: 'PROVIDER_WINDOW_IDENTITY_AMBIGUOUS',
    });
    await expect(provider.health({})).resolves.toBe('DEGRADED');
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
      triggerProvider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-unknown-family',
        dedupeKey: 'dedupe-synthetic-unknown-family',
        reasonCode: 'test',
        windowKind: 'antigravity_group_1_weekly',
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'AGY_TRIGGER_TARGET_UNSUPPORTED',
    });
  });

  it('preserves known families when an unverified Argon group is observed', async () => {
    const payload = parseAntigravityUsageEnvelope(JSON.parse(fixture('usage-json.success.json')));
    const argonPayload = parseAntigravityUsageEnvelope(
      JSON.parse(fixture('usage-json.argon-weekly.json')),
    );
    const group = structuredClone(
      argonPayload.command!.data.groups.find((candidate) => candidate.name === 'Gemini 4 Argon')!,
    );
    group.buckets[0]!.id = 'gemini-argon-future-weekly';
    payload.command!.data.groups.push(group);
    const observation = await providerFor(JSON.stringify(payload)).inspect({});

    expect(observation.health).toBe('UP');
    expect(observation.summary).toBe('PROVIDER_WINDOW_IDENTITY_UNSUPPORTED');
    expect(observation.windows.map((window) => window.windowKind).sort()).toEqual(
      expect.arrayContaining([
        'antigravity_claude_gpt_five_hour',
        'antigravity_claude_gpt_weekly',
        'antigravity_gemini_five_hour',
        'antigravity_gemini_weekly',
      ]),
    );
    expect(observation.windows).toHaveLength(5);
    const unknownWindow = observation.windows.find((window) =>
      window.windowKind.startsWith('antigravity_argon_unverified_'),
    )!;
    expect(unknownWindow.windowKind).toMatch(/^antigravity_argon_unverified_[0-9a-f]{24}_weekly$/);
    expect(unknownWindow.phase).toMatchObject({
      value: 'UNKNOWN',
      source: 'unknown',
      confidence: 'unknown',
    });
    expect(
      observation.windows.some((window) => window.windowKind === 'antigravity_argon_weekly'),
    ).toBe(false);

    let spawns = 0;
    const triggerProvider = providerFor('', {
      triggerEnabled: true,
      argonTriggerEnabled: true,
      triggerModels: { argon: 'gemini-4-argon-low' },
      spawnProcess: () => {
        spawns++;
        throw new Error('unknown observed identities must not dispatch');
      },
    });
    expect(triggerProvider.capabilities().windowTrigger.supportedWindowKinds).toEqual([
      'antigravity_argon_weekly',
    ]);
    expect(
      await triggerProvider.triggerWindow(cleanupContext, {
        intentId: 'synthetic-unverified-argon-target',
        dedupeKey: 'synthetic-unverified-argon-target',
        reasonCode: 'test',
        windowKind: unknownWindow.windowKind,
      }),
    ).toMatchObject({ status: 'rejected', errorCode: 'AGY_TRIGGER_TARGET_UNSUPPORTED' });
    expect(spawns).toBe(0);
  });

  it('preserves an unverified Argon bucket without hiding other Gemini or Claude windows', async () => {
    const output = fixture('usage-json.success.json').replace(
      '"id": "synthetic-gemini-weekly"',
      '"id": "synthetic-argon-weekly"',
    );
    const observation = await providerFor(output).inspect({});

    expect(observation.health).toBe('UP');
    expect(observation.summary).toBe('PROVIDER_WINDOW_IDENTITY_UNSUPPORTED');
    expect(observation.windows.map((window) => window.windowKind).sort()).toEqual(
      expect.arrayContaining([
        'antigravity_claude_gpt_five_hour',
        'antigravity_claude_gpt_weekly',
        'antigravity_gemini_five_hour',
      ]),
    );
    expect(observation.windows).toHaveLength(4);
    expect(
      observation.windows.some((window) => window.windowKind === 'antigravity_gemini_weekly'),
    ).toBe(false);
    const unknownWindow = observation.windows.find((window) =>
      window.windowKind.startsWith('antigravity_argon_unverified_'),
    )!;
    expect(unknownWindow.windowKind).toMatch(/^antigravity_argon_unverified_[0-9a-f]{24}_weekly$/);
    expect(unknownWindow.phase).toMatchObject({ value: 'UNKNOWN', confidence: 'unknown' });
  });

  it('drops a valid but unreasonable reset instead of inventing timing', async () => {
    const output = fixture('usage-json.additive.json').replace(
      '2030-01-03T12:00:00Z',
      '2032-01-03T12:00:00Z',
    );
    const observation = await providerFor(output).inspect({});

    expect(observation.windows[0]?.resetAt).toBeUndefined();
  });

  it.each([false, true])(
    'keeps five stable identities when Argon group order is reversed=%s',
    async (reverse) => {
      const payload = parseAntigravityUsageEnvelope(
        JSON.parse(fixture('usage-json.argon-weekly.json')),
      );
      if (reverse) payload.command!.data.groups.reverse();
      const observation = await providerFor(JSON.stringify(payload)).inspect({});
      expect(observation.health).toBe('UP');
      expect(observation.windows.map((w) => w.windowKind).sort()).toEqual([
        'antigravity_argon_weekly',
        'antigravity_claude_gpt_five_hour',
        'antigravity_claude_gpt_weekly',
        'antigravity_gemini_five_hour',
        'antigravity_gemini_weekly',
      ]);
      expect(
        observation.windows.find((w) => w.windowKind === 'antigravity_argon_weekly'),
      ).toMatchObject({
        durationSeconds: { value: 604800, source: 'inferred', confidence: 'exact' },
        remainingRatio: { source: 'observed' },
        phase: { source: 'inferred' },
      });
    },
  );

  it.each([
    [1, 'INACTIVE'],
    [0.75, 'ACTIVE'],
    [0, 'EXHAUSTED'],
  ] as const)(
    'infers Argon remaining %s as %s without a provider lifecycle claim',
    async (remaining, phase) => {
      const payload = parseAntigravityUsageEnvelope(
        JSON.parse(fixture('usage-json.argon-weekly.json')),
      );
      const bucket = payload.command!.data.groups.find((g) => g.name === 'Gemini 4 Argon')!
        .buckets[0]!;
      bucket.remaining_fraction = remaining;
      const observation = await providerFor(JSON.stringify(payload)).inspect({});
      expect(
        observation.windows.find((w) => w.windowKind === 'antigravity_argon_weekly'),
      ).toMatchObject({
        phase: { value: phase, source: 'inferred' },
        usageRatio: { value: 1 - remaining },
        remainingRatio: { value: remaining },
      });
    },
  );

  it.each([undefined, null, '2030-01-01T11:59:00Z', '2030-01-08T12:00:00Z'])(
    'preserves only supplied reasonable Argon reset evidence %s',
    async (reset) => {
      const payload = parseAntigravityUsageEnvelope(
        JSON.parse(fixture('usage-json.argon-weekly.json')),
      );
      const bucket = payload.command!.data.groups.find((g) => g.name === 'Gemini 4 Argon')!
        .buckets[0]!;
      bucket.remaining_fraction = 1;
      if (reset === undefined) delete bucket.reset_time;
      else bucket.reset_time = reset;
      const observation = await providerFor(JSON.stringify(payload)).inspect({});
      const window = observation.windows.find((w) => w.windowKind === 'antigravity_argon_weekly')!;
      expect(window.startedAt).toBeUndefined();
      expect(window.resetAt?.value).toBe(reset ? new Date(reset).toISOString() : undefined);
      expect(window.phase).toMatchObject(
        reset && Date.parse(reset) > Date.parse(observedAt)
          ? { value: 'INACTIVE', confidence: 'high' }
          : { value: 'UNKNOWN', confidence: 'unknown' },
      );
    },
  );

  it('recognizes the observed Argon bucket inside a reordered or renamed group and rejects collisions', async () => {
    const payload = parseAntigravityUsageEnvelope(
      JSON.parse(fixture('usage-json.argon-weekly.json')),
    );
    const group = payload.command!.data.groups.find((g) => g.name === 'Gemini 4 Argon')!;
    group.name = 'Gemini Models';
    expect(
      (await providerFor(JSON.stringify(payload)).inspect({})).windows.some(
        (w) => w.windowKind === 'antigravity_argon_weekly',
      ),
    ).toBe(true);
    group.buckets.push({ ...group.buckets[0]! });
    expect(await providerFor(JSON.stringify(payload)).inspect({})).toMatchObject({
      health: 'DEGRADED',
      windows: [],
      summary: 'PROVIDER_WINDOW_IDENTITY_AMBIGUOUS',
    });
    group.buckets = [{ ...group.buckets[0]!, window: '5h' }];
    const unsupportedCadence = await providerFor(JSON.stringify(payload)).inspect({});
    expect(unsupportedCadence.health).toBe('UP');
    expect(unsupportedCadence.summary).toBe('PROVIDER_WINDOW_IDENTITY_UNSUPPORTED');
    expect(unsupportedCadence.windows).toHaveLength(5);
    expect(
      unsupportedCadence.windows.some((window) => window.windowKind === 'antigravity_argon_weekly'),
    ).toBe(false);
    expect(
      unsupportedCadence.windows.find((window) =>
        window.windowKind.startsWith('antigravity_argon_unverified_'),
      ),
    ).toMatchObject({ phase: { value: 'UNKNOWN', confidence: 'unknown' } });
  });

  it('keeps unverified Argon identity stable across group order and display-name changes', async () => {
    const read = async (reverse: boolean, groupName: string): Promise<string> => {
      const payload = parseAntigravityUsageEnvelope(
        JSON.parse(fixture('usage-json.argon-weekly.json')),
      );
      const argonGroup = payload.command!.data.groups.find(
        (candidate) => candidate.name === 'Gemini 4 Argon',
      )!;
      argonGroup.name = groupName;
      argonGroup.buckets[0]!.id = 'gemini-argon-future-weekly';
      if (reverse) payload.command!.data.groups.reverse();
      const observation = await providerFor(JSON.stringify(payload)).inspect({});
      expect(observation.health).toBe('UP');
      expect(observation.summary).toBe('PROVIDER_WINDOW_IDENTITY_UNSUPPORTED');
      expect(observation.windows).toHaveLength(5);
      expect(
        observation.windows.some((window) => window.windowKind === 'antigravity_argon_weekly'),
      ).toBe(false);
      expect(
        observation.windows.filter((window) =>
          window.windowKind.startsWith('antigravity_argon_unverified_'),
        ),
      ).toHaveLength(1);
      const unknownWindow = observation.windows.find((window) =>
        window.windowKind.startsWith('antigravity_argon_unverified_'),
      )!;
      expect(unknownWindow.windowKind).toMatch(
        /^antigravity_argon_unverified_[0-9a-f]{24}_weekly$/,
      );
      expect(unknownWindow.phase).toMatchObject({
        value: 'UNKNOWN',
        source: 'unknown',
        confidence: 'unknown',
      });
      expect(observation.windows.map((window) => window.windowKind).sort()).toEqual(
        expect.arrayContaining([
          'antigravity_claude_gpt_five_hour',
          'antigravity_claude_gpt_weekly',
          'antigravity_gemini_five_hour',
          'antigravity_gemini_weekly',
        ]),
      );
      return unknownWindow.windowKind;
    };

    await expect(read(false, 'Future Argon quota')).resolves.toBe(
      await read(true, 'Provider quota group'),
    );
  });

  it.each([
    { gate: false, global: true, model: 'gemini-4-argon-low' },
    { gate: true, global: false, model: 'gemini-4-argon-low' },
    { gate: true, global: true, model: '' },
    { gate: true, global: true, model: 'gemini-3.8-flash-low' },
    { gate: true, global: true, model: 'claude-sonnet-4-6' },
  ])('cannot dispatch Argon with gate/model configuration %j', async ({ gate, global, model }) => {
    let spawns = 0;
    const provider = providerFor('', {
      triggerEnabled: global,
      argonTriggerEnabled: gate,
      triggerModels: { argon: model },
      spawnProcess: () => {
        spawns++;
        throw new Error('must not spawn');
      },
    });
    expect(provider.capabilities().windowTrigger.supported).toBe(false);
    expect(
      (
        await provider.triggerWindow(cleanupContext, {
          intentId: 'synthetic-argon-gated',
          dedupeKey: 'synthetic-argon-gated',
          reasonCode: 'test',
          windowKind: 'antigravity_argon_weekly',
        })
      ).status,
    ).toBe('rejected');
    expect(spawns).toBe(0);
  });

  it.each(['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high'])(
    'dispatches only the configured Argon model %s with durable cleanup',
    async (model) => {
      let sentArgs: string[] = [];
      let registered = false;
      const provider = providerFor('', {
        triggerEnabled: true,
        argonTriggerEnabled: true,
        triggerModels: { argon: model },
        spawnProcess: (executable, args, options) => {
          sentArgs = args;
          return streamingActionProcessFactory(actionFixture('trigger-success.json'), {
            onPrompt: () => expect(registered).toBe(true),
            initModel: model,
          })(executable, args, options);
        },
      });
      expect(provider.capabilities().windowTrigger.supportedWindowKinds).toEqual([
        'antigravity_argon_weekly',
      ]);
      expect(
        await provider.triggerWindow(
          {
            registerCleanupArtifact: () => {
              registered = true;
              return Promise.resolve();
            },
          },
          {
            intentId: 'synthetic-argon-model',
            dedupeKey: 'synthetic-argon-model',
            reasonCode: 'test',
            windowKind: 'antigravity_argon_weekly',
          },
        ),
      ).toMatchObject({ status: 'succeeded' });
      expect(sentArgs.slice(sentArgs.indexOf('--model'), sentArgs.indexOf('--model') + 2)).toEqual([
        '--model',
        model,
      ]);
    },
  );

  it('records an explicit post-dispatch Argon model mismatch as uncertain', async () => {
    const output = JSON.stringify({
      ...JSON.parse(actionFixture('trigger-success.json')),
      model: 'gemini-3.8-flash-low',
    });
    const provider = providerFor('', {
      triggerEnabled: true,
      argonTriggerEnabled: true,
      triggerModels: { argon: 'gemini-4-argon-low' },
      spawnProcess: streamingActionProcessFactory(output, { initModel: 'gemini-4-argon-low' }),
    });
    expect(
      await provider.triggerWindow(cleanupContext, {
        intentId: 'synthetic-argon-mismatch',
        dedupeKey: 'synthetic-argon-mismatch',
        reasonCode: 'test',
        windowKind: 'antigravity_argon_weekly',
      }),
    ).toMatchObject({ status: 'uncertain', errorCode: 'AGY_TRIGGER_MODEL_MISMATCH' });
  });

  it('registers cleanup and refuses an explicit init model mismatch before sending a prompt', async () => {
    let prompts = 0,
      registrations = 0;
    const provider = providerFor('', {
      triggerEnabled: true,
      argonTriggerEnabled: true,
      triggerModels: { argon: 'gemini-4-argon-low' },
      spawnProcess: scriptedProcessFactory((process) => {
        process.stdin.on('data', () => prompts++);
        process.start();
        queueMicrotask(() =>
          process.stdout.write(
            JSON.stringify({
              event: 'init',
              conversation_id: '00000000-0000-4000-8000-000000000001',
              model: 'gemini-3.8-flash-low',
            }) + '\n',
          ),
        );
      }),
    });
    expect(
      (
        await provider.triggerWindow(
          {
            registerCleanupArtifact: () => {
              registrations++;
              return Promise.resolve();
            },
          },
          {
            intentId: 'synthetic-argon-init-mismatch',
            dedupeKey: 'synthetic-argon-init-mismatch',
            reasonCode: 'test',
            windowKind: 'antigravity_argon_weekly',
          },
        )
      ).status,
    ).toBe('failed');
    expect(registrations).toBe(1);
    expect(prompts).toBe(0);
  });

  it('registers cleanup and refuses a missing init model before sending a prompt', async () => {
    let prompts = 0,
      registrations = 0;
    const provider = providerFor('', {
      triggerEnabled: true,
      argonTriggerEnabled: true,
      triggerModels: { argon: 'gemini-4-argon-low' },
      spawnProcess: streamingActionProcessFactory(actionFixture('trigger-success.json'), {
        onPrompt: () => {
          prompts++;
        },
      }),
    });
    expect(
      await provider.triggerWindow(
        {
          registerCleanupArtifact: () => {
            registrations++;
            return Promise.resolve();
          },
        },
        {
          intentId: 'synthetic-argon-init-model-missing',
          dedupeKey: 'synthetic-argon-init-model-missing',
          reasonCode: 'test',
          windowKind: 'antigravity_argon_weekly',
        },
      ),
    ).toMatchObject({ status: 'failed', errorCode: 'AGY_TRIGGER_OUTPUT_INVALID' });
    expect(registrations).toBe(1);
    expect(prompts).toBe(0);
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

  it('requires durable cleanup registration before an Antigravity prompt can start', async () => {
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

    await expect(
      provider.triggerWindow(
        {},
        {
          intentId: 'intent-synthetic-no-cleanup',
          dedupeKey: 'dedupe-synthetic-no-cleanup',
          reasonCode: 'test',
          windowKind: 'antigravity_gemini_five_hour',
        },
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      errorCode: 'AGY_CLEANUP_REGISTRATION_REQUIRED',
    });
    expect(spawnCount).toBe(0);
  });

  it('does not expose the CLI conversation identifier or response in the action result', async () => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: streamingActionProcessFactory(actionFixture('trigger-success.json')),
    });

    const result = await provider.triggerWindow(cleanupContext, {
      intentId: 'intent-synthetic-privacy',
      dedupeKey: 'dedupe-synthetic-privacy',
      reasonCode: 'test',
      windowKind: 'antigravity_gemini_five_hour',
    });
    expect(result).toMatchObject({ status: 'succeeded' });
    expect(JSON.stringify(result)).not.toMatch(/00000000-0000-4000-8000-000000000001|Hello\./);
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
        return streamingActionProcessFactory(actionFixture('trigger-success.json'))(
          executable,
          args,
          options,
        );
      },
    });

    const controller = new AbortController();
    await expect(
      provider.triggerWindow(
        { ...cleanupContext, signal: controller.signal },
        {
          intentId: 'intent-synthetic-1',
          dedupeKey: 'dedupe-synthetic-1',
          reasonCode: 'test',
          windowKind,
        },
      ),
    ).resolves.toMatchObject({ status: 'succeeded', occurredAt: observedAt });
    expect(observedArgs).toEqual([
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
      provider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-2',
        dedupeKey: 'dedupe-synthetic-2',
        reasonCode: 'test',
        ...(windowKind ? { windowKind } : {}),
      }),
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
      provider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-3',
        dedupeKey: 'dedupe-synthetic-3',
        reasonCode: 'test',
        windowKind: 'antigravity_claude_gpt_five_hour',
      }),
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
      invalidModelProvider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-invalid-model',
        dedupeKey: 'dedupe-synthetic-invalid-model',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      }),
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
      validModelProvider.triggerWindow(cleanupContext, {
        intentId: '',
        dedupeKey: 'dedupe-synthetic-invalid-request',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      }),
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
      provider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-4',
        dedupeKey: 'dedupe-synthetic-4',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      }),
    ).resolves.toMatchObject({ status: 'rejected', errorCode: 'AGY_TRIGGER_DISABLED' });
    expect(spawnCount).toBe(0);
  });

  it('returns uncertainty for timeout after the action process spawned', async () => {
    let processRef: FakeAntigravityProcess | undefined;
    let markPromptSent: (() => void) | undefined;
    const promptSent = new Promise<void>((resolve) => {
      markPromptSent = resolve;
    });
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      actionTimeoutSeconds: 1,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: hangingStreamingActionProcessFactory(
        () => markPromptSent?.(),
        undefined,
        (process) => {
          processRef = process;
        },
      ),
    });

    const action = provider.triggerWindow(cleanupContext, {
      intentId: 'intent-synthetic-5',
      dedupeKey: 'dedupe-synthetic-5',
      reasonCode: 'test',
      windowKind: 'antigravity_gemini_five_hour',
    });
    await promptSent;
    await expect(action).resolves.toMatchObject({
      status: 'uncertain',
      errorCode: 'AGY_TRIGGER_OUTCOME_UNKNOWN',
    });
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
      provider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-invalid',
        dedupeKey: 'dedupe-synthetic-invalid',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      }),
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
      clockThrowsProvider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-throwing-clock',
        dedupeKey: 'dedupe-synthetic-throwing-clock',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      }),
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
    ['empty output after EOF', '', 'AGY_TRIGGER_OUTCOME_UNKNOWN'],
  ])('treats %s as uncertain without exposing output', async (_label, output, errorCode) => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: streamingActionProcessFactory(output),
    });

    const result = await provider.triggerWindow(cleanupContext, {
      intentId: 'intent-synthetic-6',
      dedupeKey: 'dedupe-synthetic-6',
      reasonCode: 'test',
      windowKind: 'antigravity_gemini_five_hour',
    });
    expect(result).toMatchObject({ status: 'uncertain', errorCode });
    if (output) expect(JSON.stringify(result)).not.toContain(output);
  });

  it('keeps post-spawn authentication output uncertain because dispatch cannot be proven', async () => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: streamingActionProcessFactory(actionFixture('trigger-auth-required.json')),
    });

    await expect(
      provider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-7',
        dedupeKey: 'dedupe-synthetic-7',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      }),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'AGY_TRIGGER_OUTCOME_UNKNOWN' });
  });

  it('classifies an authentication rejection reported in the response field safely', async () => {
    const provider = new AntigravityProvider({
      executable: 'agy',
      triggerEnabled: true,
      triggerModels: { gemini: 'gemini-3.8-flash-low', claudeGpt: 'claude-sonnet-4-6' },
      now: () => new Date(observedAt),
      spawnProcess: streamingActionProcessFactory(
        '{"status":"ERROR","response":"Authentication required"}',
      ),
    });

    await expect(
      provider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-auth-response',
        dedupeKey: 'dedupe-synthetic-auth-response',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      }),
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
      spawnProcess: streamingActionProcessFactory(output),
    });

    await expect(
      provider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-unverified-turn-count',
        dedupeKey: 'dedupe-synthetic-unverified-turn-count',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_five_hour',
      }),
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
      spawnProcess: streamingActionProcessFactory('{"status":"CANCELED","response":"stopped"}'),
    });

    await expect(
      provider.triggerWindow(cleanupContext, {
        intentId: 'intent-synthetic-8',
        dedupeKey: 'dedupe-synthetic-8',
        reasonCode: 'test',
        windowKind: 'antigravity_gemini_weekly',
      }),
    ).resolves.toMatchObject({ status: 'uncertain', errorCode: 'AGY_TRIGGER_OUTCOME_UNKNOWN' });
  });
});
