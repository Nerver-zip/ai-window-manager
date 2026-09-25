import {
  compareStableVersions,
  discoverLatestStableRelease,
  type OfficialReleaseSource,
  type ProviderArchitecture,
} from '../../scripts/provider-clients-core.js';
import type { Clock } from '../scheduler/clock.js';
import {
  PROVIDER_CLIENT_IDS,
  ProviderClientRuntimeStoreError,
  type ProviderClientId,
  type RuntimeStoreErrorCode,
} from './runtime-store.js';
import type {
  ProviderClientRuntimeState,
  ProviderClientRuntimeStore,
  RuntimeClientCandidate,
} from './runtime-store.js';

export type ProviderClientUpdateStatusCode =
  | 'idle'
  | 'checking'
  | 'current'
  | 'update_available'
  | 'updating'
  | 'updated'
  | 'rolling_back'
  | 'rolled_back'
  | 'blocked'
  | 'error';

export type ProviderClientUpdateErrorCode =
  | 'UPDATE_BLOCKED_PROVIDER_BUSY'
  | 'RUNTIME_STATE_UNAVAILABLE'
  | 'RELEASE_RESOLUTION_FAILED'
  | 'UPDATE_INSTALL_FAILED'
  | 'UPDATE_VALIDATION_FAILED'
  | 'ROLLBACK_FAILED'
  | 'CLOCK_UNAVAILABLE';

/** Safe runtime summary. It deliberately excludes release metadata and executable paths. */
export interface ProviderClientUpdateStatus {
  readonly providerId: ProviderClientId;
  readonly packagedVersion: string | null;
  readonly activeVersion: string | null;
  readonly previousVersion: string | null;
  /** Latest published stable version observed by a successful check, whether newer or not. */
  readonly availableVersion: string | null;
  readonly updateAvailable: boolean;
  readonly status: ProviderClientUpdateStatusCode;
  readonly lastCheckedAt: string | null;
  readonly lastUpdatedAt: string | null;
  readonly lastErrorCode: ProviderClientUpdateErrorCode | null;
}

export interface ProviderClientUpdateServiceOptions {
  readonly runtimeStore: Pick<ProviderClientRuntimeStore, 'getState' | 'install' | 'rollback'>;
  /** Must resolve metadata from the official release source, not from browser input. */
  readonly resolveOfficialRelease: OfficialReleaseSource;
  readonly architecture: ProviderArchitecture;
  readonly clock: Pick<Clock, 'now'>;
  /** True means an action/session is in flight and runtime replacement is unsafe. */
  readonly isProviderBusy: (providerId: ProviderClientId) => boolean | Promise<boolean>;
}

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function initialStatus(providerId: ProviderClientId): ProviderClientUpdateStatus {
  return {
    providerId,
    packagedVersion: null,
    activeVersion: null,
    previousVersion: null,
    availableVersion: null,
    updateAvailable: false,
    status: 'idle',
    lastCheckedAt: null,
    lastUpdatedAt: null,
    lastErrorCode: null,
  };
}

function safeVersion(version: unknown): string | null {
  return typeof version === 'string' && STABLE_VERSION_PATTERN.test(version) ? version : null;
}

function isProviderClientId(value: string): value is ProviderClientId {
  return (PROVIDER_CLIENT_IDS as readonly string[]).includes(value);
}

function assertProviderClientId(value: string): asserts value is ProviderClientId {
  if (!isProviderClientId(value)) throw new RangeError('Unsupported provider client');
}

function cloneStatus(status: ProviderClientUpdateStatus): ProviderClientUpdateStatus {
  return { ...status };
}

function hasNewerAvailableVersion(status: ProviderClientUpdateStatus): boolean {
  if (!status.activeVersion || !status.availableVersion) return false;
  return compareStableVersions(status.availableVersion, status.activeVersion) > 0;
}

function statusFromRuntime(
  status: ProviderClientUpdateStatus,
  runtime: ProviderClientRuntimeState,
): ProviderClientUpdateStatus {
  const next = {
    ...status,
    packagedVersion: safeVersion(runtime.packagedVersion),
    activeVersion: safeVersion(runtime.activeVersion),
    previousVersion: safeVersion(runtime.previousVersion),
  };
  return { ...next, updateAvailable: hasNewerAvailableVersion(next) };
}

function releaseStatus(
  status: ProviderClientUpdateStatus,
  availableVersion: string,
): ProviderClientUpdateStatus {
  const next = { ...status, availableVersion };
  const updateAvailable = hasNewerAvailableVersion(next);
  return {
    ...next,
    updateAvailable,
    status: updateAvailable ? 'update_available' : 'current',
    lastErrorCode: null,
  };
}

function failureStatus(
  status: ProviderClientUpdateStatus,
  statusCode: ProviderClientUpdateStatusCode,
  errorCode: ProviderClientUpdateErrorCode,
  lastCheckedAt = status.lastCheckedAt,
): ProviderClientUpdateStatus {
  return { ...status, status: statusCode, lastCheckedAt, lastErrorCode: errorCode };
}

