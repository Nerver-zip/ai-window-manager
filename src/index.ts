import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import {
  createOfficialReleaseSource,
  type ProviderArchitecture,
} from '../scripts/provider-clients-core.js';
import type { ProviderAdapter } from './providers/provider.js';
import { FakeProvider } from './providers/fake-provider.js';
import { CodexProvider } from './providers/codex/index.js';
import { AntigravityProvider } from './providers/antigravity/index.js';
import { filterVisibleProviders } from './providers/visibility.js';
import { AuthSessionManager } from './auth/session-manager.js';
import { OperatorAuthService } from './auth/operator-auth.js';
import { createProviderAuthDrivers } from './auth/provider-drivers.js';
import {
  recordInspection,
  recordObservation,
  recordProviderHealth,
  recordSchedulerDecision,
  recordTrigger,
  refreshObservationMetrics,
  setActionIntentCounts,
} from './metrics/metrics.js';
import { SystemClock } from './scheduler/clock.js';
import { resolveLocalOccurrence } from './scheduler/time.js';
import { Reconciler } from './scheduler/reconciler.js';
import { ActionExecutor } from './scheduler/action-executor.js';
import { ProviderCleanupWorker } from './scheduler/provider-cleanup.js';
import { ProviderInspectionCoordinator } from './providers/inspection-coordinator.js';
import { openDatabase } from './storage/database.js';
import { createRepositories, type SchedulePolicyRecord } from './storage/repositories.js';
import { runRetentionMaintenance } from './storage/retention.js';
import { processUsageAggregationBatch } from './usage/service.js';
import { UsageAggregationWorker } from './usage/worker.js';
import { buildServer } from './web/server.js';
import { seedBootstrapProviderDefaults } from './bootstrap/provider-defaults.js';
import { ProviderClientRuntimeStore } from './provider-clients/runtime-store.js';
import { createOfficialArchiveDownloader } from './provider-clients/archive-downloader.js';
import {
  packagedProviderClients,
  providerArchitectureFromNode,
} from './provider-clients/packaged-clients.js';
import { ProviderClientUpdateService } from './provider-clients/update-service.js';
import { ProviderClientUpdateTasks } from './provider-clients/update-tasks.js';
import { isAutomaticProviderUpdateDue } from './provider-clients/automatic-update.js';
import { PROVIDER_CLIENT_IDS, type ProviderClientId } from './provider-clients/runtime-store.js';
import type { ProviderClientUpdateWebControls } from './provider-clients/web-controls.js';

const config = loadConfig();
const providerRuntimeStore = await initializeProviderRuntime();
const providerExecutables = {
  codex: providerRuntimeStore
    ? await providerRuntimeStore.resolveExecutable('codex')
    : config.AWM_CODEX_EXECUTABLE,
  antigravity: providerRuntimeStore
    ? await providerRuntimeStore.resolveExecutable('antigravity')
    : config.AWM_ANTIGRAVITY_EXECUTABLE,
};
const db = openDatabase(config.AWM_DB_PATH);
const repositories = createRepositories(db);
const clock = new SystemClock();
const adapters = new Map<string, ProviderAdapter>();
const cleanupAdapters = new Map<string, ProviderAdapter>();
let reconcileRequested = false;

registerFakeProvider();
registerCodexProvider();
registerAntigravityProvider();
hydrateMetricsFromState();
const providerInspections = new ProviderInspectionCoordinator();
let requestUsageAggregation = (): void => undefined;

const reconciler = new Reconciler({
  clock,
  db,
  repositories,
  adapters,
  inspections: providerInspections,
  resolveTargetResetAt,
  isProviderRuntimeChanging: (providerId) =>
    (providerId === 'codex' || providerId === 'antigravity') &&
    (providerClientUpdateTasks?.isRuntimeChanging(providerId) ?? false),
  onObservation: (observation) => {
    recordObservation(observation);
    requestUsageAggregation();
  },
  onInspectionFailure: recordProviderHealth,
  onInspection: recordInspection,
  onSchedulerDecision: recordSchedulerDecision,
});
const providerCleanupWorker = new ProviderCleanupWorker({
  clock,
  repositories,
  adapters: cleanupAdapters,
});

