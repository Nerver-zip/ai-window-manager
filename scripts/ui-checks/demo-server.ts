// Deterministic synthetic demo server for the local UI browser checks (developer tooling).
// Uses the real buildServer with synthetic data, stub adapters whose inspect() rejects, fake
// auth drivers and a static provider-client update stub. It binds to 127.0.0.1 only and never
// contacts providers or the network.
//
// env: PORT (default 4870), AWM_DEMO_TMP (temp dir root, default os.tmpdir()),
//      AWM_DEMO_NO_AUTOSTART (skip auto-starting the Claude Code sign-in session)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { OperatorAuthService } from '../../src/auth/operator-auth.js';
import { hashOperatorPassword } from '../../src/auth/operator-password.js';
import { AuthSessionManager } from '../../src/auth/session-manager.js';
import type {
  AuthManagedProcess,
  AuthOutputStream,
  AuthProviderId,
  ProviderAuthDriver,
} from '../../src/auth/session-manager.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { LOOP_NAMES, LoopMonitor } from '../../src/scheduler/loop-monitor.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';
import type {
  ProviderMode,
  SchedulePolicyKind,
  SchedulePolicyRecord,
  SchedulePolicyScope,
  ActionIntentState,
  EventSeverity,
} from '../../src/storage/repositories.js';
import { buildServer } from '../../src/web/server.js';
import { processUsageAggregationBatch } from '../../src/usage/service.js';
import { CodexProvider } from '../../src/providers/codex/index.js';
import { AntigravityProvider } from '../../src/providers/antigravity/index.js';
import { ClaudeCodeProvider } from '../../src/providers/claude-code/index.js';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import type { ProviderClientId } from '../../src/provider-clients/runtime-store.js';
import type { ProviderClientUpdateWebControls } from '../../src/provider-clients/web-controls.js';
import type { ProviderClientUpdateStatus } from '../../src/provider-clients/update-service.js';
import type {
  Confidence,
  EvidenceSource,
  Fact,
  ProviderHealth,
  WindowPhase,
  WindowSnapshot,
} from '../../src/domain/types.js';

const PORT = Number(process.env.PORT ?? 4870);
const NOW = '2026-11-04T15:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const dir = fs.mkdtempSync(path.join(process.env.AWM_DEMO_TMP ?? os.tmpdir(), 'awm-demo-'));
const dbPath = path.join(dir, 'awm.db');
// Synthetic local-demo credential; the password hash is generated at start-up and never stored.
const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'demo-password';
const passwordHash = await hashOperatorPassword(DEMO_PASSWORD);
const config = loadConfig({
  AWM_AUTH_USERNAME: DEMO_USERNAME,
  AWM_AUTH_PASSWORD_HASH: passwordHash,
  AWM_DB_PATH: dbPath,
  AWM_LOG_LEVEL: 'silent',
  AWM_BIND: '127.0.0.1',
  AWM_PORT: String(PORT),
  AWM_TIMEZONE: 'America/Sao_Paulo',
  AWM_FAKE_PROVIDER_ENABLED: 'false',
  AWM_CODEX_ENABLED: 'true',
  AWM_CODEX_TRIGGER_ENABLED: 'true',
  AWM_ANTIGRAVITY_ENABLED: 'true',
  AWM_ANTIGRAVITY_TRIGGER_ENABLED: 'true',
  AWM_ANTIGRAVITY_ARGON_TRIGGER_ENABLED: 'true',
  AWM_CLAUDE_CODE_ENABLED: 'true',
  AWM_CLAUDE_CODE_TRIGGER_ENABLED: 'true',
});
const db = openDatabase(dbPath);
const repositories = createRepositories(db);
const clock = new FakeClock(NOW);

// ---- stub adapters mirroring real capabilities (real classes only used for capabilities()) ----
const real = [
  new CodexProvider({ codexHome: path.join(dir, 'codex'), triggerEnabled: true }),
  new AntigravityProvider({
    executable: 'agy-not-run',
    triggerEnabled: true,
    argonTriggerEnabled: true,
    triggerModels: {
      gemini: 'gemini-3.8-flash-low',
      claudeGpt: 'claude-sonnet-4-6',
      argon: 'gemini-4-argon-low',
    },
  }),
  new ClaudeCodeProvider({
    configDirectory: path.join(dir, 'cc'),
    executable: 'claude-not-run',
    triggerEnabled: true,
    triggerModel: 'haiku',
  }),
];
const adapters = new Map<string, ProviderAdapter>();
for (const p of real) {
  adapters.set(p.id, {
    id: p.id,
    capabilities: () => p.capabilities(),
    health: () => Promise.resolve<ProviderHealth>('UP'),
    inspect: () => Promise.reject(new Error('demo: renders must not inspect providers')),
  });
}