function classifyUpdateInstallFailure(error: unknown): ProviderClientUpdateErrorCode {
  if (!(error instanceof ProviderClientRuntimeStoreError)) return 'UPDATE_INSTALL_FAILED';
  const validationErrors: readonly RuntimeStoreErrorCode[] = [
    'PACKAGED_RUNTIME_INVALID',
    'INVALID_CANDIDATE',
    'ARCHIVE_INVALID',
    'ARCHIVE_LIMIT_EXCEEDED',
    'ARCHIVE_DIGEST_MISMATCH',
    'CANDIDATE_VERSION_MISMATCH',
    'COMPATIBILITY_PROBE_FAILED',
  ];
  return validationErrors.includes(error.code)
    ? 'UPDATE_VALIDATION_FAILED'
    : 'UPDATE_INSTALL_FAILED';
}

/**
 * Serializes provider-client lifecycle operations. The only install candidate is freshly
 * resolved from the official stable-release contract and pinned to its published SHA-256.
 */
export class ProviderClientUpdateService {
  private readonly statuses = new Map<ProviderClientId, ProviderClientUpdateStatus>();
  private readonly operationTails = new Map<ProviderClientId, Promise<void>>();
  private readonly pendingChecks = new Map<ProviderClientId, Promise<ProviderClientUpdateStatus>>();

  constructor(private readonly options: ProviderClientUpdateServiceOptions) {
    for (const providerId of PROVIDER_CLIENT_IDS) {
      this.statuses.set(providerId, initialStatus(providerId));
    }
  }

  /** Read a synchronized status snapshot and hydrate packaged/active versions from the store. */
  getStatus(providerId: ProviderClientId): Promise<ProviderClientUpdateStatus> {
    assertProviderClientId(providerId);
    return this.serialize(providerId, async () => {
      const current = this.getStoredStatus(providerId);
      try {
        const runtime = await this.options.runtimeStore.getState(providerId);
        return this.saveStatus(providerId, statusFromRuntime(current, runtime));
      } catch {
        return this.saveStatus(
          providerId,
          failureStatus(current, 'error', 'RUNTIME_STATE_UNAVAILABLE'),
        );
      }
    });
  }

  /** Non-blocking read for UI polling while a long operation is serialized. */
  getCachedStatus(providerId: ProviderClientId): ProviderClientUpdateStatus {
    assertProviderClientId(providerId);
    return cloneStatus(this.getStoredStatus(providerId));
  }

  /** Resolve and validate the provider's latest published stable release. */
  check(providerId: ProviderClientId): Promise<ProviderClientUpdateStatus> {
    assertProviderClientId(providerId);
    const pending = this.pendingChecks.get(providerId);
    if (pending) return pending.then(cloneStatus);

    const operation = this.serialize(providerId, () => this.checkSerialized(providerId));
    this.pendingChecks.set(providerId, operation);
    void operation.then(
      () => this.clearPendingCheck(providerId, operation),
      () => this.clearPendingCheck(providerId, operation),
    );
    return operation.then(cloneStatus);
  }

  /** Check immediately before install; callers cannot select a version, URL, or digest. */
  update(providerId: ProviderClientId): Promise<ProviderClientUpdateStatus> {
    assertProviderClientId(providerId);
    return this.serialize(providerId, async () => {
      if (await this.isBusy(providerId)) return this.blockedResult(providerId);

      let current = this.saveStatus(providerId, {
        ...this.getStoredStatus(providerId),
        status: 'checking',
        lastErrorCode: null,
      });
      let runtime: ProviderClientRuntimeState;
      try {
        runtime = await this.options.runtimeStore.getState(providerId);
        current = statusFromRuntime(current, runtime);
        this.saveStatus(providerId, current);
      } catch {
        return this.saveStatus(
          providerId,
          failureStatus(current, 'error', 'RUNTIME_STATE_UNAVAILABLE'),
        );
      }

      const resolved = await this.resolveLatest(providerId, current);
      if (!resolved.release) return resolved.status;

      const candidate: RuntimeClientCandidate = {
        version: resolved.release.version,
        sha256: resolved.release.assets[this.options.architecture].sha256,
      };
      if (
        !current.activeVersion ||
        compareStableVersions(candidate.version, current.activeVersion) <= 0
      ) {
        return this.saveStatus(providerId, resolved.status);
      }

      const operationTimestamp = this.timestamp();
      if (!operationTimestamp) {
        return this.saveStatus(
          providerId,
          failureStatus(resolved.status, 'error', 'CLOCK_UNAVAILABLE'),
        );
      }

      try {
        this.saveStatus(providerId, {
          ...resolved.status,
          status: 'updating',
          lastErrorCode: null,
        });
        const installed = await this.options.runtimeStore.install(providerId, candidate);
        const next = statusFromRuntime(
          {
            ...resolved.status,
            lastUpdatedAt: this.timestamp() ?? operationTimestamp,
            status: installed.status === 'installed' ? 'updated' : resolved.status.status,
            lastErrorCode: null,
          },
          installed.state,
        );
        if (next.updateAvailable) {
          return this.saveStatus(providerId, { ...next, status: 'update_available' });
        }
        return this.saveStatus(providerId, next);
      } catch (error) {
        return this.saveStatus(
          providerId,
          failureStatus(resolved.status, 'error', classifyUpdateInstallFailure(error)),
        );
      }
    });
  }

