import Fastify from 'fastify';
import { renderAppShell } from './ui/layout.js';
import { APP_CSS } from './ui/styles.js';
import type { AppConfig } from '../config.js';
import type { ProviderCapabilities, ProviderObservation, WindowSnapshot } from '../domain/types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from '../scheduler/clock.js';
import type { SqliteDatabase } from '../storage/database.js';
import type {
  ActionIntentRecord,
  EventRecord,
  ProviderRecord,
  ProviderStateRecord,
  StorageRepositories,
} from '../storage/repositories.js';
import { registry } from '../metrics/metrics.js';
import { createCommandApi } from './api-commands.js';
import { createReadApi } from './api-read.js';
import { updateProviderSettings, updateScheduleSettings } from './settings-api.js';
import {
  renderSchedulePage as renderScheduleUiPage,
  renderSettingsPage as renderSettingsUiPage,
  type SchedulePolicyView,
  type SettingsProviderView,
} from './settings-ui.js';
import {
  MAX_HISTORY_EVENTS,
  MAX_USAGE_POINTS,
  renderHistoryPage,
  type HistoryTimelineEvent,
  type HistoryUsageSample,
} from './history-ui.js';
import {
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  ensureCsrfToken,
  getSecurityHeaders,
  validateCsrf,
  validateMutationOrigin,
} from './security.js';

const DECISION_EVENT_TYPES = new Set([
  'action_intent_planned',
  'scheduler_noop',
  'schedule_missed',
]);

const EXPLANATION_KEYS = new Set([
  'decision',
  'reasonCode',
  'providerId',
  'policyId',
  'windowKind',
  'targetResetAt',
  'targetTriggerAt',
  'windowDurationSeconds',
  'durationConfidence',
  'phase',
  'phaseConfidence',
  'observationAgeSeconds',
  'toleranceSeconds',
  'desiredResetLocal',
  'timezone',
  'dstAdjustment',
]);

export interface BuildServerInput {
  config: AppConfig;
  db: SqliteDatabase;
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  clock: Clock;
  requestReconcile?: () => void;
}

type ProviderHealthRead = ProviderStateRecord['health'] | 'UNKNOWN';

interface FreshnessRead {
  observedAt: string | null;
  ageSeconds: number | null;
  staleAfterSeconds: number | null;
  stale: boolean;
}

interface DecisionRead {
  decision: 'create_intent' | 'noop';
  reasonCode: string | null;
  explanation: Record<string, unknown>;
  eventType: string;
  occurredAt: string;
  actionIntent?: {
    id: string;
    state: ActionIntentRecord['state'];
    scheduledFor: string;
    dedupeKey: string;
  };
}

interface ProviderRead {
  id: string;
  kind: string;
  enabled: boolean;
  mode: ProviderRecord['mode'];
  health: ProviderHealthRead;
  lastErrorCode: string | null;
  observation: ProviderObservation | null;
  windows: WindowSnapshot[];
  freshness: FreshnessRead;
  capabilities?: ProviderCapabilities;
  nextDecision: DecisionRead | null;
}

