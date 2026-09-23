import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderObservation, WindowSnapshot } from '../../src/domain/types.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ProviderRecord,
  type StorageRepositories,
} from '../../src/storage/repositories.js';
import { readScheduling } from '../../src/web/scheduling-api.js';

const NOW = '2026-09-19T08:00:00.000Z';
const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function setup(): { repositories: StorageRepositories; clock: FakeClock; fake: FakeProvider } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-scheduling-api-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  resources.push({ db, dir });
  const repositories = createRepositories(db);
  const clock = new FakeClock(NOW);
  const fake = new FakeProvider(clock, { windowDurationSeconds: 18_000 });
  repositories.providers.upsert(provider());
  return { repositories, clock, fake };
}

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  const at = Date.parse(NOW);
  return {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'automation',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: at,
    updatedAtMs: at,
    ...overrides,
  };
}

function observation(phase: 'ACTIVE' | 'INACTIVE' = 'INACTIVE'): ProviderObservation {
  const window: WindowSnapshot = {
    providerId: 'fake',
    windowKind: 'five_hour',
    observedAt: '2026-09-19T07:59:50.000Z',
    phase: {
      value: phase,
      source: 'observed',
      confidence: 'exact',
      observedAt: '2026-09-19T07:59:50.000Z',
    },
    durationSeconds: {
      value: 18_000,
      source: 'official_supported',
      confidence: 'exact',
      observedAt: '2026-09-19T07:59:50.000Z',
    },
  };
  return {
    providerId: 'fake',
    health: 'UP',
    observedAt: '2026-09-19T07:59:50.000Z',
    windows: [window],
    staleAfterSeconds: 300,
  };
}

function seedState(repositories: StorageRepositories, current = observation()): void {
  const observedAtMs = Date.parse(current.observedAt);
  repositories.providerState.upsert({
    providerId: 'fake',
    health: 'UP',
    observedAtMs,
    staleAfterMs: current.staleAfterSeconds * 1000,
    observation: current,
    lastSuccessAtMs: observedAtMs,
    lastErrorCode: null,
    updatedAtMs: observedAtMs,
  });
}

