import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderContext } from '../../src/providers/provider.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { ProviderInspectionCoordinator } from '../../src/providers/inspection-coordinator.js';
import { FakeClock } from '../../src/scheduler/clock.js';

interface Gate {
  signal: AbortSignal | undefined;
  release: () => void;
}

function controlledAdapter(id = 'fake'): { adapter: ProviderAdapter; calls: Gate[] } {
  const provider = new FakeProvider(new FakeClock('2026-09-14T08:00:00.000Z'), { id });
  const calls: Gate[] = [];
  const adapter: ProviderAdapter = {
    id,
    capabilities: () => provider.capabilities(),
    health: (context) => provider.health(context),
    inspect: async (context) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      calls.push({ signal: context.signal, release });
      await pending;
      return provider.inspect(context);
    },
  };
  return { adapter, calls };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('ProviderInspectionCoordinator', () => {
  it('coalesces concurrent reads and never caches a completed observation', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const { adapter, calls } = controlledAdapter();

    const first = coordinator.inspect(adapter);
    const second = coordinator.inspect(adapter);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    calls[0]!.release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    const later = coordinator.inspect(adapter);
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    calls[1]!.release();
    await expect(later).resolves.toMatchObject({ providerId: 'fake', health: 'UP' });
    await coordinator.close();
  });

  it('coalesces one queued fresh read behind an older observation', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const { adapter, calls } = controlledAdapter();

    const ordinary = coordinator.inspect(adapter);
    const firstFresh = coordinator.inspectFresh(adapter);
    const secondFresh = coordinator.inspectFresh(adapter);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);

    calls[0]!.release();
    await ordinary;
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    calls[1]!.release();
    const [first, second] = await Promise.all([firstFresh, secondFresh]);
    expect(first).toEqual(second);
    expect(calls).toHaveLength(2);
    await coordinator.close();
  });

  it('rejects a different client identity while a fresh read is queued', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const currentClient = controlledAdapter('fake');
    const replacement = controlledAdapter('fake');
    const ordinary = coordinator.inspect(currentClient.adapter);
    const queuedFresh = coordinator.inspectFresh(currentClient.adapter);
    const mismatched = coordinator.inspect(replacement.adapter);

    await expect(mismatched).rejects.toThrow('provider executable changed');
    currentClient.calls[0]!.release();
    await ordinary;
    await flushMicrotasks();
    currentClient.calls[1]!.release();
    await queuedFresh;
    expect(replacement.calls).toHaveLength(0);
    await coordinator.close();
  });

  it('lets ordinary and fresh callers share an active fresh inspection in the same epoch', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const { adapter, calls } = controlledAdapter();

    const first = coordinator.inspectFresh(adapter);
    const second = coordinator.inspectFresh(adapter);
    const ordinary = coordinator.inspect(adapter);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    calls[0]!.release();
    await expect(Promise.all([first, second, ordinary])).resolves.toHaveLength(3);
    await coordinator.close();
  });

  it('starts post-action confirmation only after any pre-action read completes', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const { adapter, calls } = controlledAdapter();

    const preflight = coordinator.inspectFresh(adapter);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    coordinator.markActionCompleted('fake');
    const confirmation = coordinator.inspectFresh(adapter);
    expect(coordinator.isInspecting('fake')).toBe(true);
    calls[0]!.release();
    await preflight;
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    calls[1]!.release();
    await expect(confirmation).resolves.toMatchObject({ providerId: 'fake', health: 'UP' });
    await coordinator.close();
  });

  it('keeps a fresh barrier queued when the action invalidates an older queued read', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const { adapter, calls } = controlledAdapter();
    const olderRead = coordinator.inspect(adapter);
    await flushMicrotasks();
    const firstFresh = coordinator.inspectFresh(adapter);
    coordinator.markActionCompleted(adapter.id);
    const postActionFresh = coordinator.inspectFresh(adapter);

    expect(coordinator.isInspecting(adapter.id)).toBe(true);
    calls[0]!.release();
    await olderRead;
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    calls[1]!.release();
    await expect(Promise.all([firstFresh, postActionFresh])).resolves.toHaveLength(2);
    await coordinator.close();
  });

  it('isolates a caller cancellation from another consumer of the shared read', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const { adapter, calls } = controlledAdapter();
    const controller = new AbortController();
    const canceled = coordinator.inspect(adapter, { signal: controller.signal });
    const remaining = coordinator.inspect(adapter);
    await flushMicrotasks();
    expect(calls).toHaveLength(1);

    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[0]!.signal?.aborted).toBe(false);
    calls[0]!.release();
    await expect(remaining).resolves.toMatchObject({ providerId: 'fake' });
    await coordinator.close();
  });

  it('does not start a read for a caller whose signal was already aborted', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const { adapter, calls } = controlledAdapter();
    const controller = new AbortController();
    controller.abort();

    await expect(coordinator.inspect(adapter, { signal: controller.signal })).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
    await flushMicrotasks();
    expect(calls).toHaveLength(0);
    await coordinator.close();
  });

  it('queues a fresh read after an action even when the active read uses the same client', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const { adapter, calls } = controlledAdapter();
    const oldRead = coordinator.inspect(adapter);
    await flushMicrotasks();
    coordinator.markActionCompleted(adapter.id);
    const freshRead = coordinator.inspect(adapter);

    calls[0]!.release();
    await oldRead;
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    calls[1]!.release();
    await freshRead;
    await coordinator.close();
  });

  it('returns idle state for unknown providers and permits repeated shutdown', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    expect(coordinator.isInspecting('unknown')).toBe(false);
    await coordinator.close();
    await coordinator.close();
    await expect(coordinator.inspectFresh(controlledAdapter().adapter)).rejects.toThrow(
      'coordinator is closed',
    );
  });

  it('normalizes a non-Error adapter rejection for a signal-bound caller', async () => {
    const adapter = {
      ...controlledAdapter().adapter,
      inspect: vi.fn().mockRejectedValue('synthetic rejection'),
    } satisfies ProviderAdapter;
    const coordinator = new ProviderInspectionCoordinator();

    await expect(
      coordinator.inspect(adapter, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      message: 'provider inspection failed with a non-Error rejection',
      cause: 'synthetic rejection',
    });
    await coordinator.close();
  });

  it('queues a replacement adapter instead of coalescing across client identities', async () => {
    const coordinator = new ProviderInspectionCoordinator();
    const firstClient = controlledAdapter('fake');
    const replacement = controlledAdapter('fake');
    const oldRead = coordinator.inspect(firstClient.adapter);
    const newRead = coordinator.inspect(replacement.adapter);
    const oldFreshRead = expect(coordinator.inspectFresh(firstClient.adapter)).rejects.toThrow(
      'provider executable changed while inspection was in flight',
    );
    await flushMicrotasks();
    expect(firstClient.calls).toHaveLength(1);
    expect(replacement.calls).toHaveLength(0);
    await oldFreshRead;

    firstClient.calls[0]!.release();
    await oldRead;
    await flushMicrotasks();
    expect(replacement.calls).toHaveLength(1);
    replacement.calls[0]!.release();
    await expect(newRead).resolves.toMatchObject({ providerId: 'fake' });
    await coordinator.close();
  });

  it('clears a failed in-flight read so a later inspection can recover', async () => {
    const provider = new FakeProvider(new FakeClock('2026-09-14T08:00:00.000Z'));
    const inspect = vi
      .fn<ProviderAdapter['inspect']>()
      .mockRejectedValueOnce(new Error('synthetic read failure'))
      .mockImplementation((context: ProviderContext) => provider.inspect(context));
    const adapter: ProviderAdapter = {
      id: provider.id,
      capabilities: () => provider.capabilities(),
      health: (context) => provider.health(context),
      inspect,
    };
    const coordinator = new ProviderInspectionCoordinator();

    await expect(coordinator.inspect(adapter)).rejects.toThrow('synthetic read failure');
    await expect(coordinator.inspect(adapter)).resolves.toMatchObject({ providerId: 'fake' });
    expect(inspect).toHaveBeenCalledTimes(2);
    await coordinator.close();
  });

  it('rejects queued work and aborts active work during shutdown', async () => {
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const inspect = vi.fn(
      (context: ProviderContext) =>
        new Promise<Awaited<ReturnType<ProviderAdapter['inspect']>>>((_resolve, reject) => {
          started();
          context.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('inspection aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );
    const adapter = controlledAdapter().adapter;
    const abortableAdapter: ProviderAdapter = { ...adapter, inspect };
    const coordinator = new ProviderInspectionCoordinator();
    const active = coordinator.inspect(abortableAdapter);
    await hasStarted;
    const queued = coordinator.inspectFresh(abortableAdapter);

    await coordinator.close();
    await expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toThrow('coordinator is closed');
    await expect(coordinator.inspect(abortableAdapter)).rejects.toThrow('coordinator is closed');
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
