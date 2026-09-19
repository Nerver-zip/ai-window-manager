import { loadConfig } from './config.js';
import type { ProviderAdapter } from './providers/provider.js';
import { FakeProvider } from './providers/fake-provider.js';
import { CodexProvider } from './providers/codex/index.js';
import { recordObservation, recordProviderHealth } from './metrics/metrics.js';
import { SystemClock } from './scheduler/clock.js';
import { resolveLocalOccurrence } from './scheduler/time.js';
import { Reconciler } from './scheduler/reconciler.js';
import { openDatabase } from './storage/database.js';
import { createRepositories, type SchedulePolicyRecord } from './storage/repositories.js';
import { buildServer } from './web/server.js';

const config = loadConfig();
const db = openDatabase(config.AWM_DB_PATH);
const repositories = createRepositories(db);
const clock = new SystemClock();
const adapters = new Map<string, ProviderAdapter>();

registerFakeProvider();
registerCodexProvider();

const reconciler = new Reconciler({
  clock,
  db,
  repositories,
  adapters,
  resolveTargetResetAt,
  onObservation: recordObservation,
  onInspectionFailure: recordProviderHealth,
});

const app = buildServer({ config, db, repositories, adapters, clock });
let reconcileTimer: NodeJS.Timeout | undefined;
let reconcileInFlight: Promise<unknown> | undefined;
let stopping = false;

function startReconcileLoop(): void {
  reconcileTimer = setInterval(() => {
    if (stopping || reconcileInFlight) return;
    const current = reconciler.reconcile();
    reconcileInFlight = current;
    void current
      .catch((error: unknown) => {
        app.log.error({ error }, 'reconcile failed');
      })
      .finally(() => {
        if (reconcileInFlight === current) reconcileInFlight = undefined;
      });
  }, config.AWM_RECONCILE_INTERVAL_SECONDS * 1000);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (reconcileInFlight) await reconcileInFlight;
  await app.close();
  db.close();
}

function registerFakeProvider(): void {
  if (!config.AWM_FAKE_PROVIDER_ENABLED) return;
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
  });
  adapters.set(provider.id, provider);
  seedProvider({
    id: provider.id,
    kind: 'codex',
    config: { codexHome: config.AWM_CODEX_HOME },
  });
}

function seedProvider(input: { id: string; kind: string; config: unknown }): void {
  if (repositories.providers.get(input.id)) return;
  const nowMs = clock.now().getTime();
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
startReconcileLoop();
await app.listen({ host: config.AWM_BIND, port: config.AWM_PORT });
