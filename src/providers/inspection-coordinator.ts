import type { ProviderObservation } from '../domain/types.js';
import type { ProviderAdapter, ProviderContext } from './provider.js';

interface ActiveInspection {
  adapter: ProviderAdapter;
  epoch: number;
  fresh: boolean;
  controller: AbortController;
  promise: Promise<ProviderObservation>;
}

interface PendingInspection {
  adapter: ProviderAdapter;
  epoch: number;
  promise: Promise<ProviderObservation>;
  resolve: (observation: ProviderObservation) => void;
  reject: (error: unknown) => void;
}

interface ProviderInspectionState {
  epoch: number;
  actionCompletedEpoch: number | undefined;
  active: ActiveInspection | undefined;
  pendingFresh: PendingInspection | undefined;
}

/** Coordinates only in-flight reads; completed observations are never cached. */
export class ProviderInspectionCoordinator {
  private readonly states = new Map<string, ProviderInspectionState>();
  private closed = false;

  inspect(adapter: ProviderAdapter, context: ProviderContext = {}): Promise<ProviderObservation> {
    if (this.closed) return Promise.reject(shutdownError());
    if (context.signal?.aborted) return Promise.reject(callerAbortedError());
    const state = this.stateFor(adapter.id);
    const pending = state.pendingFresh;
    if (pending) {
      if (pending.adapter !== adapter) return Promise.reject(runtimeChangedError());
      pending.epoch = state.epoch;
      return withCallerSignal(pending.promise, context.signal);
    }

    const active = state.active;
    if (active?.adapter === adapter && active.epoch === state.epoch) {
      return withCallerSignal(active.promise, context.signal);
    }
    if (active) {
      if (active.adapter !== adapter) state.epoch += 1;
      return withCallerSignal(this.queueFresh(state, adapter), context.signal);
    }
    return withCallerSignal(this.start(state, adapter, state.epoch, false), context.signal);
  }

  /**
   * Starts after any read that predates the latest action, or joins a fresh
   * read already started in the current epoch. A reconciliation read started
   * after action completion may satisfy confirmation without another CLI call.
   */
  inspectFresh(
    adapter: ProviderAdapter,
    context: ProviderContext = {},
  ): Promise<ProviderObservation> {
    if (this.closed) return Promise.reject(shutdownError());
    if (context.signal?.aborted) return Promise.reject(callerAbortedError());
    const state = this.stateFor(adapter.id);
    const pending = state.pendingFresh;
    if (pending) {
      if (pending.adapter !== adapter) return Promise.reject(runtimeChangedError());
      pending.epoch = state.epoch;
      return withCallerSignal(pending.promise, context.signal);
    }

    const active = state.active;
    if (
      active?.adapter === adapter &&
      active.epoch === state.epoch &&
      (active.fresh || active.epoch === state.actionCompletedEpoch)
    ) {
      return withCallerSignal(active.promise, context.signal);
    }

    state.epoch += 1;
    if (active) {
      return withCallerSignal(this.queueFresh(state, adapter), context.signal);
    }
    return withCallerSignal(this.start(state, adapter, state.epoch, true), context.signal);
  }

  /** Invalidates inspections that began before a provider action completed. */
  markActionCompleted(providerId: string): void {
    const state = this.stateFor(providerId);
    state.epoch += 1;
    state.actionCompletedEpoch = state.epoch;
    if (state.pendingFresh) state.pendingFresh.epoch = state.epoch;
  }

  isInspecting(providerId: string): boolean {
    const state = this.states.get(providerId);
    return Boolean(state?.active || state?.pendingFresh);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active: Promise<unknown>[] = [];
    for (const state of this.states.values()) {
      if (state.pendingFresh) {
        state.pendingFresh.reject(shutdownError());
        state.pendingFresh = undefined;
      }
      if (state.active) {
        state.active.controller.abort();
        active.push(state.active.promise);
      }
    }
    await Promise.allSettled(active);
  }

  private stateFor(providerId: string): ProviderInspectionState {
    let state = this.states.get(providerId);
    if (!state) {
      state = {
        epoch: 0,
        actionCompletedEpoch: undefined,
        active: undefined,
        pendingFresh: undefined,
      };
      this.states.set(providerId, state);
    }
    return state;
  }

  private queueFresh(
    state: ProviderInspectionState,
    adapter: ProviderAdapter,
  ): Promise<ProviderObservation> {
    const existing = state.pendingFresh;
    if (existing) {
      if (existing.adapter !== adapter) return Promise.reject(runtimeChangedError());
      existing.epoch = state.epoch;
      return existing.promise;
    }

    let resolve!: (observation: ProviderObservation) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ProviderObservation>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // A pending read can outlive every caller that requested it. Keep shutdown
    // rejection handled even when all callers have independently canceled.
    void promise.catch(() => undefined);
    state.pendingFresh = { adapter, epoch: state.epoch, promise, resolve, reject };
    return promise;
  }

  private start(
    state: ProviderInspectionState,
    adapter: ProviderAdapter,
    epoch: number,
    fresh: boolean,
  ): Promise<ProviderObservation> {
    const controller = new AbortController();
    const active: ActiveInspection = {
      adapter,
      epoch,
      fresh,
      controller,
      promise: Promise.resolve().then(() => adapter.inspect({ signal: controller.signal })),
    };
    active.promise = active.promise.finally(() => {
      if (state.active === active) state.active = undefined;
      if (!this.closed && state.pendingFresh) {
        const pending = state.pendingFresh;
        state.pendingFresh = undefined;
        const next = this.start(state, pending.adapter, Math.max(pending.epoch, state.epoch), true);
        void next.then(pending.resolve, pending.reject);
      }
    });
    state.active = active;
    return active.promise;
  }
}

function withCallerSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(callerAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(callerAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(asError(error));
      },
    );
  });
}

function callerAbortedError(): Error {
  const error = new Error('provider inspection caller aborted');
  error.name = 'AbortError';
  return error;
}

function shutdownError(): Error {
  return new Error('provider inspection coordinator is closed');
}

function runtimeChangedError(): Error {
  return new Error('provider executable changed while inspection was in flight');
}

function asError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('provider inspection failed with a non-Error rejection', { cause: reason });
}
