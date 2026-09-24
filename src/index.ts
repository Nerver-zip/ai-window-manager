import { loadConfig } from './config.js';
import type { ProviderAdapter } from './providers/provider.js';
import { FakeProvider } from './providers/fake-provider.js';
import { CodexProvider } from './providers/codex/index.js';
import { AntigravityProvider } from './providers/antigravity/index.js';
import { filterVisibleProviders } from './providers/visibility.js';
import { AuthSessionManager } from './auth/session-manager.js';
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
import { openDatabase } from './storage/database.js';
import { createRepositories, type SchedulePolicyRecord } from './storage/repositories.js';
import { runRetentionMaintenance } from './storage/retention.js';
import { processUsageAggregationBatch } from './usage/service.js';
import { buildServer } from './web/server.js';

const config = loadConfig();
const db = openDatabase(config.AWM_DB_PATH);
const repositories = createRepositories(db);
const clock = new SystemClock();
const adapters = new Map<string, ProviderAdapter>();

registerFakeProvider();
registerCodexProvider();
registerAntigravityProvider();
hydrateMetricsFromState();

const reconciler = new Reconciler({
  clock,
  db,
  repositories,
  adapters,
  resolveTargetResetAt,
  onObservation: recordObservation,
  onInspectionFailure: recordProviderHealth,
  onInspection: recordInspection,
  onSchedulerDecision: recordSchedulerDecision,
});
const executor = new ActionExecutor({
  clock,
  db,
  repositories,
  adapters,
  onTrigger: recordTrigger,
});

let reconcileRequested = false;
const authSessions = new AuthSessionManager({
  clock,
  drivers: createProviderAuthDrivers({
    adapters,
    codexHome: config.AWM_CODEX_HOME,
    codexExecutable: config.AWM_CODEX_EXECUTABLE,
    antigravityHome: config.AWM_ANTIGRAVITY_HOME,
    antigravityExecutable: config.AWM_ANTIGRAVITY_EXECUTABLE,
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
const app = buildServer({
  config,
  db,
  repositories,
  adapters,
  clock,
  authSessions,
  requestReconcile: () => {
    reconcileRequested = true;
  },
});
let reconcileTimer: NodeJS.Timeout | undefined;
let executorTimer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
const usageAggregationTimer: { current?: NodeJS.Timeout } = {};
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
    const current = executor.executeDue();
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

function processUsageAggregation(): void {
  if (stopping) return;
  try {
    const result = processUsageAggregationBatch(db, repositories, clock.now().getTime());
    if (result.pending)
      app.log.debug({ processed: result.processed }, 'usage aggregation backlog remains');
  } catch (error) {
    app.log.error({ error }, 'usage aggregation failed');
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (executorTimer) clearInterval(executorTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  if (usageAggregationTimer.current) clearInterval(usageAggregationTimer.current);
  if (reconcileInFlight) await reconcileInFlight;
  if (executorInFlight) await executorInFlight;
  await authSessions.shutdown();
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
  if (!config.AWM_CODEX_ENABLED) return;
  const provider = new CodexProvider({
    codexHome: config.AWM_CODEX_HOME,
    executable: config.AWM_CODEX_EXECUTABLE,
    actionTimeoutMs: config.AWM_CODEX_ACTION_TIMEOUT_SECONDS * 1000,
    triggerEnabled: config.AWM_CODEX_TRIGGER_ENABLED,
  });
  adapters.set(provider.id, provider);
  seedProvider({
    id: provider.id,
    kind: 'codex',
    config: {
      codexHome: config.AWM_CODEX_HOME,
      triggerEnabled: config.AWM_CODEX_TRIGGER_ENABLED,
    },
  });
}

function registerAntigravityProvider(): void {
  if (!config.AWM_ANTIGRAVITY_ENABLED) return;
  const provider = new AntigravityProvider({
    executable: config.AWM_ANTIGRAVITY_EXECUTABLE,
    cwd: config.AWM_ANTIGRAVITY_HOME,
  });
  adapters.set(provider.id, provider);
  seedProvider(
    {
      id: provider.id,
      kind: 'antigravity',
      config: { home: config.AWM_ANTIGRAVITY_HOME },
    },
    'monitor_only',
  );
}

function seedProvider(
  input: { id: string; kind: string; config: unknown },
  requiredMode?: 'monitor_only',
): void {
  const nowMs = clock.now().getTime();
  const existing = repositories.providers.get(input.id);
  if (!existing) {
    repositories.providers.upsert({
      id: input.id,
      kind: input.kind,
      enabled: true,
      mode: 'monitor_only',
      pollIntervalSeconds: Math.max(30, config.AWM_RECONCILE_INTERVAL_SECONDS),
      config: input.config,
      configVersion: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  } else if (requiredMode && existing.mode !== requiredMode) {
    repositories.providers.upsert({ ...existing, mode: requiredMode, updatedAtMs: nowMs });
  }
  if (repositories.schedulePolicies.list(input.id).length === 0) {
    const policy: SchedulePolicyRecord = {
      id: `activation-${input.id}`,
      providerId: input.id,
      kind: 'manual',
      enabled: true,
      timezone: config.AWM_TIMEZONE,
      config: {},
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    repositories.schedulePolicies.upsert(policy);
  }
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

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

await reconciler.reconcile();
await executor.executeDue();
refreshRuntimeMetrics();
processUsageAggregation();
runRetentionMaintenance(db, { clock });
startReconcileLoop();
startExecutorLoop();
startRetentionLoop();
usageAggregationTimer.current = setInterval(processUsageAggregation, 1_000);
await app.listen({ host: config.AWM_BIND, port: config.AWM_PORT });
