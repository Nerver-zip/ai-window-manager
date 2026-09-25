import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_CLIENTS,
  type ProviderArchitecture,
  type ProviderClientId,
} from '../../scripts/provider-clients-core.js';
import { ProviderClientUpdateService } from '../../src/provider-clients/update-service.js';
import { ProviderClientRuntimeStoreError } from '../../src/provider-clients/runtime-store.js';
import type {
  ProviderClientRuntimeState,
  RuntimeClientCandidate,
} from '../../src/provider-clients/runtime-store.js';
import type { ProviderClientUpdateServiceOptions } from '../../src/provider-clients/update-service.js';

const FIXED_TIME = '2026-09-25T12:34:56.000Z';
const CODEX_DIGEST = 'a'.repeat(64);
const AGY_DIGEST = 'b'.repeat(64);

function state(
  providerId: ProviderClientId,
  overrides: Partial<ProviderClientRuntimeState> = {},
): ProviderClientRuntimeState {
  return {
    providerId,
    executablePath: `/runtime/${providerId}`,
    packagedVersion: '1.0.0',
    activeVersion: '1.0.0',
    activeSource: 'packaged',
    previousVersion: null,
    ...overrides,
  };
}

function release(providerId: ProviderClientId, version = '2.0.0'): unknown {
  const client = PROVIDER_CLIENTS[providerId];
  const digest = providerId === 'codex' ? CODEX_DIGEST : AGY_DIGEST;
  return {
    draft: false,
    prerelease: false,
    tag_name: `${client.tagPrefix}${version}`,
    published_at: '2026-09-24T12:00:00Z',
    assets: [
      { name: client.assets.amd64, digest: `sha256:${digest}` },
      { name: client.assets.arm64, digest: `sha256:${digest}` },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeHarness(
  options: {
    architecture?: ProviderArchitecture;
    busy?: (providerId: ProviderClientId) => boolean | Promise<boolean>;
    resolver?: (providerId: ProviderClientId) => Promise<unknown>;
    getState?: (providerId: ProviderClientId) => Promise<ProviderClientRuntimeState>;
    install?: (
      providerId: ProviderClientId,
      candidate: RuntimeClientCandidate,
    ) => Promise<{ status: 'installed' | 'already_active'; state: ProviderClientRuntimeState }>;
    rollback?: (providerId: ProviderClientId) => Promise<ProviderClientRuntimeState>;
    now?: () => Date;
  } = {},
) {
  const states: Record<ProviderClientId, ProviderClientRuntimeState> = {
    codex: state('codex'),
    antigravity: state('antigravity'),
  };
  const getStateImpl: ProviderClientUpdateServiceOptions['runtimeStore']['getState'] =
    options.getState ?? ((providerId) => Promise.resolve({ ...states[providerId] }));
  const getState = vi.fn(getStateImpl);
  const installImpl: ProviderClientUpdateServiceOptions['runtimeStore']['install'] =
    options.install ??
    ((providerId, candidate) => {
      const previous = states[providerId];
      states[providerId] = state(providerId, {
        activeVersion: candidate.version,
        activeSource: 'runtime',
        previousVersion: previous.activeVersion,
      });
      return Promise.resolve({ status: 'installed' as const, state: { ...states[providerId] } });
    });
  const install = vi.fn(installImpl);
  const rollbackImpl: ProviderClientUpdateServiceOptions['runtimeStore']['rollback'] =
    options.rollback ??
    ((providerId) => {
      const current = states[providerId];
      if (!current.previousVersion) return Promise.reject(new Error('no previous runtime'));
      states[providerId] = state(providerId, {
        activeVersion: current.previousVersion,
        activeSource: current.previousVersion === '1.0.0' ? 'packaged' : 'runtime',
        previousVersion: current.activeVersion,
      });
      return Promise.resolve({ ...states[providerId] });
    });
  const rollback = vi.fn(rollbackImpl);
  const resolverImpl: ProviderClientUpdateServiceOptions['resolveOfficialRelease'] =
    options.resolver ?? ((providerId) => Promise.resolve(release(providerId)));
  const resolver = vi.fn(resolverImpl);
  const isProviderBusy = vi.fn(options.busy ?? (() => false));
  const service = new ProviderClientUpdateService({
    runtimeStore: { getState, install, rollback },
    resolveOfficialRelease: resolver,
    architecture: options.architecture ?? 'amd64',
    clock: { now: options.now ?? (() => new Date(FIXED_TIME)) },
    isProviderBusy,
  });
  return { service, states, getState, install, rollback, resolver, isProviderBusy };
}

describe('ProviderClientUpdateService', () => {
  it('hydrates a safe status and checks only the injected official release source', async () => {
    const harness = makeHarness();

    const before = await harness.service.getStatus('codex');
    expect(before).toMatchObject({
      providerId: 'codex',
      packagedVersion: '1.0.0',
      activeVersion: '1.0.0',
      previousVersion: null,
      availableVersion: null,
      updateAvailable: false,
      status: 'idle',
    });
    expect(Object.keys(before).sort()).toEqual(
      [
        'providerId',
        'packagedVersion',
        'activeVersion',
        'previousVersion',
        'availableVersion',
        'updateAvailable',
        'status',
        'lastCheckedAt',
        'lastUpdatedAt',
        'lastErrorCode',
      ].sort(),
    );

    const checked = await harness.service.check('codex');
    expect(harness.resolver).toHaveBeenCalledExactlyOnceWith('codex');
    expect(checked).toMatchObject({
      availableVersion: '2.0.0',
      updateAvailable: true,
      status: 'update_available',
      lastCheckedAt: FIXED_TIME,
      lastUpdatedAt: null,
      lastErrorCode: null,
    });
    expect(JSON.stringify(checked)).not.toMatch(/https?:|sha256|asset|executablePath/i);
  });

  it('coalesces concurrent checks for one provider', async () => {
    const releaseGate = deferred<unknown>();
    const harness = makeHarness({ resolver: () => releaseGate.promise });

    const first = harness.service.check('codex');
    const second = harness.service.check('codex');
    await vi.waitFor(() => expect(harness.resolver).toHaveBeenCalledTimes(1));
    releaseGate.resolve(release('codex'));
    const [firstStatus, secondStatus] = await Promise.all([first, second]);

    expect(firstStatus).toEqual(secondStatus);
    expect(harness.getState).toHaveBeenCalledTimes(1);
    expect(harness.resolver).toHaveBeenCalledTimes(1);
  });

  it('serializes update behind an in-flight check', async () => {
    const releaseGate = deferred<unknown>();
    const harness = makeHarness({ resolver: () => releaseGate.promise });

    const check = harness.service.check('codex');
    await vi.waitFor(() => expect(harness.resolver).toHaveBeenCalledTimes(1));
    const update = harness.service.update('codex');
    expect(harness.install).not.toHaveBeenCalled();
    releaseGate.resolve(release('codex'));
    await check;
    const status = await update;

    expect(harness.install).toHaveBeenCalledTimes(1);
    expect(status.activeVersion).toBe('2.0.0');
  });

  it('installs only the freshly resolved stable version and exact architecture digest', async () => {
    const harness = makeHarness({ architecture: 'arm64' });

    const status = await harness.service.update('codex');

    expect(harness.install).toHaveBeenCalledExactlyOnceWith('codex', {
      version: '2.0.0',
      sha256: CODEX_DIGEST,
    });
    expect(status).toMatchObject({
      packagedVersion: '1.0.0',
      activeVersion: '2.0.0',
      previousVersion: '1.0.0',
      availableVersion: '2.0.0',
      updateAvailable: false,
      status: 'updated',
      lastCheckedAt: FIXED_TIME,
      lastUpdatedAt: FIXED_TIME,
    });
  });

  it('uses the original update timestamp if the clock fails after activation', async () => {
    let clockReads = 0;
    const harness = makeHarness({
      now: () => {
        clockReads += 1;
        return clockReads === 3 ? new Date(Number.NaN) : new Date(FIXED_TIME);
      },
    });

    const status = await harness.service.update('codex');

    expect(status).toMatchObject({
      activeVersion: '2.0.0',
      status: 'updated',
      lastUpdatedAt: FIXED_TIME,
      lastErrorCode: null,
    });
  });

  it('does not install when the resolved stable release is not newer', async () => {
    const harness = makeHarness({
      resolver: (providerId) => Promise.resolve(release(providerId, '1.0.0')),
    });

    const status = await harness.service.update('codex');

    expect(harness.install).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      activeVersion: '1.0.0',
      availableVersion: '1.0.0',
      updateAvailable: false,
      status: 'current',
    });
  });

  it('keeps an update available when the runtime store did not activate it', async () => {
    const harness = makeHarness({
      install: () => Promise.resolve({ status: 'already_active', state: state('codex') }),
    });

    const status = await harness.service.update('codex');

    expect(status).toMatchObject({
      activeVersion: '1.0.0',
      availableVersion: '2.0.0',
      updateAvailable: true,
      status: 'update_available',
    });
  });

  it('maps malformed release metadata and resolver errors to bounded codes', async () => {
    const harness = makeHarness({
      resolver: () =>
        Promise.reject(new Error('private URL https://release.invalid/secret/thread-id')),
    });

    const status = await harness.service.check('codex');

    expect(status).toMatchObject({
      status: 'error',
      availableVersion: null,
      updateAvailable: false,
      lastCheckedAt: FIXED_TIME,
      lastErrorCode: 'RELEASE_RESOLUTION_FAILED',
    });
    expect(JSON.stringify(status)).not.toMatch(/release\.invalid|secret|thread-id/);
  });

  it('reports clock unavailability when release resolution fails and preserves the prior check time', async () => {
    const harness = makeHarness({
      resolver: () => Promise.reject(new Error('release lookup failed')),
      now: () => new Date(Number.NaN),
    });

    const status = await harness.service.check('codex');

    expect(status).toMatchObject({
      status: 'error',
      lastCheckedAt: null,
      lastErrorCode: 'CLOCK_UNAVAILABLE',
    });
  });

  it('does not install a release rejected by the stable-release validator', async () => {
    const harness = makeHarness({
      resolver: (providerId) =>
        Promise.resolve({
          ...(release(providerId, '2.0.0') as Record<string, unknown>),
          prerelease: true,
        }),
    });

    const status = await harness.service.update('codex');

    expect(harness.install).not.toHaveBeenCalled();
    expect(status.lastErrorCode).toBe('RELEASE_RESOLUTION_FAILED');
    expect(status.availableVersion).toBeNull();
  });

  it('fails closed when the busy gate is true or throws, without touching the runtime store', async () => {
    for (const busy of [() => true, () => Promise.reject(new Error('busy check failed'))]) {
      const harness = makeHarness({ busy });

      const update = await harness.service.update('codex');
      const rollback = await harness.service.rollback('codex');

      expect(update.status).toBe('blocked');
      expect(update.lastErrorCode).toBe('UPDATE_BLOCKED_PROVIDER_BUSY');
      expect(rollback.status).toBe('blocked');
      expect(rollback.lastErrorCode).toBe('UPDATE_BLOCKED_PROVIDER_BUSY');
      expect(harness.getState).not.toHaveBeenCalled();
      expect(harness.resolver).not.toHaveBeenCalled();
      expect(harness.install).not.toHaveBeenCalled();
      expect(harness.rollback).not.toHaveBeenCalled();
    }
  });

  it('keeps busy results transient instead of mutating the stored service status', async () => {
    const harness = makeHarness({ busy: () => true });
    const blocked = await harness.service.update('codex');

    expect(blocked.lastErrorCode).toBe('UPDATE_BLOCKED_PROVIDER_BUSY');
    const status = await harness.service.getStatus('codex');
    expect(status.status).toBe('idle');
    expect(status.lastErrorCode).toBeNull();
  });

  it('maps a failed status read to a bounded runtime error', async () => {
    const harness = makeHarness({ getState: () => Promise.reject(new Error('private path')) });

    const status = await harness.service.getStatus('codex');

    expect(status.status).toBe('error');
    expect(status.lastErrorCode).toBe('RUNTIME_STATE_UNAVAILABLE');
    expect(JSON.stringify(status)).not.toContain('private path');
  });

  it('serializes update and rollback and retains update availability after rollback', async () => {
    const installGate = deferred<{
      status: 'installed';
      state: ProviderClientRuntimeState;
    }>();
    let current = state('codex');
    const rollback = vi.fn(() => {
      current = state('codex', {
        activeVersion: '1.0.0',
        activeSource: 'packaged',
        previousVersion: '2.0.0',
      });
      return Promise.resolve(current);
    });
    const harness = makeHarness({
      getState: () => Promise.resolve(current),
      install: () => installGate.promise,
      rollback: () => rollback(),
    });

    const update = harness.service.update('codex');
    await vi.waitFor(() => expect(harness.install).toHaveBeenCalledTimes(1));
    const rollbackOperation = harness.service.rollback('codex');
    expect(rollback).not.toHaveBeenCalled();
    current = state('codex', {
      activeVersion: '2.0.0',
      activeSource: 'runtime',
      previousVersion: '1.0.0',
    });
    installGate.resolve({ status: 'installed', state: current });
    await update;
    const rolledBack = await rollbackOperation;

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rolledBack).toMatchObject({
      activeVersion: '1.0.0',
      previousVersion: '2.0.0',
      availableVersion: '2.0.0',
      updateAvailable: true,
      status: 'update_available',
      lastUpdatedAt: FIXED_TIME,
    });
  });

  it('reports a plain rollback when the rolled-back version is already current', async () => {
    const harness = makeHarness({
      rollback: () => Promise.resolve(state('codex', { activeVersion: '1.0.0' })),
    });

    const status = await harness.service.rollback('codex');

    expect(status).toMatchObject({
      activeVersion: '1.0.0',
      updateAvailable: false,
      status: 'rolled_back',
      lastUpdatedAt: FIXED_TIME,
    });
  });

  it('maps runtime, install, and rollback failures without exposing error messages', async () => {
    const runtimeFailure = makeHarness({
      getState: () => Promise.reject(new Error('private token value')),
    });
    const runtimeStatus = await runtimeFailure.service.check('codex');
    expect(runtimeStatus.lastErrorCode).toBe('RUNTIME_STATE_UNAVAILABLE');
    expect(JSON.stringify(runtimeStatus)).not.toContain('private token');
    expect(runtimeFailure.resolver).not.toHaveBeenCalled();

    const updateStateFailure = makeHarness({
      getState: () => Promise.reject(new Error('private state path')),
    });
    const updateStateStatus = await updateStateFailure.service.update('codex');
    expect(updateStateStatus.lastErrorCode).toBe('RUNTIME_STATE_UNAVAILABLE');
    expect(updateStateFailure.resolver).not.toHaveBeenCalled();

    const installFailure = makeHarness({
      install: () => Promise.reject(new Error('archive URL and credential')),
    });
    const installStatus = await installFailure.service.update('codex');
    expect(installStatus.lastErrorCode).toBe('UPDATE_INSTALL_FAILED');
    expect(installStatus.availableVersion).toBe('2.0.0');
    expect(JSON.stringify(installStatus)).not.toMatch(/credential|archive URL/);

    const rollbackFailure = makeHarness({
      rollback: () => Promise.reject(new Error('path and thread-id')),
    });
    const rollbackStatus = await rollbackFailure.service.rollback('codex');
    expect(rollbackStatus.lastErrorCode).toBe('ROLLBACK_FAILED');
    expect(JSON.stringify(rollbackStatus)).not.toMatch(/path|thread-id/);
  });

  it('distinguishes a candidate validation failure while preserving the active version', async () => {
    const harness = makeHarness({
      install: () =>
        Promise.reject(
          new ProviderClientRuntimeStoreError(
            'COMPATIBILITY_PROBE_FAILED',
            'synthetic validation detail must not escape',
          ),
        ),
    });

    const status = await harness.service.update('codex');

    expect(status).toMatchObject({
      activeVersion: '1.0.0',
      previousVersion: null,
      availableVersion: '2.0.0',
      updateAvailable: true,
      status: 'error',
      lastErrorCode: 'UPDATE_VALIDATION_FAILED',
    });
    expect(JSON.stringify(status)).not.toContain('synthetic validation detail');
  });

  it('does not install when the injected clock cannot provide a timestamp', async () => {
    const harness = makeHarness({ now: () => new Date(Number.NaN) });

    const status = await harness.service.update('codex');

    expect(harness.install).not.toHaveBeenCalled();
    expect(status.status).toBe('error');
    expect(status.lastErrorCode).toBe('CLOCK_UNAVAILABLE');
  });

  it('stops before installation if time becomes invalid after release resolution', async () => {
    let calls = 0;
    const harness = makeHarness({
      now: () => {
        calls += 1;
        return calls === 1 ? new Date(FIXED_TIME) : new Date(Number.NaN);
      },
    });

    const status = await harness.service.update('codex');

    expect(harness.install).not.toHaveBeenCalled();
    expect(status.lastCheckedAt).toBe(FIXED_TIME);
    expect(status.lastErrorCode).toBe('CLOCK_UNAVAILABLE');
  });

  it('maps thrown clock reads and post-rollback timestamp failures safely', async () => {
    const throwingClock = makeHarness({
      now: () => {
        throw new Error('clock unavailable');
      },
    });
    const checkStatus = await throwingClock.service.check('codex');
    expect(checkStatus.lastErrorCode).toBe('CLOCK_UNAVAILABLE');

    const rollback = makeHarness({
      now: () => new Date(Number.NaN),
      rollback: () =>
        Promise.resolve(
          state('codex', {
            activeVersion: '1.0.0',
            activeSource: 'packaged',
            previousVersion: '2.0.0',
          }),
        ),
    });
    const rollbackStatus = await rollback.service.rollback('codex');
    expect(rollbackStatus.activeVersion).toBe('1.0.0');
    expect(rollbackStatus.lastErrorCode).toBe('CLOCK_UNAVAILABLE');
  });

  it('isolates provider operations and rejects unknown provider identifiers', async () => {
    const gate = deferred<unknown>();
    const harness = makeHarness({
      resolver: (providerId) =>
        providerId === 'codex' ? gate.promise : Promise.resolve(release(providerId)),
    });

    const codexCheck = harness.service.check('codex');
    await vi.waitFor(() => expect(harness.resolver).toHaveBeenCalledTimes(1));
    const antigravityCheck = await harness.service.check('antigravity');
    gate.resolve(release('codex'));
    await codexCheck;

    expect(antigravityCheck.providerId).toBe('antigravity');
    expect(harness.resolver).toHaveBeenCalledTimes(2);
    expect(() => harness.service.check('unknown' as ProviderClientId)).toThrow(
      'Unsupported provider client',
    );
  });
});