export function buildServer(input: BuildServerInput) {
  const app = Fastify({
    logger: { level: input.config.AWM_LOG_LEVEL },
    bodyLimit: DEFAULT_HTTP_BODY_LIMIT_BYTES,
  });

  const readApi = createReadApi({
    repositories: input.repositories,
    clock: input.clock,
    adapters: input.adapters,
  });
  app.get('/assets/app.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(APP_CSS),
  );
  const commandApi = createCommandApi({
    repositories: input.repositories,
    adapters: input.adapters,
    clock: input.clock,
    requestReconcile: input.requestReconcile,
  });
  const settingsInput = {
    repositories: input.repositories,
    adapters: input.adapters,
    clock: input.clock,
  };

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, parseFormBody(String(body)));
      } catch {
        done(new Error('invalid form body'));
      }
    },
  );

  app.addHook('onSend', async (request, reply, payload) => {
    const headers = getSecurityHeaders({
      noStore: request.url.startsWith('/api/') || request.url === '/metrics',
    });
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    return payload;
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = validateMutationOrigin(request.method, request.headers.origin, {
      expectedOrigin: expectedOrigin(request, input.config.AWM_PORT),
    });
    if (!origin.ok) {
      return reply.code(403).send({
        accepted: false,
        error: { code: 'ORIGIN_REJECTED', message: 'mutation origin is not allowed' },
      });
    }
    const csrf = validateCsrf({
      cookieHeader: request.headers.cookie,
      headerToken: request.headers['x-csrf-token'],
      formToken: bodyCsrfToken(request.body),
    });
    if (!csrf.ok) {
      return reply.code(403).send({
        accepted: false,
        error: { code: 'CSRF_REJECTED', message: 'csrf validation failed' },
      });
    }
  });

  app.get('/healthz', async (_request, reply) => {
    try {
      input.db.prepare('SELECT 1').get();
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'error' });
    }
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.get('/api/v1/providers', () => readApi.getProviders().body);

  app.get('/api/v1/providers/:id', async (request, reply) => {
    const result = readApi.getProvider((request.params as { id?: unknown }).id);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get('/api/v1/history', async (request, reply) => {
    const result = readApi.getHistory(request.query);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get('/api/v1/settings', () => readApi.getSettings().body);

  app.get('/history', async (request, reply) => {
    const query = asRecord(request.query);
    const providerId = stringValue(query.provider) ?? undefined;
    const providers = input.repositories.providers.list();
    const selectedProviders = providerId
      ? providers.filter((provider) => provider.id === providerId)
      : providers;
    const events = input.repositories.events.list(providerId, { limit: MAX_HISTORY_EVENTS });
    const samples = selectedProviders.flatMap((provider) =>
      input.repositories.windowSamples.list(provider.id, { limit: MAX_USAGE_POINTS * 8 }),
    );

    reply.type('text/html; charset=utf-8');
    return renderHistoryPage({
      now: input.clock.now(),
      filter: { range: query.range, ...(providerId ? { providerId } : {}) },
      providers: providers.map((provider) => ({ id: provider.id, label: provider.id })),
      events: events.map(historyTimelineEvent),
      samples: samples.map(historyUsageSample),
    });
  });

  app.get('/settings', async (request, reply) => {
    const csrf = ensureCsrfToken(request.headers.cookie, {
      secure: request.protocol === 'https',
    });
    if (csrf.setCookie) reply.header('Set-Cookie', csrf.setCookie);
    reply.type('text/html; charset=utf-8');
    const notice = queryMessage(request.query);
    return renderSettingsUiPage({
      csrfToken: csrf.token,
      providers: settingsProviderViews(input),
      ...(notice ? { notice } : {}),
    });
  });

  app.get('/schedule', async (request, reply) => {
    const csrf = ensureCsrfToken(request.headers.cookie, {
      secure: request.protocol === 'https',
    });
    if (csrf.setCookie) reply.header('Set-Cookie', csrf.setCookie);
    reply.type('text/html; charset=utf-8');
    const notice = queryMessage(request.query);
    const policy = schedulePolicyView(input);
    return renderScheduleUiPage({
      csrfToken: csrf.token,
      providers: settingsProviderViews(input),
      referenceInstant: input.clock.now(),
      ...(policy ? { policy } : {}),
      ...(notice ? { notice } : {}),
    });
  });

  app.post('/settings/providers/:id', async (request, reply) => {
    const result = updateProviderSettings(
      settingsInput,
      (request.params as { id?: unknown }).id,
      normalizeProviderSettingsBody(request.body),
    );
    if (!result.ok) {
      return reply.code(result.statusCode).type('text/plain; charset=utf-8').send(result.message);
    }
    input.requestReconcile?.();
    return reply.code(303).redirect('/settings?updated=provider');
  });

  app.post('/schedule', async (request, reply) => {
    const result = updateScheduleSettings(
      settingsInput,
      normalizeScheduleSettingsBody(request.body),
    );
    if (!result.ok) {
      return reply.code(result.statusCode).type('text/plain; charset=utf-8').send(result.message);
    }
    input.requestReconcile?.();
    return reply.code(303).redirect('/schedule?updated=schedule');
  });

  app.post('/api/v1/providers/:id/inspect', async (request, reply) => {
    const result = commandApi.inspect((request.params as { id?: unknown }).id);
    return reply.code(result.statusCode).send(result.body);
  });

  app.post('/api/v1/providers/:id/trigger', async (request, reply) => {
    const result = commandApi.trigger((request.params as { id?: unknown }).id, request.body);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get('/', async (_request, reply) => {
    const providers = readProviders(input);
    reply.type('text/html; charset=utf-8');
    const csrf = ensureCsrfToken(_request.headers.cookie, {
      secure: _request.protocol === 'https',
    });
    if (csrf.setCookie) reply.header('Set-Cookie', csrf.setCookie);
    return renderOverview(providers, input.clock.now());
  });

  return app;
}

function expectedOrigin(
  request: {
    protocol: string;
    headers: Record<string, string | string[] | undefined>;
  },
  fallbackPort: number,
): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const protocol = forwardedProto === 'https' || request.protocol === 'https' ? 'https' : 'http';
  const host =
    typeof request.headers.host === 'string' ? request.headers.host : `127.0.0.1:${fallbackPort}`;
  return `${protocol}://${host}`;
}

function bodyCsrfToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const token = (body as Record<string, unknown>).csrfToken;
  return typeof token === 'string' ? token : undefined;
}

function parseFormBody(body: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) values[key] = value;
  return values;
}

function normalizeProviderSettingsBody(body: unknown): unknown {
  const record = asRecord(body);
  return {
    enabled: formBoolean(record.enabled),
    mode: record.mode,
    pollIntervalSeconds: Number(record.pollIntervalSeconds),
  };
}

function normalizeScheduleSettingsBody(body: unknown): unknown {
  const record = asRecord(body);
  return {
    enabled: formBoolean(record.enabled),
    providerId: record.providerId,
    windowKind: record.windowKind,
    targetResetLocalTime: record.targetResetLocalTime,
    timezone: record.timezone,
    toleranceSeconds: Number(record.toleranceSeconds),
  };
}

function formBoolean(value: unknown): boolean {
  return value === true || value === 'on' || value === 'true' || value === '1';
}

function queryMessage(query: unknown): string | null {
  const value = asRecord(query).updated;
  return value === 'provider'
    ? 'Provider settings saved.'
    : value === 'schedule'
      ? 'Schedule saved.'
      : null;
}

function settingsProviderViews(input: BuildServerInput): SettingsProviderView[] {
  return input.repositories.providers.list().map((provider) => {
    const adapter = input.adapters.get(provider.id);
    const capabilities = adapter ? safeCapabilities(adapter) : undefined;
    return {
      id: provider.id,
      kind: provider.kind,
      enabled: provider.enabled,
      mode: provider.mode,
      pollIntervalSeconds: provider.pollIntervalSeconds,
      ...(capabilities ? { capabilities } : {}),
      windows: input.repositories.providerState.get(provider.id)?.observation?.windows ?? [],
    };
  });
}

function schedulePolicyView(input: BuildServerInput): SchedulePolicyView | undefined {
  const policy = input.repositories.schedulePolicies
    .list()
    .find((candidate) => candidate.kind === 'target_reset');
  if (!policy) return undefined;
  const config = asRecord(policy.config);
  const windowKind = stringValue(config.windowKind);
  const targetResetLocalTime = stringValue(config.targetResetLocalTime);
  const toleranceSeconds = numberValue(config.toleranceSeconds);
  if (!windowKind || !targetResetLocalTime || toleranceSeconds === null) return undefined;
  return {
    enabled: policy.enabled,
    providerId: policy.providerId,
    windowKind,
    targetResetLocalTime,
    timezone: policy.timezone,
    toleranceSeconds,
  };
}

function readProviders(input: BuildServerInput): ProviderRead[] {
  const nowMs = input.clock.now().getTime();
  return input.repositories.providers.list().map((provider) => {
    const state = input.repositories.providerState.get(provider.id);
    const observation = state?.observation ?? null;
    const decision = readDecision(input, provider.id);
    const adapter = input.adapters.get(provider.id);
    const capabilities = adapter ? safeCapabilities(adapter) : undefined;

    return {
      id: provider.id,
      kind: provider.kind,
      enabled: provider.enabled,
      mode: provider.mode,
      health: state?.health ?? 'UNKNOWN',
      lastErrorCode: state?.lastErrorCode ?? null,
      observation,
      windows: observation?.windows ?? [],
      freshness: freshness(state, nowMs),
      ...(capabilities ? { capabilities } : {}),
      nextDecision: decision,
    };
  });
}

function safeCapabilities(adapter: ProviderAdapter): ProviderCapabilities | undefined {
  try {
    return adapter.capabilities();
  } catch {
    return undefined;
  }
}

function freshness(state: ProviderStateRecord | undefined, nowMs: number): FreshnessRead {
  if (!state?.observation || state.observedAtMs === null || state.staleAfterMs === null) {
    return {
      observedAt: null,
      ageSeconds: null,
      staleAfterSeconds: null,
      stale: true,
    };
  }

  const ageSeconds = Math.max(0, Math.floor((nowMs - state.observedAtMs) / 1000));
  return {
    observedAt: new Date(state.observedAtMs).toISOString(),
    ageSeconds,
    staleAfterSeconds: Math.floor(state.staleAfterMs / 1000),
    stale: nowMs - state.observedAtMs > state.staleAfterMs,
  };
}

function readDecision(input: BuildServerInput, providerId: string): DecisionRead | null {
  const events = input.repositories.events.list(providerId, { limit: 100 });
  const event = events.find((candidate) => DECISION_EVENT_TYPES.has(candidate.type));
  const openIntents = input.repositories.actionIntents.listOpen(providerId);
  const intent = openIntents.find((candidate) => candidate.state === 'uncertain') ?? openIntents[0];

  if (event) {
    const explanation = extractExplanation(event.data);
    const decision = event.type === 'action_intent_planned' ? 'create_intent' : 'noop';
    const result: DecisionRead = {
      decision,
      reasonCode: event.reasonCode ?? stringValue(explanation.reasonCode),
      explanation,
      eventType: event.type,
      occurredAt: new Date(event.occurredAtMs).toISOString(),
    };
    if (intent) result.actionIntent = actionIntentRead(intent);
    return result;
  }

  if (intent) {
    const explanation = extractExplanation(intent.explanation);
    return {
      decision: 'create_intent',
      reasonCode: intent.reasonCode,
      explanation,
      eventType: 'action_intent',
      occurredAt: new Date(intent.createdAtMs).toISOString(),
      actionIntent: actionIntentRead(intent),
    };
  }

  return null;
}

function actionIntentRead(intent: ActionIntentRecord): NonNullable<DecisionRead['actionIntent']> {
  return {
    id: intent.id,
    state: intent.state,
    scheduledFor: new Date(intent.scheduledForMs).toISOString(),
    dedupeKey: intent.dedupeKey,
  };
}

function extractExplanation(value: unknown): Record<string, unknown> {
  const candidate = asRecord(value);
  const nested = asRecord(candidate.explanation);
  const source = Object.keys(nested).length > 0 ? nested : candidate;
  const explanation: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (EXPLANATION_KEYS.has(key) && isSafeExplanationValue(item)) {
      explanation[key] = item;
    }
  }
  return explanation;
}

function isSafeExplanationValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function renderOverview(providers: ProviderRead[], now: Date): string {
  const cards = providers.map((provider) => renderProviderCard(provider, now)).join('');
  return renderAppShell({
    page: 'overview',
    title: 'Overview',
    description: 'Your usage windows, at a glance. Quota, timing and the decisions behind them.',
    content: `<section class="summary-grid" aria-label="Workspace summary"><div class="summary-stat"><strong>${providers.length}</strong><span>Configured providers</span></div><div class="summary-stat"><strong>${providers.filter((p) => p.health === 'UP').length}</strong><span>Healthy providers</span></div><div class="summary-stat"><strong>${providers.filter((p) => p.mode === 'automation').length}</strong><span>Automation enabled</span></div></section>${cards || '<section class="empty-state"><h2>No providers configured</h2><p>Enable a provider in the application configuration to begin observing usage windows.</p></section>'}`,
  });
}

function historyTimelineEvent(event: EventRecord): HistoryTimelineEvent {
  return {
    id: event.id ?? 0,
    occurredAt: new Date(event.occurredAtMs).toISOString(),
    providerId: event.providerId,
    type: event.type,
    severity: event.severity,
    reasonCode: event.reasonCode,
  };
}

function historyUsageSample(snapshot: WindowSnapshot): HistoryUsageSample {
  return {
    providerId: snapshot.providerId,
    windowKind: snapshot.windowKind,
    observedAt: snapshot.observedAt,
    usageRatio: snapshot.usageRatio?.value ?? null,
    remainingRatio: snapshot.remainingRatio?.value ?? null,
  };
}

function renderProviderCard(provider: ProviderRead, now: Date): string {
  const staleClass = provider.freshness.stale ? ' stale' : '';
  const staleLabel = provider.freshness.stale
    ? provider.freshness.observedAt
      ? 'STALE'
      : 'STALE · never observed'
    : 'FRESH';
  const freshnessLabel =
    provider.freshness.ageSeconds === null
      ? staleLabel
      : `${provider.freshness.ageSeconds}s ago · ${staleLabel}`;
  const windows =
    provider.windows.length > 0
      ? `<div class="window-grid">${provider.windows.map((window) => renderWindow(window, now)).join('')}</div>`
      : '<div class="empty-state"><h3>No observation yet</h3><p>Window: unknown</p></div>';
  const decision = provider.nextDecision
    ? `<section class="decision-panel"><p class="eyebrow">NEXT DECISION</p><h3>${provider.nextDecision.decision === 'create_intent' ? 'Action planned' : 'No automatic action'}</h3><p>${escapeHtml(decisionDescription(provider.nextDecision.reasonCode))}</p><details><summary>Technical details</summary><code>${escapeHtml(provider.nextDecision.reasonCode ?? 'unknown')}</code><pre>${escapeHtml(JSON.stringify(provider.nextDecision.explanation, null, 2))}</pre></details></section>`
    : '<section class="decision-panel"><p class="eyebrow">NEXT DECISION</p><h3>No scheduling decision yet</h3><p>A decision will appear after an enabled schedule is evaluated. <a href="/schedule">Review schedule</a></p></section>';

  return `<article class="provider${staleClass}"><header class="provider-header"><div><h2>${escapeHtml(provider.id)}</h2><p class="provider-meta">${escapeHtml(provider.kind)} · ${provider.enabled ? 'enabled' : 'disabled'}</p></div><div class="badges"><span class="badge ${provider.health === 'UP' ? 'badge-success' : 'badge-warning'}">${escapeHtml(provider.health)}</span><span class="badge">${escapeHtml(provider.mode.replaceAll('_', ' '))}</span></div></header><p class="provider-meta">Last updated ${escapeHtml(freshnessLabel)}</p>${provider.freshness.stale ? '<p class="stale-notice">Data may no longer reflect current usage.</p>' : ''}${provider.health === 'AUTH_REQUIRED' ? '<p class="notice">Authentication required. Sign in through the official provider client.</p>' : ''}<details><summary>Provider details</summary><dl><dt>Health</dt><dd>${escapeHtml(provider.health)}</dd><dt>Last error</dt><dd>${escapeHtml(provider.lastErrorCode ?? 'none')}</dd></dl></details>${windows}${decision}</article>`;
}

function decisionDescription(reason: string | null): string {
  const descriptions: Record<string, string> = {
    TARGET_RESET_WINDOW_MATCH:
      'The target time matches this window. A durable action intent has been planned.',
    TARGET_NOT_DUE: 'The candidate trigger time has not arrived yet.',
    TARGET_MISSED:
      'The candidate time has passed. The action was skipped to avoid an unexpected request.',
    WINDOW_DURATION_UNKNOWN: 'Window duration is unknown. A trigger time cannot be calculated yet.',
    WINDOW_DURATION_CONFIDENCE_TOO_LOW:
      'Window duration confidence is too low for automatic scheduling.',
    WINDOW_PHASE_CONFIDENCE_TOO_LOW:
      'Window phase confidence is too low. Scheduling requires a reliable inactive state.',
    WINDOW_NOT_INACTIVE: 'The window is not inactive. No new window needs to be started.',
    OBSERVATION_STALE: 'The observation is stale. Waiting for fresh provider evidence.',
    OBSERVATION_MISSING: 'Waiting for the first valid provider observation.',
    TRIGGER_CAPABILITY_UNAVAILABLE: 'This provider does not currently support window triggering.',
    AUTOMATION_DISABLED: 'Monitoring is enabled. Automatic actions are disabled.',
  };
  return (
    descriptions[reason ?? ''] ??
    'Review the recorded decision details for the scheduler’s explanation.'
  );
}

function renderWindow(window: WindowSnapshot, now: Date): string {
  const reset = factInstantText(window.resetAt);
  const approximateReset = approximateResetText(window.resetAt, now);
  const usage = window.usageRatio;
  return `<section class="window-card"><div class="window-header"><h3>${window.durationSeconds ? `${formatDuration(window.durationSeconds.value)} window` : 'Usage window'}</h3><span class="badge">${escapeHtml(window.phase.value)}</span></div><p class="window-id">${escapeHtml(window.windowKind)}</p><div class="usage-value">${usage ? `${Math.round(usage.value * 100)}% <small>used</small>` : '<span class="unknown">unknown</span>'}</div>${usage ? `<progress class="quota-progress" max="100" value="${usage.value * 100}" aria-label="Usage for ${escapeHtml(window.windowKind)}">${Math.round(usage.value * 100)}%</progress>` : '<p class="muted">Usage has not been reported.</p>'}<p class="provider-meta">Remaining ${factRatioText(window.remainingRatio)}</p><dl><dt>Reset</dt><dd>${reset}${approximateReset}</dd><dt>Phase</dt><dd>${factText(window.phase.value, window.phase.source, window.phase.confidence)}</dd><dt>Duration</dt><dd>${factNumberText(window.durationSeconds, 's')}</dd></dl></section>`;
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function factRatioText(fact: WindowSnapshot['usageRatio']): string {
  return fact
    ? factText(`${Math.round(fact.value * 100)}%`, fact.source, fact.confidence)
    : unknownText();
}

function factInstantText(fact: WindowSnapshot['resetAt']): string {
  return fact
    ? `<time datetime="${escapeHtml(fact.value)}" title="${escapeHtml(fact.value)}">${new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(fact.value))} UTC</time><details><summary>Timing evidence</summary>${factText(fact.value, fact.source, fact.confidence)}</details>`
    : unknownText();
}

function approximateResetText(fact: WindowSnapshot['resetAt'], now: Date): string {
  if (!fact) return '';
  const resetAtMs = Date.parse(fact.value);

  const deltaSeconds = Math.round((resetAtMs - now.getTime()) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  const [unitSeconds, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absoluteSeconds >= 86_400
      ? [86_400, 'day']
      : absoluteSeconds >= 3_600
        ? [3_600, 'hour']
        : absoluteSeconds >= 60
          ? [60, 'minute']
          : [1, 'second'];
  const value = Math.round(deltaSeconds / unitSeconds);
  const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(value, unit);
  const text = relative.startsWith('in ')
    ? `Reset in approximately ${relative.slice(3)}`
    : `Reset approximately ${relative}`;
  return `<br><span class="muted">${escapeHtml(text)}</span>`;
}

function factNumberText(fact: WindowSnapshot['durationSeconds'], suffix: string): string {
  return fact ? factText(`${fact.value}${suffix}`, fact.source, fact.confidence) : unknownText();
}

function factText(value: string, source: string, confidence: string): string {
  const prefix = source === 'inferred' || source === 'estimated' ? '~' : '';
  return `${escapeHtml(`${prefix}${value}`)} <span class="muted">(${escapeHtml(source)} · ${escapeHtml(confidence)})</span>`;
}

function unknownText(): string {
  return '<span class="unknown">unknown</span>';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };
    return map[char] ?? char;
  });
}