// ---- seed ----
const fact = <T>(
  value: T,
  source: EvidenceSource,
  confidence: Confidence,
  observedAt: string,
): Fact<T> => ({ value, source, confidence, observedAt });
function win(
  providerId: string,
  windowKind: string,
  used: number,
  startMs: number,
  durationS: number,
  observedMs: number,
  phase: WindowPhase = 'ACTIVE',
): WindowSnapshot {
  const at = iso(observedMs);
  return {
    providerId,
    windowKind,
    observedAt: at,
    phase: fact(phase, 'observed', 'exact', at),
    startedAt: fact(iso(startMs), 'inferred', 'high', at),
    durationSeconds: fact(durationS, 'official_supported', 'high', at),
    resetAt: fact(iso(startMs + durationS * 1000), 'official_supported', 'exact', at),
    usageRatio: fact(used, 'observed', 'exact', at),
    remainingRatio: fact(Math.round((1 - used) * 1000) / 1000, 'observed', 'exact', at),
  };
}
const FIVE = 18_000,
  WEEK = 604_800;

function provider(id: string, kind: string, mode: ProviderMode, cfg: unknown, poll = 300): void {
  repositories.providers.upsert({
    id,
    kind,
    enabled: true,
    mode,
    modeExplicit: true,
    pollIntervalSeconds: poll,
    config: cfg,
    configVersion: 1,
    createdAtMs: NOW_MS - 40 * DAY,
    updatedAtMs: NOW_MS - DAY,
  });
}
function state(
  id: string,
  health: ProviderHealth,
  observedMs: number | null,
  windows: WindowSnapshot[],
  err: string | null = null,
  summary?: string,
): void {
  const obs =
    observedMs === null
      ? null
      : {
          providerId: id,
          health,
          observedAt: iso(observedMs),
          staleAfterSeconds: 900,
          ...(summary ? { summary } : {}),
          windows,
        };
  repositories.providerState.upsert({
    providerId: id,
    health,
    observedAtMs: observedMs,
    staleAfterMs: observedMs === null ? null : 900_000,
    observation: obs,
    lastSuccessAtMs: observedMs,
    lastErrorCode: err,
    updatedAtMs: observedMs ?? NOW_MS,
  });
}

provider('codex', 'codex', 'automation', { codexHome: '/data/codex', triggerEnabled: true });
provider('antigravity', 'antigravity', 'automation', { home: '/data/antigravity' });
provider(
  'claude_code',
  'claude_code',
  'monitor_only',
  { home: '/data/claude-code', triggerEnabled: true },
  120,
);

const codexObs = NOW_MS - 2 * MIN;
const codexFiveStart = NOW_MS - 95 * MIN;
const codexWeekStart = NOW_MS - 3 * DAY - 4 * HOUR;
state('codex', 'UP', codexObs, [
  win('codex', 'five_hour', 0.25, codexFiveStart, FIVE, codexObs),
  win('codex', 'weekly', 0.56, codexWeekStart, WEEK, codexObs),
]);
const agObs = NOW_MS - 4 * MIN;
state('antigravity', 'UP', agObs, [
  win('antigravity', 'antigravity_gemini_five_hour', 0.62, NOW_MS - 3.1 * HOUR, FIVE, agObs),
  win('antigravity', 'antigravity_gemini_weekly', 0.34, NOW_MS - 2 * DAY, WEEK, agObs),
  win('antigravity', 'antigravity_claude_gpt_five_hour', 0.08, NOW_MS - 20 * MIN, FIVE, agObs),
  win('antigravity', 'antigravity_claude_gpt_weekly', 0.71, NOW_MS - 5 * DAY, WEEK, agObs),
  win('antigravity', 'antigravity_argon_weekly', 0.12, NOW_MS - 1 * DAY, WEEK, agObs, 'ACTIVE'),
]);
const ccObs = NOW_MS - 9 * HOUR;
state(
  'claude_code',
  'AUTH_REQUIRED',
  ccObs,
  [
    win('claude_code', 'claude_code_five_hour', 0.9, ccObs - 3 * HOUR, FIVE, ccObs, 'ACTIVE'),
    win('claude_code', 'claude_code_seven_day', 0.47, ccObs - 2 * DAY, WEEK, ccObs),
  ],
  'CLAUDE_CODE_AUTH_REQUIRED',
);