describe('readScheduling', () => {
  it('omits persisted fake provider policies when the provider is disabled by configuration', () => {
    const context = setup();
    seedState(context.repositories);

    const result = readScheduling({
      repositories: context.repositories,
      adapters: new Map([['fake', context.fake]]),
      clock: context.clock,
      fakeProviderEnabled: false,
    });

    expect(result.providers).toEqual([]);
  });

  it('returns an empty persisted workspace without provider I/O', () => {
    const context = setup();
    const result = readScheduling({
      repositories: context.repositories,
      adapters: new Map(),
      clock: context.clock,
    });
    expect(result.timezone).toBeNull();
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({
      providerId: 'fake',
      policy: null,
      decision: null,
      upcoming: [],
    });
    expect(result.providers[0]?.currentWindow.status).toBe('UNAVAILABLE');
  });

  it('reads the activation policy, current state and planner decision from SQLite', () => {
    const context = setup();
    const at = context.clock.now().getTime();
    seedState(context.repositories);
    context.repositories.settings.set('timezone', 'UTC', at);
    context.repositories.settings.set('timezone_source', 'manual', at);
    context.repositories.schedulePolicies.upsert({
      id: 'activation-fake',
      providerId: 'fake',
      kind: 'fixed',
      enabled: true,
      timezone: 'UTC',
      config: { windowKind: 'five_hour', anchorLocalTime: '08:00', toleranceSeconds: 30 },
      createdAtMs: at,
      updatedAtMs: at,
    });
    const result = readScheduling({
      repositories: context.repositories,
      adapters: new Map([['fake', context.fake]]),
      clock: context.clock,
    });
    expect(result.timezone).toEqual({ timezone: 'UTC', source: 'manual' });
    expect(result.providers[0]).toMatchObject({
      providerId: 'fake',
      policy: { kind: 'fixed', timezone: 'UTC' },
      currentWindow: { status: 'INACTIVE', windowKind: 'five_hour' },
      decision: { kind: 'START' },
    });
    expect(result.providers[0]?.upcoming.length).toBeGreaterThan(0);
  });

  it('does not reinterpret a legacy target-reset record as an activation policy', () => {
    const context = setup();
    const at = context.clock.now().getTime();
    seedState(context.repositories);
    context.repositories.schedulePolicies.upsert({
      id: 'legacy-target-reset',
      providerId: 'fake',
      kind: 'target_reset',
      enabled: true,
      timezone: 'UTC',
      config: { targetResetLocalTime: '13:00', toleranceSeconds: 30 },
      createdAtMs: at,
      updatedAtMs: at,
    });

    const result = readScheduling({
      repositories: context.repositories,
      adapters: new Map([['fake', context.fake]]),
      clock: context.clock,
    });

    expect(result.providers[0]).toMatchObject({
      policy: null,
      decision: null,
      upcoming: [],
    });
  });

  it('scopes current-window state and planning to the policy window', () => {
    const context = setup();
    const at = context.clock.now().getTime();
    const current = observation();
    current.windows.push({
      ...current.windows[0]!,
      windowKind: 'weekly',
      phase: { ...current.windows[0]!.phase, value: 'ACTIVE' },
    });
    seedState(context.repositories, current);
    context.repositories.schedulePolicies.upsert({
      id: 'activation-fake',
      providerId: 'fake',
      kind: 'fixed',
      enabled: true,
      timezone: 'UTC',
      config: { windowKind: 'five_hour', anchorLocalTime: '08:00', toleranceSeconds: 30 },
      createdAtMs: at,
      updatedAtMs: at,
    });
    const result = readScheduling({
      repositories: context.repositories,
      adapters: new Map([['fake', context.fake]]),
      clock: context.clock,
    });
    expect(result.providers[0]?.currentWindow).toMatchObject({
      status: 'INACTIVE',
      windowKind: 'five_hour',
    });
    expect(result.providers[0]?.decision).toMatchObject({ kind: 'START' });
  });

  it('does not fall back to another window when the configured window is absent', () => {
    const context = setup();
    const at = context.clock.now().getTime();
    seedState(context.repositories);
    context.repositories.schedulePolicies.upsert({
      id: 'activation-fake',
      providerId: 'fake',
      kind: 'fixed',
      enabled: true,
      timezone: 'UTC',
      config: { windowKind: 'weekly', anchorLocalTime: '08:00', toleranceSeconds: 30 },
      createdAtMs: at,
      updatedAtMs: at,
    });

    const result = readScheduling({
      repositories: context.repositories,
      adapters: new Map([['fake', context.fake]]),
      clock: context.clock,
    });

    expect(result.providers[0]?.currentWindow).toMatchObject({
      status: 'UNKNOWN',
      windowKind: 'weekly',
      reason: 'WINDOW_NOT_REPORTED',
    });
    expect(result.providers[0]?.decision).toMatchObject({
      kind: 'WAIT',
      reasonCode: 'WINDOW_NOT_REPORTED',
    });
    expect(result.providers[0]?.upcoming).toEqual([]);
  });

  it('fails closed for malformed policies and capability failures', () => {
    const context = setup();
    const at = context.clock.now().getTime();
    seedState(context.repositories);
    context.repositories.schedulePolicies.upsert({
      id: 'activation-fake',
      providerId: 'fake',
      kind: 'custom_schedule',
      enabled: true,
      timezone: 'UTC',
      config: { windowKind: 'five_hour', times: [] },
      createdAtMs: at,
      updatedAtMs: at,
    });
    const throwingAdapter: ProviderAdapter = {
      id: 'fake',
      capabilities: () => {
        throw new Error('not available');
      },
      health: context.fake.health.bind(context.fake),
      inspect: context.fake.inspect.bind(context.fake),
    };
    const result = readScheduling({
      repositories: context.repositories,
      adapters: new Map([['fake', throwingAdapter]]),
      clock: context.clock,
    });
    expect(result.providers[0]).toMatchObject({ policy: null, decision: null });
  });

  it('does not calculate a decision for a failed provider state', () => {
    const context = setup();
    const at = context.clock.now().getTime();
    context.repositories.providerState.upsert({
      providerId: 'fake',
      health: 'AUTH_REQUIRED',
      observedAtMs: at,
      staleAfterMs: 300_000,
      observation: observation(),
      lastSuccessAtMs: null,
      lastErrorCode: 'AUTH_REQUIRED',
      updatedAtMs: at,
    });
    context.repositories.schedulePolicies.upsert({
      id: 'activation-fake',
      providerId: 'fake',
      kind: 'manual',
      enabled: true,
      timezone: 'UTC',
      config: {},
      createdAtMs: at,
      updatedAtMs: at,
    });
    const result = readScheduling({
      repositories: context.repositories,
      adapters: new Map([['fake', context.fake]]),
      clock: context.clock,
    });
    expect(result.providers[0]).toMatchObject({
      currentWindow: { status: 'UNAVAILABLE', reason: 'AUTH_REQUIRED' },
      decision: null,
    });
  });
});
