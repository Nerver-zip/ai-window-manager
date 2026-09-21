import Fastify from 'fastify';
import { renderAppShell } from './ui/layout.js';
import { APP_CSS } from './ui/styles.js';
import { APP_JS } from './ui/chart-interactions.js';
import type { AppConfig } from '../config.js';
import type {
  CurrentWindowState,
  ProviderCapabilities,
  ProviderObservation,
  WindowSnapshot,
} from '../domain/types.js';
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
import {
  readTimezoneSetting,
  updateActivationPolicy,
  updateProviderSettings,
  updateScheduleSettings,
  updateTimezoneSetting,
} from './settings-api.js';
import { readScheduling } from './scheduling-api.js';
import { deriveCurrentWindow } from '../scheduler/current-window.js';
import {
  renderActivationSchedulePage,
  renderSettingsPage as renderSettingsUiPage,
  type SettingsProviderView,
} from './settings-ui.js';
import {
  getHistoryRange,
  HISTORY_PAGE_SIZE,
  MAX_USAGE_POINTS,
  normalizeHistoryRange,
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
import {
  durationLabel,
  effectiveModeLabel,
  errorLabel,
  factQualifier,
  healthLabel,
  isEstimatedSource,
  phaseLabel,
  providerDisplayName,
  reasonLabel,
  windowDisplayName,
} from './ui/presentation.js';

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
  'policyKind',
  'windowKind',
  'currentWindow',
  'currentWindowConfidence',
  'anchorAt',
  'nextAnchorAt',
  'validFrom',
  'validUntil',
  'targetResetAt',
  'targetTriggerAt',
  'windowDurationSeconds',
  'durationConfidence',
  'phase',
  'phaseConfidence',
  'observationAgeSeconds',
  'toleranceSeconds',
  'coverageSeconds',
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
  currentWindow: CurrentWindowState;
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
  app.get('/assets/app.js', async (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(APP_JS),
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
  app.get('/api/v1/scheduling', () =>
    readScheduling({
      repositories: input.repositories,
      adapters: input.adapters,
      clock: input.clock,
    }),
  );

  app.post('/api/v1/settings/timezone', async (request, reply) => {
    const result = updateTimezoneSetting(settingsInput, request.body);
    return reply
      .code(result.ok ? 200 : result.statusCode)
      .send(result.ok ? result.value : { error: { code: result.code, message: result.message } });
  });

  app.post('/api/v1/scheduling', async (request, reply) => {
    const result = updateActivationPolicy(settingsInput, request.body);
    if (result.ok) {
      input.requestReconcile?.();
      return reply.code(200).send(result.value);
    }
    return reply
      .code(result.statusCode)
      .send({ error: { code: result.code, message: result.message } });
  });

  app.get('/history', async (request, reply) => {
    const query = asRecord(request.query);
    const providerId = stringValue(query.provider) ?? undefined;
    const range = normalizeHistoryRange(query.range);
    const page = positivePage(query.page);
    const now = input.clock.now();
    const nowMs = now.getTime();
    const offset = (page - 1) * HISTORY_PAGE_SIZE;
    const providers = input.repositories.providers.list();
    const selectedProviders = providerId
      ? providers.filter((provider) => provider.id === providerId)
      : providers;
    const events = input.repositories.events.list(providerId, {
      limit: HISTORY_PAGE_SIZE + 1,
      offset,
      afterMs: nowMs - getHistoryRange(range).durationMs,
      beforeMs: nowMs + 1,
    });
    const hasNext = events.length > HISTORY_PAGE_SIZE;
    const samples = selectedProviders.flatMap((provider) =>
      input.repositories.windowSamples.list(provider.id, { limit: MAX_USAGE_POINTS * 8 }),
    );

    reply.type('text/html; charset=utf-8');
    return renderHistoryPage({
      now,
      filter: { range, ...(providerId ? { providerId } : {}) },
      providers: providers.map((provider) => ({ id: provider.id, label: provider.id })),
      events: events.slice(0, HISTORY_PAGE_SIZE).map(historyTimelineEvent),
      samples: samples.map(historyUsageSample),
      pagination: {
        page,
        pageSize: HISTORY_PAGE_SIZE,
        hasNext,
        ...(page > 1 ? { previousHref: historyPageHref(range, providerId, page - 1) } : {}),
        ...(hasNext ? { nextHref: historyPageHref(range, providerId, page + 1) } : {}),
      },
    });
  });

  app.get('/settings', async (request, reply) => {
    const csrf = ensureCsrfToken(request.headers.cookie, {
      secure: request.protocol === 'https',
    });
    if (csrf.setCookie) reply.header('Set-Cookie', csrf.setCookie);
    reply.type('text/html; charset=utf-8');
    const notice = queryMessage(request.query);
    const timezone = readTimezoneSetting(settingsInput);
    return renderSettingsUiPage({
      csrfToken: csrf.token,
      providers: settingsProviderViews(input),
      ...(timezone ? { timezone } : {}),
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
    const scheduling = readScheduling({
      repositories: input.repositories,
      adapters: input.adapters,
      clock: input.clock,
    });
    const selected =
      scheduling.providers.find(
        (provider) => provider.policy?.providerId === provider.providerId,
      ) ?? scheduling.providers[0];
    return renderActivationSchedulePage({
      csrfToken: csrf.token,
      providers: settingsProviderViews(input),
      ...(selected?.policy ? { policy: selected.policy } : {}),
      ...(scheduling.timezone ? { timezone: scheduling.timezone } : {}),
      ...(selected?.currentWindow ? { currentWindow: selected.currentWindow } : {}),
      ...(selected?.decision ? { decision: selected.decision } : {}),
      ...(selected?.upcoming ? { upcoming: selected.upcoming } : {}),
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

  app.post('/settings/timezone', async (request, reply) => {
    const result = updateTimezoneSetting(
      settingsInput,
      normalizeTimezoneSettingsBody(request.body),
    );
    if (!result.ok) {
      return reply.code(result.statusCode).type('text/plain; charset=utf-8').send(result.message);
    }
    input.requestReconcile?.();
    return reply.code(303).redirect('/settings?updated=timezone');
  });

  app.post('/schedule', async (request, reply) => {
    const body = request.body;
    const normalized = normalizeActivationScheduleBody(body);
    const result = normalized
      ? updateActivationPolicy(settingsInput, normalized)
      : updateScheduleSettings(settingsInput, normalizeScheduleSettingsBody(body));
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

function parseFormBody(body: string): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const previous = values[key];
    values[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return values;
}

function positivePage(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 50_000) : 1;
}

function historyPageHref(range: string, providerId: string | undefined, page: number): string {
  const params = new URLSearchParams({ range, page: String(page) });
  if (providerId) params.set('provider', providerId);
  return `/history?${params.toString()}`;
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

function normalizeActivationScheduleBody(body: unknown): unknown {
  const record = asRecord(body);
  if (typeof record.policyKind !== 'string') return undefined;
  const base = {
    kind: record.policyKind,
    providerId: record.providerId,
    enabled: formBoolean(record.enabled ?? true),
  };
  if (typeof record.timezone === 'string' && record.timezone.length > 0) {
    (base as Record<string, unknown>).timezone = record.timezone;
  }
  if (record.policyKind === 'fixed') {
    return {
      ...base,
      windowKind: record.windowKind,
      anchorLocalTime: record.anchorLocalTime,
      toleranceSeconds: Number(record.toleranceSeconds),
    };
  }
  if (record.policyKind === 'custom_schedule') {
    return {
      ...base,
      windowKind: record.windowKind,
      times: splitList(record.times),
      toleranceSeconds: Number(record.toleranceSeconds),
    };
  }
  if (record.policyKind === 'active_hours') {
    return {
      ...base,
      windowKind: record.windowKind,
      periods: splitList(record.periods).map((value) => {
        const [start, end] = value.split('-');
        return { start, end };
      }),
    };
  }
  return base;
}

function normalizeTimezoneSettingsBody(body: unknown): unknown {
  const record = asRecord(body);
  return {
    timezone: record.timezone,
    source: record.source === 'detected' ? 'detected' : 'manual',
  };
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
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
      : value === 'timezone'
        ? 'Time zone saved.'
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
      currentWindow: deriveCurrentWindow(provider.id, observation, state?.health),
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
    description: 'See what is connected, how much remains, and what happens next.',
    content: `<section class="summary-grid" aria-label="Workspace summary"><div class="summary-stat"><strong>${providers.length}</strong><span>Providers monitored</span></div><div class="summary-stat"><strong>${providers.filter((p) => p.health === 'UP').length}</strong><span>Connected providers</span></div><div class="summary-stat"><strong>${providers.filter((p) => p.mode === 'automation').length}</strong><span>Automatic actions</span></div></section>${cards || '<section class="empty-state"><h2>No providers are being monitored</h2><p>Add a provider in the service configuration to start seeing usage windows here.</p></section>'}`,
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
      ? `<div class="window-grid">${provider.windows.map((window) => renderWindow(provider.id, window, now)).join('')}</div>`
      : '<div class="empty-state"><h3>Waiting for the first update</h3><p>Usage windows will appear after the provider is checked.</p></div>';
  const decision = provider.nextDecision
    ? `<section class="decision-panel"><p class="eyebrow">NEXT STEP</p><h3>${provider.nextDecision.decision === 'create_intent' ? 'Automatic action planned' : 'No automatic action planned'}</h3><p>${escapeHtml(decisionDescription(provider.nextDecision.reasonCode))}</p></section>`
    : '<section class="decision-panel"><p class="eyebrow">NEXT STEP</p><h3>Waiting for a schedule</h3><p>Set a reset time on the <a href="/schedule">Schedule</a> page to see what happens next.</p></section>';

  const displayName = providerDisplayName(provider.id, provider.kind);
  const monitoringState = provider.enabled ? 'Monitoring enabled' : 'Monitoring paused';
  return `<article class="provider${staleClass}"><header class="provider-header"><div><h2>${escapeHtml(displayName)}</h2><p class="provider-meta">${escapeHtml(monitoringState)}</p></div><div class="badges"><span class="badge ${provider.health === 'UP' ? 'badge-success' : 'badge-warning'}">${escapeHtml(healthLabel(provider.health))}</span><span class="badge">${escapeHtml(effectiveModeLabel(provider.mode, provider.capabilities?.windowTrigger.supported))}</span></div></header><p class="provider-meta">Last updated ${escapeHtml(freshnessLabel)}</p>${provider.freshness.stale ? '<p class="stale-notice">This information is out of date. Automatic planning is paused until a fresh update arrives.</p>' : ''}${provider.health === 'AUTH_REQUIRED' ? '<p class="notice">Sign-in is required in the official provider client.</p>' : ''}<section class="current-window-read" aria-labelledby="current-window-${escapeHtml(provider.id)}"><div><p class="eyebrow">OBSERVED STATE</p><h3 id="current-window-${escapeHtml(provider.id)}">Current window</h3><strong class="current-window-status">${escapeHtml(currentWindowLabel(provider.currentWindow.status))}</strong><p class="provider-meta">${escapeHtml(currentWindowDetail(provider, displayName))}</p></div>${provider.currentWindow.expectedEndAt ? `<p class="provider-meta"><span>Expected end</span><br><time datetime="${escapeHtml(provider.currentWindow.expectedEndAt.value)}">${escapeHtml(formatUtc(provider.currentWindow.expectedEndAt.value))}</time></p>` : ''}</section>${provider.currentWindow.reason ? `<p class="stale-notice">${escapeHtml(currentWindowReason(provider.currentWindow.reason))}</p>` : ''}<details><summary>Connection details</summary><dl><dt>Status</dt><dd>${escapeHtml(healthLabel(provider.health))}</dd><dt>Last issue</dt><dd>${escapeHtml(errorLabel(provider.lastErrorCode))}</dd></dl></details>${windows}${decision}</article>`;
}

function currentWindowLabel(status: CurrentWindowState['status']): string {
  switch (status) {
    case 'ACTIVE':
      return 'Active';
    case 'INACTIVE':
      return 'Inactive';
    case 'UNKNOWN':
      return 'Not available yet';
    case 'UNAVAILABLE':
      return 'Monitoring unavailable';
  }
}

function currentWindowDetail(provider: ProviderRead, displayName: string): string {
  const current = provider.currentWindow;
  if (!current.windowKind) return `${displayName} has not reported a window yet.`;
  const window = provider.windows.find((candidate) => candidate.windowKind === current.windowKind);
  return (
    windowDisplayName(provider.id, current.windowKind, window?.durationSeconds?.value) +
    ` · ${current.confidence === 'exact' ? 'high confidence' : current.confidence === 'high' ? 'good confidence' : 'limited confidence'}`
  );
}

function currentWindowReason(reason: string): string {
  switch (reason) {
    case 'AUTH_REQUIRED':
      return 'Sign-in is required before a current window can be confirmed.';
    case 'MONITORING_UNAVAILABLE':
      return 'The last saved window remains available, but it is not safe to use for automatic planning.';
    case 'WINDOW_STATE_UNCERTAIN':
      return 'The provider reported information that is not reliable enough to classify the current window.';
    case 'NO_WINDOW_REPORTED':
      return 'The provider has not reported a usage window yet.';
    default:
      return 'The current window could not be confirmed.';
  }
}

function formatUtc(value: string): string {
  try {
    return (
      new Intl.DateTimeFormat('en', {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value)) + ' UTC'
    );
  } catch {
    return value;
  }
}

function decisionDescription(reason: string | null): string {
  return reasonLabel(reason);
}

function renderWindow(providerId: string, window: WindowSnapshot, now: Date): string {
  const reset = factInstantText(window.resetAt);
  const approximateReset = approximateResetText(window.resetAt, now);
  const usage = window.usageRatio;
  const label = windowDisplayName(providerId, window.windowKind, window.durationSeconds?.value);
  return `<section class="window-card"><div class="window-header"><h3>${escapeHtml(label)}</h3><span class="badge">${escapeHtml(phaseLabel(window.phase.value))}</span></div><p class="window-id">Usage limits</p><div class="usage-value">${usage ? `${Math.round(usage.value * 100)}% <small>used</small>` : unknownText()}</div>${usage ? `<progress class="quota-progress" max="100" value="${usage.value * 100}" aria-label="Usage for ${escapeHtml(label)}">${Math.round(usage.value * 100)}%</progress>` : '<p class="muted">Usage has not been reported yet.</p>'}<p class="provider-meta">Remaining ${factRatioText(window.remainingRatio)}</p><dl><dt>Reset</dt><dd>${reset}${approximateReset}</dd><dt>Phase</dt><dd>${factText(phaseLabel(window.phase.value), window.phase.source, window.phase.confidence)}</dd><dt>Duration</dt><dd>${factNumberText(window.durationSeconds)}</dd></dl></section>`;
}

function factRatioText(fact: WindowSnapshot['usageRatio']): string {
  return fact
    ? factText(`${Math.round(fact.value * 100)}%`, fact.source, fact.confidence)
    : unknownText();
}

function factInstantText(fact: WindowSnapshot['resetAt']): string {
  return fact
    ? `<time datetime="${escapeHtml(fact.value)}" title="${escapeHtml(fact.value)}">${new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(fact.value))} UTC</time><details><summary>Why this time is shown</summary><span class="muted">${escapeHtml(factQualifier(fact.source, fact.confidence))}</span></details>`
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

function factNumberText(fact: WindowSnapshot['durationSeconds'], suffix = ''): string {
  return fact
    ? factText(
        suffix ? `${fact.value}${suffix}` : durationLabel(fact.value),
        fact.source,
        fact.confidence,
      )
    : unknownText();
}

function factText(value: string, source: string, confidence: string): string {
  const prefix = isEstimatedSource(source) ? 'Approximately ' : '';
  return `${escapeHtml(`${prefix}${value}`)} <span class="muted">(${escapeHtml(factQualifier(source, confidence))})</span>`;
}

function unknownText(): string {
  return '<span class="unknown">Not available yet</span>';
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