const tz = 'America/Sao_Paulo';
function policy(
  id: string,
  providerId: string,
  scope: SchedulePolicyScope,
  kind: SchedulePolicyKind,
  cfg: unknown,
  extra: Partial<SchedulePolicyRecord> = {},
): void {
  repositories.schedulePolicies.upsert({
    id,
    providerId,
    scope,
    kind,
    kindExplicit: true,
    enabled: true,
    timezone: tz,
    config: cfg,
    createdAtMs: NOW_MS - 30 * DAY,
    updatedAtMs: NOW_MS - 2 * DAY,
    ...extra,
  });
}
policy('activation-codex', 'codex', 'default', 'auto', { windowKind: 'five_hour' });
policy('activation-antigravity-gemini', 'antigravity', 'gemini', 'custom_schedule', {
  windowKind: 'antigravity_gemini_five_hour',
  times: ['06:00', '11:00', '16:00', '21:00'],
  toleranceSeconds: 60,
});
policy('activation-antigravity-claude-gpt', 'antigravity', 'claude_gpt', 'active_hours', {
  windowKind: 'antigravity_claude_gpt_five_hour',
  periods: [
    { start: '09:00', end: '18:00' },
    { start: '20:00', end: '23:00' },
  ],
});
policy(
  'activation-antigravity-argon',
  'antigravity',
  'argon',
  'manual',
  { windowKind: 'antigravity_argon_weekly' },
  { requiresReview: true, kindExplicit: false },
);
policy('activation-claude_code', 'claude_code', 'default', 'fixed', {
  windowKind: 'claude_code_five_hour',
  anchorLocalTime: '07:30',
  toleranceSeconds: 120,
});

// uncertain intent for codex
repositories.actionIntents.createIfAbsent({
  id: 'demo-uncertain-1',
  providerId: 'codex',
  policyId: 'activation-codex',
  actionType: 'trigger_window',
  dedupeKey: 'demo-codex-five_hour-cycle-1',
  state: 'uncertain' satisfies ActionIntentState,
  scheduledForMs: NOW_MS - 95 * MIN,
  notBeforeMs: null,
  expiresAtMs: NOW_MS + 3 * HOUR,
  attemptCount: 1,
  confirmationAttemptCount: 2,
  confirmationNotBeforeMs: null,
  reasonCode: 'ACTION_DISPATCH_UNCERTAIN',
  explanation: { windowKind: 'five_hour', observedCycleAt: iso(NOW_MS - 6 * HOUR) },
  lastErrorCode: 'EOF',
  createdAtMs: NOW_MS - 96 * MIN,
  startedAtMs: NOW_MS - 95 * MIN,
  finishedAtMs: null,
  updatedAtMs: NOW_MS - 90 * MIN,
});