  /** Roll back to the runtime store's validated previous version, if the provider is idle. */
  rollback(providerId: ProviderClientId): Promise<ProviderClientUpdateStatus> {
    assertProviderClientId(providerId);
    return this.serialize(providerId, async () => {
      if (await this.isBusy(providerId)) return this.blockedResult(providerId);

      const current = this.getStoredStatus(providerId);
      this.saveStatus(providerId, { ...current, status: 'rolling_back', lastErrorCode: null });
      let runtime: ProviderClientRuntimeState;
      try {
        runtime = await this.options.runtimeStore.rollback(providerId);
      } catch {
        return this.saveStatus(providerId, failureStatus(current, 'error', 'ROLLBACK_FAILED'));
      }

      const operationTimestamp = this.timestamp();
      if (!operationTimestamp) {
        return this.saveStatus(
          providerId,
          failureStatus(statusFromRuntime(current, runtime), 'error', 'CLOCK_UNAVAILABLE'),
        );
      }
      const next = statusFromRuntime(
        {
          ...current,
          lastUpdatedAt: operationTimestamp,
          status: 'rolled_back',
          lastErrorCode: null,
        },
        runtime,
      );
      return this.saveStatus(providerId, {
        ...next,
        status: next.updateAvailable ? 'update_available' : 'rolled_back',
      });
    });
  }

  private async checkSerialized(providerId: ProviderClientId): Promise<ProviderClientUpdateStatus> {
    let current = this.getStoredStatus(providerId);
    current = this.saveStatus(providerId, { ...current, status: 'checking' });
    try {
      const runtime = await this.options.runtimeStore.getState(providerId);
      current = statusFromRuntime(current, runtime);
      this.saveStatus(providerId, current);
    } catch {
      return this.saveStatus(
        providerId,
        failureStatus(current, 'error', 'RUNTIME_STATE_UNAVAILABLE'),
      );
    }

    const resolved = await this.resolveLatest(providerId, current);
    return resolved.status;
  }

  private async resolveLatest(
    providerId: ProviderClientId,
    current: ProviderClientUpdateStatus,
  ): Promise<{
    release?: Awaited<ReturnType<typeof discoverLatestStableRelease>>;
    status: ProviderClientUpdateStatus;
  }> {
    try {
      const release = await discoverLatestStableRelease(
        providerId,
        this.options.resolveOfficialRelease,
      );
      const checkedAt = this.timestamp();
      if (!checkedAt) {
        const failed = failureStatus(
          { ...current, availableVersion: null, updateAvailable: false },
          'error',
          'CLOCK_UNAVAILABLE',
        );
        return { status: this.saveStatus(providerId, failed) };
      }
      const status = this.saveStatus(
        providerId,
        releaseStatus({ ...current, lastCheckedAt: checkedAt }, release.version),
      );
      return { release, status };
    } catch {
      const checkedAt = this.timestamp();
      const status = failureStatus(
        { ...current, availableVersion: null, updateAvailable: false },
        'error',
        checkedAt ? 'RELEASE_RESOLUTION_FAILED' : 'CLOCK_UNAVAILABLE',
        checkedAt ?? current.lastCheckedAt,
      );
      return { status: this.saveStatus(providerId, status) };
    }
  }

  private async isBusy(providerId: ProviderClientId): Promise<boolean> {
    try {
      return await this.options.isProviderBusy(providerId);
    } catch {
      // Fail closed: a broken activity gate must never permit executable replacement.
      return true;
    }
  }

  private blockedResult(providerId: ProviderClientId): ProviderClientUpdateStatus {
    return {
      ...this.getStoredStatus(providerId),
      status: 'blocked',
      lastErrorCode: 'UPDATE_BLOCKED_PROVIDER_BUSY',
    };
  }

  private timestamp(): string | null {
    try {
      const value = this.options.clock.now();
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    } catch {
      return null;
    }
  }

  private getStoredStatus(providerId: ProviderClientId): ProviderClientUpdateStatus {
    return this.statuses.get(providerId) ?? initialStatus(providerId);
  }

  private saveStatus(
    providerId: ProviderClientId,
    status: ProviderClientUpdateStatus,
  ): ProviderClientUpdateStatus {
    const safe = cloneStatus(status);
    this.statuses.set(providerId, safe);
    return cloneStatus(safe);
  }

  private serialize<T>(providerId: ProviderClientId, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(providerId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.operationTails.set(providerId, tail);
    void tail.then(() => {
      if (this.operationTails.get(providerId) === tail) this.operationTails.delete(providerId);
    });
    return result;
  }

  private clearPendingCheck(
    providerId: ProviderClientId,
    operation: Promise<ProviderClientUpdateStatus>,
  ): void {
    if (this.pendingChecks.get(providerId) === operation) this.pendingChecks.delete(providerId);
  }
}
