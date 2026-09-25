import type { Clock } from '../scheduler/clock.js';
import { PROVIDER_CLIENT_IDS, type ProviderClientId } from './runtime-store.js';
import type { ProviderClientUpdateService, ProviderClientUpdateStatus } from './update-service.js';

export type ProviderClientUpdateTaskState =
  'idle' | 'checking' | 'updating' | 'rolling_back' | 'completed' | 'failed';

export interface ProviderClientUpdateTaskSnapshot {
  readonly providerId: ProviderClientId;
  readonly state: ProviderClientUpdateTaskState;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface ProviderClientUpdateTasksOptions {
  readonly service: Pick<ProviderClientUpdateService, 'check' | 'update' | 'rollback'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly onRuntimeChanged?: (providerId: ProviderClientId) => void;
  readonly onAutomaticUpdateFinished?: (providerId: ProviderClientId, successful: boolean) => void;
}

const OPERATION_FAILED = 'PROVIDER_CLIENT_OPERATION_FAILED';

function initialSnapshot(providerId: ProviderClientId): ProviderClientUpdateTaskSnapshot {
  return {
    providerId,
    state: 'idle',
    startedAt: null,
    finishedAt: null,
    lastErrorCode: null,
  };
}

function isProviderClientId(value: string): value is ProviderClientId {
  return (PROVIDER_CLIENT_IDS as readonly string[]).includes(value);
}

function assertProviderClientId(value: string): asserts value is ProviderClientId {
  if (!isProviderClientId(value)) throw new RangeError('Unsupported provider client');
}

function clone(snapshot: ProviderClientUpdateTaskSnapshot): ProviderClientUpdateTaskSnapshot {
  return { ...snapshot };
}

function isoNow(clock: Pick<Clock, 'now'>): string | null {
  try {
    const now = clock.now();
    return Number.isFinite(now.getTime()) ? now.toISOString() : null;
  } catch {
    return null;
  }
}

function resultError(status: ProviderClientUpdateStatus): string | null {
  if (status.status === 'error' || status.status === 'blocked') {
    return status.lastErrorCode ?? OPERATION_FAILED;
  }
  return null;
}

/** Keeps slow check/update/rollback work off HTTP requests and exposes bounded progress. */
export class ProviderClientUpdateTasks {
  private readonly snapshots = new Map<ProviderClientId, ProviderClientUpdateTaskSnapshot>();
  private readonly active = new Map<ProviderClientId, Promise<void>>();
  private stopping = false;

  constructor(private readonly options: ProviderClientUpdateTasksOptions) {
    for (const providerId of PROVIDER_CLIENT_IDS) {
      this.snapshots.set(providerId, initialSnapshot(providerId));
    }
  }

  get(providerId: ProviderClientId): ProviderClientUpdateTaskSnapshot {
    assertProviderClientId(providerId);
    return clone(this.snapshots.get(providerId) ?? initialSnapshot(providerId));
  }

  isRunning(providerId: ProviderClientId): boolean {
    assertProviderClientId(providerId);
    return this.active.has(providerId);
  }

  isRuntimeChanging(providerId: ProviderClientId): boolean {
    assertProviderClientId(providerId);
    const state = this.snapshots.get(providerId)?.state;
    return state === 'updating' || state === 'rolling_back';
  }

  startCheck(providerId: ProviderClientId): boolean {
    assertProviderClientId(providerId);
    return this.launch(providerId, 'checking', async () => this.options.service.check(providerId));
  }

  startUpdate(providerId: ProviderClientId): boolean {
    assertProviderClientId(providerId);
    return this.launch(
      providerId,
      'updating',
      async () => this.options.service.update(providerId),
      true,
    );
  }

  startRollback(providerId: ProviderClientId): boolean {
    assertProviderClientId(providerId);
    return this.launch(
      providerId,
      'rolling_back',
      async () => this.options.service.rollback(providerId),
      true,
    );
  }

  startAutomaticUpdate(providerId: ProviderClientId): boolean {
    assertProviderClientId(providerId);
    return this.launch(
      providerId,
      'checking',
      async (setState) => {
        const checked = await this.options.service.check(providerId);
        if (!checked.updateAvailable) return checked;
        setState('updating');
        return this.options.service.update(providerId);
      },
      true,
      (status) => {
        try {
          this.options.onAutomaticUpdateFinished?.(
            providerId,
            status.status !== 'error' && status.status !== 'blocked',
          );
        } catch {
          // Persisting cadence metadata must not change the already-completed update result.
        }
      },
    );
  }

  async close(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.active.values());
  }

  private launch(
    providerId: ProviderClientId,
    initialState: Extract<ProviderClientUpdateTaskState, 'checking' | 'updating' | 'rolling_back'>,
    operation: (
      setState: (state: Extract<ProviderClientUpdateTaskState, 'checking' | 'updating'>) => void,
    ) => Promise<ProviderClientUpdateStatus>,
    runtimeMayChange = false,
    onResult?: (status: ProviderClientUpdateStatus) => void,
  ): boolean {
    if (this.stopping || this.active.has(providerId)) return false;
    const startedAt = isoNow(this.options.clock);
    this.snapshots.set(providerId, {
      providerId,
      state: startedAt ? initialState : 'failed',
      startedAt,
      finishedAt: startedAt ? null : isoNow(this.options.clock),
      lastErrorCode: startedAt ? null : 'CLOCK_UNAVAILABLE',
    });
    if (!startedAt) return false;

    const setState = (state: Extract<ProviderClientUpdateTaskState, 'checking' | 'updating'>) => {
      const current = this.snapshots.get(providerId);
      if (current?.startedAt === startedAt) this.snapshots.set(providerId, { ...current, state });
    };

    const pending = Promise.resolve()
      .then(() => operation(setState))
      .then((status) => {
        const errorCode = resultError(status);
        this.finish(providerId, startedAt, errorCode ? 'failed' : 'completed', errorCode);
        try {
          onResult?.(status);
        } catch {
          // The update status remains authoritative if a lifecycle notification fails.
        }
        if (runtimeMayChange) {
          try {
            this.options.onRuntimeChanged?.(providerId);
          } catch {
            // A failed refresh hint must not alter the already persisted update result.
          }
        }
      })
      .catch(() => {
        this.finish(providerId, startedAt, 'failed', OPERATION_FAILED);
      })
      .finally(() => {
        if (this.active.get(providerId) === pending) this.active.delete(providerId);
      });
    this.active.set(providerId, pending);
    return true;
  }

  private finish(
    providerId: ProviderClientId,
    startedAt: string,
    state: Extract<ProviderClientUpdateTaskState, 'completed' | 'failed'>,
    lastErrorCode: string | null,
  ): void {
    const current = this.snapshots.get(providerId);
    if (current?.startedAt !== startedAt) return;
    this.snapshots.set(providerId, {
      ...current,
      state,
      finishedAt: isoNow(this.options.clock),
      lastErrorCode,
    });
  }
}