const authSessions = new AuthSessionManager({
  clock,
  drivers: createProviderAuthDrivers({
    adapters,
    inspections: providerInspections,
    codexHome: config.AWM_CODEX_HOME,
    codexExecutable: providerExecutables.codex,
    antigravityHome: config.AWM_ANTIGRAVITY_HOME,
    antigravityExecutable: providerExecutables.antigravity,
  }),
  sessionTimeoutMs: config.AWM_AUTH_SESSION_TIMEOUT_SECONDS * 1000,
  onEvent: (event) => {
    const occurredAtMs = clock.now().getTime();
    repositories.events.append({
      occurredAtMs,
      providerId: event.providerId,
      type: event.type,
      severity:
        event.type === 'provider_auth_failed' || event.type === 'provider_auth_timed_out'
          ? 'warn'
          : 'info',
      reasonCode: event.reasonCode,
      data: {},
    });
  },
  requestReconcile: () => {
    reconcileRequested = true;
  },
});
const providerClientUpdateService = providerRuntimeStore
  ? new ProviderClientUpdateService({
      runtimeStore: providerRuntimeStore,
      resolveOfficialRelease: createOfficialReleaseSource(),
      architecture: providerArchitectureFromNode(process.arch),
      clock,
      isProviderBusy: (providerId) => providerIsBusy(providerId),
    })
  : undefined;
const providerClientUpdateTasks = providerClientUpdateService
  ? new ProviderClientUpdateTasks({
      service: providerClientUpdateService,
      clock,
      onRuntimeChanged: () => {
        reconcileRequested = true;
      },
      onAutomaticUpdateFinished: (providerId, successful) => {
        if (!successful) return;
        const nowMs = clock.now().getTime();
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) return;
        repositories.settings.set(providerClientLastSuccessfulCheckKey(providerId), nowMs, nowMs);
      },
    })
  : undefined;
const executor = new ActionExecutor({
  clock,
  db,
  repositories,
  adapters,
  inspections: providerInspections,
  confirmationBaseIntervalMs: config.AWM_RECONCILE_INTERVAL_SECONDS * 1000,
  retryDelayMs: config.AWM_RECONCILE_INTERVAL_SECONDS * 1000,
  isProviderRuntimeChanging: (providerId) => {
    const clientId = PROVIDER_CLIENT_IDS.find((candidate) => candidate === providerId);
    return clientId ? (providerClientUpdateTasks?.isRuntimeChanging(clientId) ?? false) : false;
  },
  onTrigger: recordTrigger,
});
const providerClientUpdateControls: ProviderClientUpdateWebControls | undefined =
  providerClientUpdateService && providerClientUpdateTasks
    ? {
        getStatus: (providerId) => providerClientUpdateService.getCachedStatus(providerId),
        isRuntimeChanging: (providerId) =>
          providerClientUpdateTasks?.isRuntimeChanging(providerId) ?? false,
        autoUpdateEnabled: providerClientAutoUpdateEnabled,
        setAutoUpdateEnabled: setProviderClientAutoUpdateEnabled,
        startCheck: (providerId) => providerClientUpdateTasks.startCheck(providerId),
        startUpdate: (providerId) => providerClientUpdateTasks.startUpdate(providerId),
        startRollback: (providerId) => providerClientUpdateTasks.startRollback(providerId),
      }
    : undefined;
if (providerClientUpdateService) {
  await Promise.all(
    PROVIDER_CLIENT_IDS.map((providerId) => providerClientUpdateService.getStatus(providerId)),
  );
}
const operatorAuth = new OperatorAuthService({
  username: config.AWM_AUTH_USERNAME,
  passwordHash: config.AWM_AUTH_PASSWORD_HASH,
  sessionTtlMs: config.AWM_AUTH_SESSION_TTL_SECONDS * 1000,
  clock,
});
const app = buildServer({
  config,
  db,
  repositories,
  adapters,
  clock,
  authSessions,
  operatorAuth,
  requestReconcile: () => {
    reconcileRequested = true;
  },
  ...(providerClientUpdateControls ? { providerClientUpdates: providerClientUpdateControls } : {}),
});
const usageAggregationWorker = new UsageAggregationWorker({
  processBatch: () => processUsageAggregationBatch(db, repositories, clock.now().getTime()),
  onError: (error) => app.log.error({ error }, 'usage aggregation failed'),
});
requestUsageAggregation = () => usageAggregationWorker.request();
let reconcileTimer: NodeJS.Timeout | undefined;
let executorTimer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
let providerClientUpdateTimer: NodeJS.Timeout | undefined;
let reconcileInFlight: Promise<unknown> | undefined;
let executorInFlight: Promise<unknown> | undefined;
let stopping = false;
function startReconcileLoop(): void {
  reconcileTimer = setInterval(() => {
    if (stopping || reconcileInFlight) return;
    const requested = reconcileRequested;
    reconcileRequested = false;
    if (requested) app.log.debug('reconcile requested by HTTP command');
    const current = reconciler.reconcile();
    reconcileInFlight = current;
    void current
      .catch((error: unknown) => {
        app.log.error({ error }, 'reconcile failed');
      })
      .finally(() => {
        if (reconcileInFlight === current) reconcileInFlight = undefined;
        refreshRuntimeMetrics();
      });
  }, config.AWM_RECONCILE_INTERVAL_SECONDS * 1000);
}

