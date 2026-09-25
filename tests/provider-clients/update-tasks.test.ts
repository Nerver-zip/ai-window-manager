import { describe, expect, it, vi } from 'vitest';
import { ProviderClientUpdateTasks } from '../../src/provider-clients/update-tasks.js';
import type { ProviderClientId } from '../../src/provider-clients/runtime-store.js';
import type {
  ProviderClientUpdateService,
  ProviderClientUpdateStatus,
} from '../../src/provider-clients/update-service.js';

const NOW = '2026-09-25T12:00:00.000Z';

function status(
  providerId: ProviderClientId = 'codex',
  overrides: Partial<ProviderClientUpdateStatus> = {},
): ProviderClientUpdateStatus {
  return {
    providerId,
    packagedVersion: '1.0.0',
    activeVersion: '1.0.0',
    previousVersion: null,
    availableVersion: null,
    updateAvailable: false,
    status: 'current',
    lastCheckedAt: NOW,
    lastUpdatedAt: null,
    lastErrorCode: null,
    ...overrides,
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

function harness(
  overrides: Partial<Pick<ProviderClientUpdateService, 'check' | 'update' | 'rollback'>> = {},
) {
  const service: Pick<ProviderClientUpdateService, 'check' | 'update' | 'rollback'> = {
    check: overrides.check ?? vi.fn(() => Promise.resolve(status())),
    update:
      overrides.update ?? vi.fn(() => Promise.resolve(status('codex', { status: 'updated' }))),
    rollback:
      overrides.rollback ??
      vi.fn(() => Promise.resolve(status('codex', { status: 'rolled_back' }))),
  };
  const onRuntimeChanged = vi.fn();
  const onAutomaticUpdateFinished = vi.fn();
  const tasks = new ProviderClientUpdateTasks({
    service,
    clock: { now: () => new Date(NOW) },
    onRuntimeChanged,
    onAutomaticUpdateFinished,
  });
  return { tasks, service, onRuntimeChanged, onAutomaticUpdateFinished };
}

describe('ProviderClientUpdateTasks', () => {
  it('exposes safe idle snapshots and rejects unknown provider IDs', () => {
    const { tasks } = harness();
    expect(tasks.get('codex')).toEqual({
      providerId: 'codex',
      state: 'idle',
      startedAt: null,
      finishedAt: null,
      lastErrorCode: null,
    });
    expect(() => tasks.get('fake' as ProviderClientId)).toThrow(/Unsupported/);
    expect(() => tasks.isRunning('fake' as ProviderClientId)).toThrow(/Unsupported/);
    expect(tasks.isRunning('codex')).toBe(false);
  });

  it('keeps HTTP work asynchronous, reports progress and coalesces duplicate operations', async () => {
    const gate = deferred<ProviderClientUpdateStatus>();
    const check = vi.fn(() => gate.promise);
    const { tasks } = harness({ check });

    expect(tasks.startCheck('codex')).toBe(true);
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(tasks.get('codex')).toMatchObject({ state: 'checking', startedAt: NOW });
    expect(tasks.isRunning('codex')).toBe(true);
    expect(tasks.isRuntimeChanging('codex')).toBe(false);
    expect(tasks.startCheck('codex')).toBe(false);
    expect(tasks.startUpdate('codex')).toBe(false);

    gate.resolve(status());
    await vi.waitFor(() => expect(tasks.isRunning('codex')).toBe(false));
    expect(tasks.get('codex')).toMatchObject({
      state: 'completed',
      startedAt: NOW,
      finishedAt: NOW,
      lastErrorCode: null,
    });
  });

  it('marks bounded service errors without persisting raw exception details', async () => {
    const { tasks } = harness({
      check: vi.fn(() =>
        Promise.resolve(
          status('codex', { status: 'error', lastErrorCode: 'RELEASE_RESOLUTION_FAILED' }),
        ),
      ),
    });

    expect(tasks.startCheck('codex')).toBe(true);
    await vi.waitFor(() => expect(tasks.isRunning('codex')).toBe(false));
    expect(tasks.get('codex')).toMatchObject({
      state: 'failed',
      lastErrorCode: 'RELEASE_RESOLUTION_FAILED',
    });

    const throwing = harness({
      update: vi.fn(() => Promise.reject(new Error('secret URL and provider path'))),
    });
    expect(throwing.tasks.startUpdate('codex')).toBe(true);
    await vi.waitFor(() => expect(throwing.tasks.isRunning('codex')).toBe(false));
    expect(throwing.tasks.get('codex')).toMatchObject({
      state: 'failed',
      lastErrorCode: 'PROVIDER_CLIENT_OPERATION_FAILED',
    });
    expect(JSON.stringify(throwing.tasks.get('codex'))).not.toMatch(/secret|provider path/);
  });

  it('updates only when the stable check reports a newer release', async () => {
    const check = vi.fn(() => Promise.resolve(status()));
    const update = vi.fn(() => Promise.resolve(status('codex', { status: 'updated' })));
    const notNeeded = harness({ check, update });
    expect(notNeeded.tasks.startAutomaticUpdate('codex')).toBe(true);
    await vi.waitFor(() => expect(notNeeded.tasks.isRunning('codex')).toBe(false));
    expect(check).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(notNeeded.onAutomaticUpdateFinished).toHaveBeenCalledExactlyOnceWith('codex', true);

    const latest = status('codex', { updateAvailable: true, status: 'update_available' });
    const needed = harness({ check: vi.fn(() => Promise.resolve(latest)), update });
    expect(needed.tasks.startAutomaticUpdate('codex')).toBe(true);
    await vi.waitFor(() => expect(needed.tasks.isRunning('codex')).toBe(false));
    expect(update).toHaveBeenCalledTimes(1);
    expect(needed.tasks.get('codex')).toMatchObject({ state: 'completed' });
    expect(needed.onAutomaticUpdateFinished).toHaveBeenCalledExactlyOnceWith('codex', true);

    const failed = harness({
      check: vi.fn(() => Promise.resolve(status('codex', { status: 'error' }))),
    });
    expect(failed.tasks.startAutomaticUpdate('codex')).toBe(true);
    await vi.waitFor(() => expect(failed.tasks.isRunning('codex')).toBe(false));
    expect(failed.onAutomaticUpdateFinished).toHaveBeenCalledExactlyOnceWith('codex', false);
  });

  it('handles rollback progress and asks the application to reconcile after runtime changes', async () => {
    const gate = deferred<ProviderClientUpdateStatus>();
    const rollback = vi.fn(() => gate.promise);
    const { tasks, onRuntimeChanged } = harness({ rollback });

    expect(tasks.startRollback('codex')).toBe(true);
    await vi.waitFor(() => expect(rollback).toHaveBeenCalledTimes(1));
    expect(tasks.get('codex').state).toBe('rolling_back');
    expect(tasks.isRuntimeChanging('codex')).toBe(true);
    gate.resolve(status('codex', { status: 'rolled_back' }));
    await vi.waitFor(() => expect(tasks.isRunning('codex')).toBe(false));
    expect(tasks.get('codex').state).toBe('completed');
    expect(tasks.isRuntimeChanging('codex')).toBe(false);
    expect(onRuntimeChanged).toHaveBeenCalledExactlyOnceWith('codex');

    const update = harness();
    update.tasks.startUpdate('codex');
    await vi.waitFor(() => expect(update.tasks.isRunning('codex')).toBe(false));
    expect(update.onRuntimeChanged).toHaveBeenCalledExactlyOnceWith('codex');
  });

  it('fails closed when the clock is invalid and drains active work during shutdown', async () => {
    const taskService: Pick<ProviderClientUpdateService, 'check' | 'update' | 'rollback'> = {
      check: vi.fn(() => Promise.resolve(status())),
      update: vi.fn(() => Promise.resolve(status('codex', { status: 'updated' }))),
      rollback: vi.fn(() => Promise.resolve(status('codex', { status: 'rolled_back' }))),
    };
    const invalidClock = new ProviderClientUpdateTasks({
      service: taskService,
      clock: { now: () => new Date(Number.NaN) },
    });
    expect(invalidClock.startCheck('codex')).toBe(false);
    expect(invalidClock.get('codex')).toMatchObject({
      state: 'failed',
      lastErrorCode: 'CLOCK_UNAVAILABLE',
    });

    const gate = deferred<ProviderClientUpdateStatus>();
    const { tasks } = harness({ check: () => gate.promise });
    expect(tasks.startCheck('antigravity')).toBe(true);
    await vi.waitFor(() => expect(tasks.isRunning('antigravity')).toBe(true));
    let closed = false;
    const closing = tasks.close().then(() => {
      closed = true;
    });
    expect(tasks.startCheck('codex')).toBe(false);
    expect(closed).toBe(false);
    gate.resolve(status('antigravity'));
    await closing;
    expect(closed).toBe(true);
  });
});
