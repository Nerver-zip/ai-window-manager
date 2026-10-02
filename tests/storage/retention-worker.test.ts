import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../src/scheduler/clock.js';
import { RetentionWorker } from '../../src/storage/retention-worker.js';
import type { RetentionMaintenanceResult } from '../../src/storage/retention.js';
import { LoopMonitor } from '../../src/scheduler/loop-monitor.js';

function batch(count: number): RetentionMaintenanceResult {
  return {
    asOfMs: 0,
    windowSamplesDeleted: 0,
    usageIntervalsDeleted: 0,
    eventsDeleted: { ordinary: 0, lifecycle: count, action: 0, security: 0 },
    terminalActionIntentsDeleted: 0,
    totalDeleted: count,
  };
}
afterEach(() => vi.useRealTimers());

describe('RetentionWorker', () => {
  it('tracks the entire pass and classifies local failures separately from completion', async () => {
    const clock = new FakeClock('2026-10-02T00:00:00Z');
    const monitor = new LoopMonitor(clock);
    monitor.register('retention', { intervalMs: 86_400_000, maxRunMs: 60_000 });
    let fail = false;
    const worker = new RetentionWorker({
      clock,
      idleIntervalMs: 86_400_000,
      processBatch: () => {
        expect(monitor.snapshot().loops[0]?.running).toBe(true);
        clock.advanceMs(10);
        if (fail) throw new Error('synthetic failure');
        return batch(0);
      },
      onError: vi.fn(),
      onPassStart: () => monitor.begin('retention'),
      onProgress: (progress) => monitor.finish('retention', progress.consecutiveFailures === 0),
    });
    await worker.runPass();
    expect(monitor.snapshot().loops[0]).toMatchObject({
      running: false,
      durationMs: 10,
      consecutiveFailures: 0,
    });
    fail = true;
    await worker.runPass();
    expect(monitor.snapshot().loops[0]).toMatchObject({ running: false, consecutiveFailures: 1 });
    await worker.stop();
  });

  it('publishes completed progress and reports publication failures without disabling continuation', async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn().mockImplementationOnce(() => {
      throw new Error('synthetic publication failure');
    });
    const onError = vi.fn();
    const worker = new RetentionWorker({
      clock: new FakeClock('2026-10-02T00:00:00Z'),
      idleIntervalMs: 1000,
      processBatch: () => batch(0),
      onProgress,
      onError,
    });
    worker.start();
    await worker.runPass();
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({
      running: false,
      batches: 1,
      pending: false,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onProgress).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('coalesces callers, bounds each pass and continues backlog without waiting a day', async () => {
    vi.useFakeTimers();
    let rows = 2_000;
    const processBatch = vi.fn(() => {
      const count = Math.min(500, rows);
      rows -= count;
      return batch(count);
    });
    const yields = vi.fn(() => Promise.resolve());
    const worker = new RetentionWorker({
      clock: new FakeClock('2026-10-02T00:00:00Z'),
      idleIntervalMs: 86_400_000,
      maxBatchesPerPass: 2,
      processBatch,
      yieldBetweenBatches: yields,
      onError: vi.fn(),
    });
    worker.start();
    const first = worker.runPass();
    expect(worker.runPass()).toBe(first);
    await first;
    expect(rows).toBe(1_000);
    expect(processBatch).toHaveBeenCalledTimes(2);
    expect(yields).toHaveBeenCalledTimes(1);
    expect(worker.snapshot()).toMatchObject({ pending: true, batches: 2, totalDeleted: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rows).toBe(0);
    expect(worker.snapshot().pending).toBe(false);
    const calls = processBatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(processBatch).toHaveBeenCalledTimes(calls);
    await worker.stop();
  });

  it('uses the injected monotonic budget and can stop while yielding', async () => {
    const clock = new FakeClock('2026-10-02T00:00:00Z');
    const processBatch = vi.fn(() => {
      clock.advanceMs(25);
      return batch(500);
    });
    const worker = new RetentionWorker({
      clock,
      idleIntervalMs: 86_400_000,
      processBatch,
      onError: vi.fn(),
    });
    await worker.runPass();
    expect(processBatch).toHaveBeenCalledTimes(1);
    expect(worker.snapshot()).toMatchObject({ durationMs: 25, pending: true });
    await worker.stop();
    await worker.runPass();
    expect(processBatch).toHaveBeenCalledTimes(1);

    let release!: () => void;
    let started!: () => void;
    const yielding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const process = vi.fn(() => batch(500));
    const second = new RetentionWorker({
      clock,
      idleIntervalMs: 86_400_000,
      processBatch: process,
      onError: vi.fn(),
      yieldBetweenBatches: () => {
        started();
        return barrier;
      },
    });
    const pass = second.runPass();
    await yielding;
    const stop = second.stop();
    release();
    await Promise.all([pass, stop]);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('backs off errors and recovers without starting concurrent maintenance', async () => {
    vi.useFakeTimers();
    const processBatch = vi
      .fn<() => RetentionMaintenanceResult>()
      .mockImplementationOnce(() => {
        throw new Error('synthetic retention failure');
      })
      .mockReturnValue(batch(0));
    const onError = vi.fn();
    const worker = new RetentionWorker({
      clock: new FakeClock('2026-10-02T00:00:00Z'),
      idleIntervalMs: 86_400_000,
      processBatch,
      onError,
    });
    worker.start();
    await worker.runPass();
    expect(worker.snapshot().consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.snapshot().consecutiveFailures).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid limits (%s)', (limit) => {
    expect(
      () =>
        new RetentionWorker({
          clock: new FakeClock('2026-10-02T00:00:00Z'),
          idleIntervalMs: limit,
          processBatch: () => batch(0),
          onError: vi.fn(),
        }),
    ).toThrow(RangeError);
  });
});
