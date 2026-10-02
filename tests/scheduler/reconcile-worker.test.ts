import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReconcileWorker } from '../../src/scheduler/reconcile-worker.js';

async function flush(): Promise<void> {
  for (let n = 0; n < 15; n++) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());

describe('ReconcileWorker', () => {
  it('waits for an actual in-flight read on stop and cancels a queued wakeup', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = vi.fn(async () => {
      await barrier;
      return ['codex'];
    });
    const worker = new ReconcileWorker({
      providerIds: ['codex'],
      intervalMs: 30_000,
      work,
      onError: vi.fn(),
    });
    worker.start();
    worker.start();
    worker.request('codex');
    await flush();
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await worker.runOnce();
    expect(work).toHaveBeenCalledTimes(1);
    const queuedWork = vi.fn(() => Promise.resolve([]));
    const queued = new ReconcileWorker({
      providerIds: [],
      intervalMs: 30_000,
      work: queuedWork,
      onError: vi.fn(),
    });
    queued.start();
    queued.request();
    await queued.stop();
    await flush();
    expect(queuedWork).not.toHaveBeenCalled();
  });

  it('coalesces a burst without synchronously doing work and bounds providers', async () => {
    vi.useFakeTimers();
    const work = vi.fn((hints: ReadonlySet<string>) => Promise.resolve([...hints]));
    const worker = new ReconcileWorker({
      providerIds: ['codex'],
      intervalMs: 30_000,
      work,
      onError: vi.fn(),
    });
    worker.request('codex');
    worker.start();
    for (let n = 0; n < 1000; n++) worker.request('codex');
    expect(worker.request('unconfigured')).toBe(false);
    expect(work).not.toHaveBeenCalled();
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
    expect(worker.pendingProviderIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work).toHaveBeenCalledTimes(2);
    await worker.stop();
    expect(worker.request('codex')).toBe(false);
  });

  it('keeps an in-flight hint generation and never overlaps reconciliation', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let active = 0;
    let peak = 0;
    const worker = new ReconcileWorker({
      providerIds: ['codex'],
      intervalMs: 30_000,
      onError: vi.fn(),
      work: async (hints) => {
        active++;
        peak = Math.max(peak, active);
        calls++;
        if (calls === 1) await barrier;
        active--;
        return [...hints];
      },
    });
    worker.start();
    worker.request('codex');
    await flush();
    const running = worker.runOnce();
    expect(worker.runOnce()).toBe(running);
    worker.request('codex');
    worker.request('codex');
    await flush();
    expect(calls).toBe(1);
    release();
    await running;
    await flush();
    expect(calls).toBe(2);
    expect(peak).toBe(1);
    expect(worker.pendingProviderIds()).toEqual([]);
    await worker.stop();
  });

  it('retains deferred hints for periodic recovery without a busy loop', async () => {
    vi.useFakeTimers();
    const work = vi.fn(() => Promise.resolve([] as string[]));
    const worker = new ReconcileWorker({
      providerIds: ['codex'],
      intervalMs: 30_000,
      work,
      onError: vi.fn(),
    });
    worker.start();
    worker.request('codex');
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
    expect(worker.pendingProviderIds()).toEqual(['codex']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('reports failures, recovers periodically and waits for work on shutdown', async () => {
    vi.useFakeTimers();
    const error = new Error('synthetic failure');
    const onError = vi.fn();
    const work = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(['codex']);
    const worker = new ReconcileWorker({
      providerIds: ['codex'],
      intervalMs: 30_000,
      work,
      onError,
    });
    worker.start();
    worker.request('codex');
    await flush();
    expect(onError).toHaveBeenCalledWith(error);
    expect(worker.pendingProviderIds()).toEqual(['codex']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.pendingProviderIds()).toEqual([]);
    worker.request('codex');
    await worker.stop();
    await flush();
    expect(work).toHaveBeenCalledTimes(2);
    expect(() => new ReconcileWorker({ providerIds: [], intervalMs: 0, work, onError })).toThrow();
    expect(
      () =>
        new ReconcileWorker({
          providerIds: Array.from({ length: 65 }, (_, n) => String(n)),
          intervalMs: 1,
          work,
          onError,
        }),
    ).toThrow();
  });
});