// events (~42)
const evs: Array<[number, string | null, string, EventSeverity, string | null]> = [
  [5, 'codex', 'provider_inspected', 'info', null],
  [12, 'antigravity', 'provider_inspected', 'info', null],
  [20, 'codex', 'action_uncertain', 'warn', 'ACTION_DISPATCH_UNCERTAIN'],
  [24, 'codex', 'action_dispatch_started', 'info', null],
  [26, 'codex', 'action_intent_claimed', 'info', null],
  [27, 'codex', 'action_intent_planned', 'info', null],
  [55, 'claude_code', 'provider_inspection_failed', 'error', 'CLAUDE_CODE_AUTH_REQUIRED'],
  [60, 'claude_code', 'provider_auth_required', 'warn', 'CLAUDE_CODE_AUTH_REQUIRED'],
  [80, 'antigravity', 'action_confirmed', 'info', null],
  [82, 'antigravity', 'action_succeeded', 'info', null],
  [84, 'antigravity', 'action_claimed', 'info', null],
  [95, 'antigravity', 'action_intent_planned', 'info', null],
  [140, 'codex', 'unexpected_reset_detected', 'info', null],
  [190, 'codex', 'external_window_started', 'info', null],
  [260, 'antigravity', 'schedule_missed', 'warn', null],
  [300, 'codex', 'action_failed_retryable', 'warn', null],
  [330, 'codex', 'action_skipped', 'info', null],
  [420, 'antigravity', 'provider_inspection_failed', 'error', 'AGY_PROVIDER_TIMEOUT'],
  [425, 'antigravity', 'provider_inspected', 'info', null],
  [600, null, 'timezone_updated', 'info', null],
  [660, 'codex', 'schedule_policy_updated', 'info', null],
  [900, 'antigravity', 'schedule_policy_updated', 'info', null],
  [1100, 'antigravity', 'provider_auth_succeeded', 'info', null],
  [1110, 'antigravity', 'provider_auth_started', 'info', null],
  [1500, 'codex', 'manual_trigger_requested', 'info', null],
  [1510, 'codex', 'action_succeeded', 'info', null],
  [1515, 'codex', 'action_confirmed', 'info', null],
  [2000, 'claude_code', 'provider_auth_failed', 'warn', 'CLAUDE_CODE_AUTH_REQUIRED'],
  [2100, 'claude_code', 'provider_auth_timed_out', 'warn', null],
  [2500, 'codex', 'action_failed_terminal', 'error', null],
  [3000, 'codex', 'manual_trigger_rejected', 'warn', null],
  [3500, 'antigravity', 'schedule_policy_invalid', 'warn', null],
  [4000, 'codex', 'provider_settings_updated', 'info', null],
  [5000, 'codex', 'action_recovery_started', 'info', null],
  [5002, 'codex', 'action_recovery_confirmed', 'info', null],
  [6000, 'antigravity', 'inspect_requested', 'info', null],
  [8000, 'codex', 'provider_inspected', 'info', null],
  [10000, 'antigravity', 'unexpected_reset_detected', 'info', null],
  [14000, 'claude_code', 'provider_inspected', 'info', null],
  [20000, 'codex', 'action_succeeded', 'info', null],
  [30000, 'codex', 'scheduler_noop', 'debug', null],
];
for (const [minsAgo, providerId, type, severity, reasonCode] of evs) {
  repositories.events.append({
    occurredAtMs: NOW_MS - minsAgo * MIN,
    providerId,
    type,
    severity,
    reasonCode,
    data: {},
  });
}

// 30 days of window samples every 10 minutes
function usageAt(
  kind: string,
  t: number,
): { ratio: number; start: number; dur: number; phase: WindowPhase } {
  const dur = kind.includes('weekly') || kind.includes('seven_day') ? WEEK : FIVE;
  const anchor = Date.parse('2026-10-01T00:00:00Z') + (kind.length % 5) * HOUR;
  const idx = Math.floor((t - anchor) / (dur * 1000));
  const start = anchor + idx * dur * 1000;
  const frac = (t - start) / (dur * 1000);
  const dayLevel = 0.35 + 0.65 * Math.abs(Math.sin(Math.floor(t / DAY) * 1.7 + kind.length));
  const localHour = (new Date(t).getUTCHours() + 21) % 24;
  const weekend = [0, 6].includes(new Date(t - 3 * HOUR).getUTCDay());
  if (dur === FIVE) {
    const idle = localHour < 8 || localHour >= 23 || (weekend && idx % 3 !== 0);
    if (idle) return { ratio: 0, start, dur, phase: 'INACTIVE' };
    return { ratio: Math.min(0.97, frac * dayLevel * 1.15), start, dur, phase: 'ACTIVE' };
  }
  return {
    ratio: Math.min(0.98, frac * (0.6 + 0.4 * dayLevel) * 1.1),
    start,
    dur,
    phase: 'ACTIVE',
  };
}
const kinds: Array<[string, string]> = [
  ['codex', 'five_hour'],
  ['codex', 'weekly'],
  ['antigravity', 'antigravity_gemini_five_hour'],
  ['antigravity', 'antigravity_gemini_weekly'],
  ['antigravity', 'antigravity_claude_gpt_five_hour'],
  ['antigravity', 'antigravity_claude_gpt_weekly'],
  ['antigravity', 'antigravity_argon_weekly'],
];
for (let t = NOW_MS - 30 * DAY; t <= NOW_MS - 6 * MIN; t += 10 * MIN) {
  for (const [p, k] of kinds) {
    const u = usageAt(k, t);
    repositories.windowSamples.insert(
      win(p, k, Math.round(u.ratio * 1000) / 1000, u.start, u.dur, t, u.phase),
    );
  }
}
for (;;) {
  const r = processUsageAggregationBatch(db, repositories, NOW_MS);
  if (!r.pending) break;
}

