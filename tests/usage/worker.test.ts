import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageAggregationWorker } from '../../src/usage/worker.js';
import type { AggregationBatchResult } from '../../src/usage/service.js';

const emptyBatch: AggregationBatchResult = { processed: 0, lastSampleId: 0, pending: false };

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageAggregationWorker', () => {
  it('defers pre-start requests, coalesces bursts, and keeps an idle fallback at 60 seconds', async () => {
    vi.useFakeTimers();
    const processBatch = vi.fn(() => emptyBatch);
    const worker = new UsageAggregationWorker({ processBatch, onError: vi.fn() });

    worker.request();
    expect(processBatch).not.toHaveBeenCalled();
    worker.start();
    worker.request();
    worker.request();
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(processBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processBatch).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('does not run a queued pump if stopped before its microtask starts', async () => {
    const processBatch = vi.fn(() => emptyBatch);
    const worker = new UsageAggregationWorker({ processBatch, onError: vi.fn() });

    worker.start();
    await worker.stop();
    await flushMicrotasks();
    worker.start();
    worker.request();
    expect(processBatch).not.toHaveBeenCalled();
  });

  it('yields between bounded backlog batches and drains the requested backlog', async () => {
    const processBatch = vi
      .fn<() => AggregationBatchResult>()
      .mockReturnValueOnce({ processed: 500, lastSampleId: 500, pending: true })
      .mockReturnValueOnce({ processed: 500, lastSampleId: 1_000, pending: true })
      .mockReturnValueOnce({ processed: 2, lastSampleId: 1_002, pending: false });
    const yieldBetweenBatches = vi.fn(() => Promise.resolve());
    const worker = new UsageAggregationWorker({
      processBatch,
      onError: vi.fn(),
      yieldBetweenBatches,
    });

    worker.start();
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(3);
    expect(yieldBetweenBatches).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('coalesces a request arriving during backlog processing and drains it afterwards', async () => {
    const workerRef: { current: UsageAggregationWorker | undefined } = { current: undefined };
    let requestDuringYield = true;
    const processBatch = vi
      .fn<() => AggregationBatchResult>()
      .mockReturnValueOnce({ processed: 500, lastSampleId: 500, pending: true })
      .mockReturnValueOnce({ processed: 12, lastSampleId: 512, pending: false })
      .mockReturnValueOnce(emptyBatch);
    const yieldBetweenBatches = vi.fn(() => {
      if (requestDuringYield) {
        requestDuringYield = false;
        workerRef.current?.request();
      }
      return Promise.resolve();
    });
    const worker = new UsageAggregationWorker({
      processBatch,
      onError: vi.fn(),
      yieldBetweenBatches,
    });
    workerRef.current = worker;

    worker.start();
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(3);
    expect(yieldBetweenBatches).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('backs off after a batch error and retries without losing the request', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const processBatch = vi
      .fn<() => AggregationBatchResult>()
      .mockImplementationOnce(() => {
        throw new Error('synthetic aggregation failure');
      })
      .mockReturnValue(emptyBatch);
    const worker = new UsageAggregationWorker({
      processBatch,
      onError,
      errorRetryBaseMs: 1_000,
      errorRetryMaxMs: 4_000,
    });

    worker.start();
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'synthetic aggregation failure' }),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(processBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('caps exponential retries after consecutive aggregation errors', async () => {
    vi.useFakeTimers();
    const processBatch = vi
      .fn<() => AggregationBatchResult>()
      .mockImplementationOnce(() => {
        throw new Error('retry 1');
      })
      .mockImplementationOnce(() => {
        throw new Error('retry 2');
      })
      .mockImplementationOnce(() => {
        throw new Error('retry 3');
      })
      .mockImplementationOnce(() => {
        throw new Error('retry 4');
      })
      .mockReturnValue(emptyBatch);
    const worker = new UsageAggregationWorker({
      processBatch,
      onError: vi.fn(),
      errorRetryBaseMs: 1_000,
      errorRetryMaxMs: 4_000,
    });

    worker.start();
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(processBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(processBatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(processBatch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(processBatch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(5);
    await worker.stop();
  });

  it('stops at a batch boundary and waits for the active yield before shutdown', async () => {
    let release!: () => void;
    const blockedYield = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processBatch = vi.fn(() => ({ processed: 500, lastSampleId: 500, pending: true }));
    const worker = new UsageAggregationWorker({
      processBatch,
      onError: vi.fn(),
      yieldBetweenBatches: () => blockedYield,
    });

    worker.start();
    await flushMicrotasks();
    expect(processBatch).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(stopped).toBe(true);
    expect(processBatch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid retry and fallback intervals', () => {
    expect(
      () =>
        new UsageAggregationWorker({
          processBatch: () => emptyBatch,
          onError: vi.fn(),
          fallbackIntervalMs: 0,
        }),
    ).toThrow('fallbackIntervalMs must be a positive safe integer');
    expect(
      () =>
        new UsageAggregationWorker({
          processBatch: () => emptyBatch,
          onError: vi.fn(),
          errorRetryMaxMs: 4_000,
        }),
    ).toThrow('errorRetryMaxMs must be at least errorRetryBaseMs');
  });
});