function startExecutorLoop(): void {
  executorTimer = setInterval(() => {
    if (stopping || executorInFlight) return;
    const current = executeActionsAndCleanup();
    executorInFlight = current;
    void current
      .catch((error: unknown) => {
        app.log.error({ error }, 'action executor failed');
      })
      .finally(() => {
        if (executorInFlight === current) executorInFlight = undefined;
        refreshRuntimeMetrics();
      });
  }, config.AWM_EXECUTOR_INTERVAL_SECONDS * 1000);
}

async function executeActionsAndCleanup(): Promise<void> {
  await runProviderCleanup();
  try {
    await executor.executeDue();
  } finally {
    // A Codex trigger registers its thread before turn/start. Cleanup is separate
    // from the action result, so it must not prevent that result being persisted.
    await runProviderCleanup();
  }
}

async function runProviderCleanup(): Promise<void> {
  try {
    const report = await providerCleanupWorker.runDue();
    if (report.retryable > 0) {
      app.log.debug({ retryable: report.retryable }, 'provider artifact cleanup deferred');
    }
  } catch (error) {
    app.log.error({ error }, 'provider artifact cleanup failed');
  }
}

function startRetentionLoop(): void {
  retentionTimer = setInterval(() => {
    if (stopping) return;
    try {
      runRetentionMaintenance(db, { clock });
    } catch (error) {
      app.log.error({ error }, 'retention maintenance failed');
    }
  }, config.AWM_RETENTION_INTERVAL_SECONDS * 1000);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (executorTimer) clearInterval(executorTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  if (providerClientUpdateTimer) clearInterval(providerClientUpdateTimer);
  if (reconcileInFlight) await reconcileInFlight;
  if (executorInFlight) await executorInFlight;
  if (providerClientUpdateTasks) await providerClientUpdateTasks.close();
  await authSessions.shutdown();
  await providerInspections.close();
  await usageAggregationWorker.stop();
  operatorAuth.clearSessions();
  await app.close();
  db.close();
}

function registerFakeProvider(): void {
  if (!config.AWM_FAKE_PROVIDER_ENABLED) {
    const existing = repositories.providers.get('fake');
    if (existing?.enabled) {
      repositories.providers.upsert({
        ...existing,
        enabled: false,
        mode: 'monitor_only',
        updatedAtMs: clock.now().getTime(),
      });
    }
    return;
  }
  const provider = new FakeProvider(clock);
  adapters.set(provider.id, provider);
  seedProvider({
    id: provider.id,
    kind: 'fake',
    config: {},
  });
}

function registerCodexProvider(): void {
  const provider = new CodexProvider({
    codexHome: config.AWM_CODEX_HOME,
    executable: providerExecutables.codex,
    actionTimeoutMs: config.AWM_CODEX_ACTION_TIMEOUT_SECONDS * 1000,
    triggerEnabled: config.AWM_CODEX_TRIGGER_ENABLED,
  });
  // Keep the official deletion surface available to discharge already-persisted
  // cleanup obligations even if Codex monitoring is hidden/disabled at runtime.
  cleanupAdapters.set(provider.id, provider);
  if (!config.AWM_CODEX_ENABLED) return;
  adapters.set(provider.id, provider);
  seedProvider(
    {
      id: provider.id,
      kind: 'codex',
      config: {
        codexHome: config.AWM_CODEX_HOME,
        triggerEnabled: config.AWM_CODEX_TRIGGER_ENABLED,
      },
    },
    config.AWM_CODEX_TRIGGER_ENABLED,
  );
}

function registerAntigravityProvider(): void {
  const provider = new AntigravityProvider({
    executable: providerExecutables.antigravity,
    cwd: config.AWM_ANTIGRAVITY_HOME,
    antigravityHome: config.AWM_ANTIGRAVITY_HOME,
    triggerEnabled: config.AWM_ANTIGRAVITY_TRIGGER_ENABLED,
    actionTimeoutSeconds: config.AWM_ANTIGRAVITY_ACTION_TIMEOUT_SECONDS,
    triggerModels: {
      gemini: config.AWM_ANTIGRAVITY_GEMINI_TRIGGER_MODEL,
      claudeGpt: config.AWM_ANTIGRAVITY_CLAUDE_GPT_TRIGGER_MODEL,
    },
  });
  // Per-ID cleanup obligations remain actionable even while monitoring is hidden.
  cleanupAdapters.set(provider.id, provider);
  if (!config.AWM_ANTIGRAVITY_ENABLED) return;
  adapters.set(provider.id, provider);
  seedProvider(
    {
      id: provider.id,
      kind: 'antigravity',
      config: { home: config.AWM_ANTIGRAVITY_HOME },
    },
    config.AWM_ANTIGRAVITY_TRIGGER_ENABLED,
  );
}

function providerIsBusy(providerId: ProviderClientId): boolean {
  const authentication = authSessions.status(providerId).state;
  const activeAuthentication =
    authentication === 'STARTING' ||
    authentication === 'AWAITING_USER_ACTION' ||
    authentication === 'VERIFYING';
  return (
    activeAuthentication ||
    providerInspections.isInspecting(providerId) ||
    reconciler.isRunning() ||
    repositories.actionIntents.listOpen(providerId).length > 0 ||
    repositories.providerCleanupJobs.hasOpenForProvider(providerId)
  );
}

function providerClientAutoUpdateKey(providerId: ProviderClientId): string {
  return `provider-client-auto-update:${providerId}`;
}

function providerClientAutoUpdateEnabled(providerId: ProviderClientId): boolean {
  return (
    repositories.settings.get<unknown>(providerClientAutoUpdateKey(providerId))?.value === true
  );
}

function setProviderClientAutoUpdateEnabled(providerId: ProviderClientId, enabled: boolean): void {
  repositories.settings.set(
    providerClientAutoUpdateKey(providerId),
    enabled,
    clock.now().getTime(),
  );
}

function providerClientLastAttemptKey(providerId: ProviderClientId): string {
  return `provider-client-auto-update-last-attempt:${providerId}`;
}

function providerClientLastSuccessfulCheckKey(providerId: ProviderClientId): string {
  return `provider-client-auto-update-last-success:${providerId}`;
}

function runAutomaticProviderClientUpdates(): void {
  if (stopping || !providerClientUpdateTasks) return;
  const nowMs = clock.now().getTime();
  if (!Number.isFinite(nowMs)) return;

  for (const providerId of PROVIDER_CLIENT_IDS) {
    if (
      !providerClientAutoUpdateEnabled(providerId) ||
      providerClientUpdateTasks.isRunning(providerId) ||
      providerIsBusy(providerId)
    ) {
      continue;
    }
    const lastAttempt = repositories.settings.get<unknown>(
      providerClientLastAttemptKey(providerId),
    )?.value;
    const lastSuccess = repositories.settings.get<unknown>(
      providerClientLastSuccessfulCheckKey(providerId),
    )?.value;
    if (
      !isAutomaticProviderUpdateDue({
        enabled: true,
        running: providerClientUpdateTasks.isRunning(providerId),
        busy: providerIsBusy(providerId),
        nowMs,
        lastAttemptAtMs: lastAttempt,
        lastSuccessfulCheckAtMs: lastSuccess,
      })
    ) {
      continue;
    }
    if (providerClientUpdateTasks.startAutomaticUpdate(providerId)) {
      repositories.settings.set(providerClientLastAttemptKey(providerId), nowMs, nowMs);
    }
  }
}

function startAutomaticProviderClientUpdates(): void {
  if (!providerClientUpdateTasks) return;
  try {
    runAutomaticProviderClientUpdates();
  } catch (error) {
    app.log.warn({ error }, 'automatic provider app update check failed');
  }
  providerClientUpdateTimer = setInterval(() => {
    try {
      runAutomaticProviderClientUpdates();
    } catch (error) {
      app.log.warn({ error }, 'automatic provider app update check failed');
    }
  }, 60_000);
}

function seedProvider(
  input: { id: string; kind: string; config: unknown },
  triggerEnabled = false,
): void {
  seedBootstrapProviderDefaults({
    repositories,
    provider: input,
    nowMs: clock.now().getTime(),
    pollIntervalSeconds: Math.max(30, config.AWM_RECONCILE_INTERVAL_SECONDS),
    timezone: config.AWM_TIMEZONE,
    triggerEnabled,
  });
}

function hydrateMetricsFromState(): void {
  for (const provider of filterVisibleProviders(
    repositories.providers.list(),
    config.AWM_FAKE_PROVIDER_ENABLED,
  )) {
    const state = repositories.providerState.get(provider.id);
    if (state?.observation) {
      recordObservation(state.observation, {
        nowMs: clock.now().getTime(),
        successfulInspectionAtMs:
          state.lastSuccessAtMs ?? state.observedAtMs ?? clock.now().getTime(),
      });
    } else if (state) {
      recordProviderHealth(provider.id, state.health);
    }
  }
}

function refreshRuntimeMetrics(): void {
  const nowMs = clock.now().getTime();
  refreshObservationMetrics(nowMs);
  for (const provider of filterVisibleProviders(
    repositories.providers.list(),
    config.AWM_FAKE_PROVIDER_ENABLED,
  )) {
    setActionIntentCounts(provider.id, repositories.actionIntents.countsByState(provider.id));
  }
}

function resolveTargetResetAt(policy: SchedulePolicyRecord, now: Date): Date | undefined {
  const config = asRecord(policy.config);
  const absolute = config.targetResetAt;
  if (typeof absolute === 'string') {
    const parsed = new Date(absolute);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const localTime =
    typeof config.targetResetLocalTime === 'string'
      ? config.targetResetLocalTime
      : typeof config.target === 'string'
        ? config.target
        : undefined;
  if (!localTime) return undefined;
  try {
    return resolveLocalOccurrence({
      localTime,
      timeZone: policy.timezone,
      referenceInstant: now,
    }).instant;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function initializeProviderRuntime(): Promise<ProviderClientRuntimeStore | undefined> {
  if (!config.AWM_PROVIDER_CLIENT_RUNTIME_ROOT) return undefined;
  const manifestPath = path.resolve(process.cwd(), 'provider-clients.lock.json');
  const manifestValue: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const architecture: ProviderArchitecture = providerArchitectureFromNode(process.arch);
  const store = new ProviderClientRuntimeStore({
    runtimeRoot: config.AWM_PROVIDER_CLIENT_RUNTIME_ROOT,
    packagedClients: packagedProviderClients(manifestValue, {
      codex: '/opt/codex/bin/codex',
      antigravity: '/opt/antigravity/bin/agy',
    }),
    downloadArchive: createOfficialArchiveDownloader({ architecture }),
    compatibilityProbe: async (request, signal) => {
      if (
        request.purpose !== 'read-only-compatibility-probe' ||
        request.quotaConsumptionAllowed !== false
      ) {
        throw new Error('provider app update probe must be read-only');
      }
      const adapter =
        request.providerId === 'codex'
          ? new CodexProvider({
              codexHome: config.AWM_CODEX_HOME,
              executable: request.executablePath,
              requestTimeoutMs: 20_000,
              triggerEnabled: false,
            })
          : new AntigravityProvider({
              executable: request.executablePath,
              cwd: config.AWM_ANTIGRAVITY_HOME,
              timeoutMs: 45_000,
              triggerEnabled: false,
            });
      const observation = await adapter.inspect({ signal });
      const expectedAuthSummary =
        request.providerId === 'codex' ? 'CODEX_AUTH_REQUIRED' : 'AGY_AUTH_REQUIRED';
      if (
        observation.health === 'UP' ||
        observation.health === 'DEGRADED' ||
        (observation.health === 'AUTH_REQUIRED' && observation.summary === expectedAuthSummary)
      ) {
        return;
      }
      throw new Error('provider app update compatibility probe failed');
    },
  });
  await store.initialize();
  return store;
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

await reconciler.reconcile();
await executeActionsAndCleanup();
refreshRuntimeMetrics();
runRetentionMaintenance(db, { clock });
startReconcileLoop();
startExecutorLoop();
startRetentionLoop();
usageAggregationWorker.start();
await app.listen({ host: config.AWM_BIND, port: config.AWM_PORT });
startAutomaticProviderClientUpdates();