const operatorAuth = new OperatorAuthService({
  username: DEMO_USERNAME,
  passwordHash,
  sessionTtlMs: config.AWM_AUTH_SESSION_TTL_SECONDS * 1000,
  clock,
});

type OutputListener = (stream: AuthOutputStream, chunk: string | Buffer) => void;
interface DemoProcess extends AuthManagedProcess {
  emit(line: string): void;
}
function makeProcess(): DemoProcess {
  const listeners = new Set<OutputListener>();
  return {
    onOutput: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit: () => () => undefined,
    writeInput: () => undefined,
    signal: () => undefined,
    waitForExit: () => Promise.resolve(true),
    emit: (line) => {
      for (const listener of listeners) listener('stdout', `${line}\n`);
    },
  };
}
function makeDriver(providerId: AuthProviderId, connected: boolean): ProviderAuthDriver {
  let submitted = '';
  return {
    providerId,
    isAlreadyAuthenticated: () => Promise.resolve(connected),
    launch: () => {
      const proc = makeProcess();
      setTimeout(() => proc.emit('auth-prompt'), 300);
      return proc;
    },
    parseOutput: (_stream, line) =>
      line === 'auth-prompt'
        ? {
            awaitingUserAction: true,
            authorizationUrl: 'https://claude.com/oauth/authorize?state=synthetic-demo',
            userCode: 'ABCD-1234',
            requiresCodeSubmission: true,
          }
        : undefined,
    submitCode: (_proc, code) => {
      submitted = code;
    },
    verify: () => Promise.resolve(connected || submitted === 'SYNTH-CODE-42'),
  };
}
const authSessions = new AuthSessionManager({
  clock,
  drivers: new Map<AuthProviderId, ProviderAuthDriver>([
    ['codex', makeDriver('codex', true)],
    ['antigravity', makeDriver('antigravity', true)],
    ['claude_code', makeDriver('claude_code', false)],
  ]),
  sessionTimeoutMs: 24 * HOUR,
});
function updStatus(
  providerId: ProviderClientId,
  packagedVersion: string,
  activeVersion: string,
  availableVersion: string,
  previousVersion: string | null,
  updateAvailable: boolean,
): ProviderClientUpdateStatus {
  return {
    providerId,
    packagedVersion,
    activeVersion,
    previousVersion,
    availableVersion,
    updateAvailable,
    status: updateAvailable ? 'update_available' : 'current',
    lastCheckedAt: iso(NOW_MS - 2 * HOUR),
    lastUpdatedAt: previousVersion ? iso(NOW_MS - 9 * DAY) : null,
    lastErrorCode: null,
  };
}
const statuses: Record<ProviderClientId, ProviderClientUpdateStatus> = {
  codex: updStatus('codex', '0.48.0', '0.50.0', '0.51.0', '0.49.0', true),
  antigravity: updStatus('antigravity', '1.2.0', '1.2.0', '1.2.0', null, false),
  claude_code: updStatus('claude_code', '2.1.0', '2.1.0', '2.2.0', null, true),
};
const autoUpdate: Partial<Record<ProviderClientId, boolean>> = { codex: true };
const providerClientUpdates: ProviderClientUpdateWebControls = {
  getStatus: (id) => statuses[id],
  isRuntimeChanging: () => false,
  autoUpdateEnabled: (id) => autoUpdate[id] ?? false,
  setAutoUpdateEnabled: () => undefined,
  startCheck: () => false,
  startUpdate: () => false,
  startRollback: () => false,
};
const loopMonitor = new LoopMonitor(clock);
for (const l of LOOP_NAMES) {
  loopMonitor.register(l, { intervalMs: 30_000, maxRunMs: 60_000 });
  loopMonitor.begin(l);
  loopMonitor.finish(l, true);
}
const app = buildServer({
  config,
  db,
  repositories,
  adapters,
  clock,
  operatorAuth,
  authSessions,
  providerClientUpdates,
  loopMonitor,
  requestReconcile: () => undefined,
});
await app.listen({ host: '127.0.0.1', port: PORT });
console.warn(
  'WARNING: local synthetic demo only. Fixed demo credentials, fake data, bound to 127.0.0.1; do not expose or reuse.',
);
if (!process.env.AWM_DEMO_NO_AUTOSTART) authSessions.start('claude_code');
console.log(
  `demo server ready on http://127.0.0.1:${PORT} (user ${DEMO_USERNAME} / ${DEMO_PASSWORD}), db ${dbPath}`,
);
const stop = async (): Promise<void> => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
