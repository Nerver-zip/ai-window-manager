import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AntigravityProvider as ExportedAntigravityProvider,
  parseAntigravityUsageEnvelope,
} from '../../../src/providers/antigravity/index.js';
import { AntigravityProvider } from '../../../src/providers/antigravity/provider.js';
import { AntigravityOutputError } from '../../../src/providers/antigravity/protocol.js';
import { outputProcessFactory, scriptedProcessFactory } from './support.js';

const observedAt = '2030-01-01T12:00:00.000Z';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/providers/antigravity/usage/${name}`, import.meta.url),
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
  it('is exported from the provider boundary and is monitor-only', () => {
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
        consumesQuota: 'unknown',
        notes: 'Antigravity adapter is read-only and never sends a prompt',
      },
    });
    expect('triggerWindow' in provider).toBe(false);
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
          phase: { value: 'UNKNOWN', source: 'unknown', confidence: 'unknown' },
          usageRatio: { value: 0.25, source: 'inferred', confidence: 'exact' },
          remainingRatio: { value: 0.75, source: 'observed', confidence: 'exact' },
          resetAt: { value: '2030-01-03T12:00:00.000Z', source: 'observed' },
        },
        {
          windowKind: 'antigravity_gemini_five_hour',
          usageRatio: { value: 0, source: 'inferred' },
        },
        {
          windowKind: 'antigravity_claude_gpt_weekly',
          usageRatio: { value: 0.5 },
        },
        {
          windowKind: 'antigravity_claude_gpt_five_hour',
          usageRatio: { value: 0.09999999999999998 },
        },
      ],
    });
    expect(JSON.stringify(observation)).not.toContain('synthetic-');
    expect(JSON.stringify(observation)).not.toMatch(/email|account|identity/i);
    await expect(provider.health({})).resolves.toBe('UP');
  });

  it('preserves partial nullable timing without inventing phase, start or duration', async () => {
    const observation = await providerFor(fixture('usage-json.partial-null.json')).inspect({});

    expect(observation).toMatchObject({
      health: 'UP',
      windows: [
        {
          windowKind: 'antigravity_gemini_five_hour',
          phase: { value: 'UNKNOWN' },
          remainingRatio: { value: 1 },
        },
        {
          windowKind: 'antigravity_claude_gpt_weekly',
          remainingRatio: { value: 0.42 },
        },
      ],
    });
    for (const window of observation.windows) {
      expect(window.startedAt).toBeUndefined();
      expect(window.durationSeconds).toBeUndefined();
      expect(window.resetAt).toBeUndefined();
    }
  });

  it('accepts unknown additive fields at the official CLI boundary', async () => {
    const observation = await providerFor(fixture('usage-json.additive.json')).inspect({});

    expect(observation).toMatchObject({
      health: 'UP',
      windows: [{ windowKind: 'antigravity_gemini_weekly', remainingRatio: { value: 0.8 } }],
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

  it('rejects an invalid provider configuration before spawning', () => {
    expect(() => new AntigravityProvider({ executable: ' ' })).toThrow('executable is required');
    expect(
      () => new AntigravityProvider({ executable: 'agy', printTimeoutSeconds: 301 }),
    ).toThrow();
    expect(() => new AntigravityProvider({ executable: 'agy', timeoutMs: 305_001 })).toThrow();
  });

  it('keeps the parser error bounded and safe for malformed input', () => {
    expect(() => parseAntigravityUsageEnvelope({ status: 'SUCCESS' })).toThrow(
      AntigravityOutputError,
    );
  });
});
