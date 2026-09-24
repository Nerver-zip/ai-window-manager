import { promises as fs } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { renderAppShell } from './ui/layout.js';
import { APP_CSS } from './ui/styles.js';
import { APP_JS } from './ui/chart-interactions.js';
import { AUTH_ONBOARDING_CSS } from './ui/auth-onboarding-styles.js';
import { AUTH_ONBOARDING_JS } from './ui/auth-onboarding-interactions.js';
import {
  AuthSessionError,
  type AuthProviderId,
  type AuthSessionManager,
  type AuthSessionSnapshot,
} from '../auth/session-manager.js';
import type { AppConfig } from '../config.js';
import type {
  ActivationPolicy,
  CurrentWindowState,
  ProviderCapabilities,
  ProviderObservation,
  WindowSnapshot,
} from '../domain/types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import { filterVisibleProviders, isProviderVisible } from '../providers/visibility.js';
import type { Clock } from '../scheduler/clock.js';
import { activationPolicyFromRecord, parseActivationPolicy } from '../scheduler/policy.js';
import type { SqliteDatabase } from '../storage/database.js';
import type {
  EventRecord,
  ProviderRecord,
  ProviderStateRecord,
  StorageRepositories,
} from '../storage/repositories.js';
import { registry } from '../metrics/metrics.js';
import { createCommandApi } from './api-commands.js';
import { createReadApi } from './api-read.js';
import {
  ActivationPolicySettingsSchema,
  readTimezoneSetting,
  updateActivationPolicy,
  updateProviderSettings,
  updateScheduleSettings,
  updateTimezoneSetting,
} from './settings-api.js';
import { readScheduling } from './scheduling-api.js';
import { deriveCurrentWindow } from '../scheduler/current-window.js';
import { readUsagePageData, USAGE_CHART_BUCKETS } from '../usage/service.js';
import { renderUsagePage } from './usage-ui.js';
import {
  renderActivationSchedulePage,
  renderScheduleHorizon,
  renderSettingsPage as renderSettingsUiPage,
  type SettingsProviderView,
} from './settings-ui.js';
import {
  getHistoryRange,
  HISTORY_PAGE_SIZE,
  MAX_USAGE_POINTS,
  buildUsageSeries,
  chartRangeKey,
  filterHistoryEvents,
  normalizeChartRanges,
  normalizeLogTag,
  normalizeHistoryRange,
  renderLogsPage,
  serializeChartRangeSelection,
  type LogTag,
  type HistoryTimelineEvent,
  type HistoryUsageSample,
} from './logs-ui.js';
import {
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  ensureCsrfToken,
  getSecurityHeaders,
  validateCsrf,
  validateMutationOrigin,
} from './security.js';
import {
  errorLabel,
  healthLabel,
  isEstimatedSource,
  providerDisplayName,
  providerLogoUrl,
  timeZoneDisplayName,
  windowDisplayName,
} from './ui/presentation.js';

const STATIC_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const ASSETS_DIR = path.resolve(process.cwd(), 'assets');
const AUTH_PROVIDER_IDS: readonly AuthProviderId[] = ['codex', 'antigravity'];
const APP_CSS_WITH_AUTH = `${APP_CSS}\n${AUTH_ONBOARDING_CSS}`;
const APP_JS_WITH_AUTH = `${APP_JS}\n${AUTH_ONBOARDING_JS}`;

export interface BuildServerInput {
  config: AppConfig;
  db: SqliteDatabase;
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  clock: Clock;
  authSessions?: AuthSessionManager;
  requestReconcile?: () => void;
}

type ProviderHealthRead = ProviderStateRecord['health'] | 'UNKNOWN';

interface FreshnessRead {
  observedAt: string | null;
  ageSeconds: number | null;
  staleAfterSeconds: number | null;
  stale: boolean;
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
  activationPolicy: ActivationPolicy | null;
  activationPolicyNeedsAttention: boolean;
  capabilities?: ProviderCapabilities;
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
    fakeProviderEnabled: input.config.AWM_FAKE_PROVIDER_ENABLED,
  });
  app.get('/assets/app.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(APP_CSS_WITH_AUTH),
  );
  app.get('/assets/app.js', async (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(APP_JS_WITH_AUTH),
  );
  app.get('/assets/images/*', async (request, reply) => {
    const rawPath = (request.params as { '*': string })['*'];
    const safePath = path.normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const assetPath = path.join(ASSETS_DIR, 'images', safePath);
    try {
      const ext = path.extname(assetPath).toLowerCase();
      const mime = STATIC_MIME_TYPES[ext];
      if (!mime) return reply.code(404).send({ error: 'not found' });
      const stat = await fs.stat(assetPath);
      if (!stat.isFile()) return reply.code(404).send({ error: 'not found' });
      const buffer = await fs.readFile(assetPath);
      reply.header('Cache-Control', 'public, max-age=86400, immutable');
      return reply.type(mime).send(buffer);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });
  app.get('/favicon.ico', async (_request, reply) => {
    const faviconPath = path.join(ASSETS_DIR, 'images', 'logo.png');
    const buffer = await fs.readFile(faviconPath);
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.type('image/png').send(buffer);
  });
  const commandApi = createCommandApi({
    repositories: input.repositories,
    adapters: input.adapters,
    clock: input.clock,
    requestReconcile: input.requestReconcile,
    fakeProviderEnabled: input.config.AWM_FAKE_PROVIDER_ENABLED,
  });
  const settingsInput = {
    repositories: input.repositories,
    adapters: input.adapters,
    clock: input.clock,
    fakeProviderEnabled: input.config.AWM_FAKE_PROVIDER_ENABLED,
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

  app.get('/api/v1/providers/:id/auth/status', async (request, reply) => {
    const providerId = configuredAuthProviderId(input, (request.params as { id?: unknown }).id);
    if (!providerId) return reply.code(404).send({ error: { code: 'PROVIDER_NOT_FOUND' } });
    return readAuthStatus(input, providerId);
  });

  app.post('/api/v1/providers/:id/auth/start', async (request, reply) => {
    const providerId = configuredAuthProviderId(input, (request.params as { id?: unknown }).id);
    if (!providerId) return reply.code(404).send({ error: { code: 'PROVIDER_NOT_FOUND' } });
    try {
      return reply.code(202).send(input.authSessions!.start(providerId));
    } catch (error) {
      const failure = authSessionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.error });
    }
  });

  app.post('/api/v1/providers/:id/auth/submit', async (request, reply) => {
    const providerId = configuredAuthProviderId(input, (request.params as { id?: unknown }).id);
    if (!providerId) return reply.code(404).send({ error: { code: 'PROVIDER_NOT_FOUND' } });
    try {
      return reply
        .code(202)
        .send(input.authSessions!.submitCode(providerId, asRecord(request.body).code));
    } catch (error) {
      const failure = authSessionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.error });
    }
  });

  app.post('/api/v1/providers/:id/auth/cancel', async (request, reply) => {
    const providerId = configuredAuthProviderId(input, (request.params as { id?: unknown }).id);
    if (!providerId) return reply.code(404).send({ error: { code: 'PROVIDER_NOT_FOUND' } });
    return reply.code(200).send(input.authSessions!.cancel(providerId));
  });

  app.get('/api/v1/providers/:id', async (request, reply) => {
    const result = readApi.getProvider((request.params as { id?: unknown }).id);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get('/api/v1/history', async (request, reply) => {
    const result = readApi.getHistory(request.query);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get('/api/v1/usage', async (request, reply) => {
    const query = asRecord(request.query);
    const requestedProvider = stringValue(query.provider) ?? undefined;
    const usage = resolveUsageView(input, query);
    if (usage.error) return reply.code(usage.error.statusCode).send({ error: usage.error.code });
    if (requestedProvider && usage.data.selectedProviderId !== requestedProvider) {
      return reply.code(404).send({ error: 'PROVIDER_NOT_FOUND' });
    }
    return {
      timezone: usage.data.timezone,
      today: usage.data.today,
      fromDate: usage.data.fromDate,
      generatedAt: new Date(usage.data.generatedAtMs).toISOString(),
      aggregationPending: usage.data.aggregationPending,
      providers: usage.data.providers,
      selectedProviderId: usage.data.selectedProviderId,
      windows: usage.data.windows,
      selectedWindowKind: usage.data.selectedWindowKind,
      selectedDay: usage.data.selectedDay,
      days: usage.data.days,
      charts: usage.series,
    };
  });

  app.get('/api/v1/settings', () => readApi.getSettings().body);
  app.get('/api/v1/scheduling', () =>
    readScheduling({
      repositories: input.repositories,
      adapters: input.adapters,
      clock: input.clock,
      fakeProviderEnabled: input.config.AWM_FAKE_PROVIDER_ENABLED,
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
    const requestedUrl = request.raw.url ?? '/history';
    return reply.code(301).redirect(requestedUrl.replace(/^\/history(?=\?|$)/, '/logs'));
  });

  app.get('/logs', async (request, reply) => {
    const query = asRecord(request.query);
    const providerId = stringValue(query.provider) ?? undefined;
    if (providerId && !isProviderVisible(providerId, input.config.AWM_FAKE_PROVIDER_ENABLED)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Provider not found');
    }
    const range = normalizeHistoryRange(query.range);
    const tag = normalizeLogTag(query.tag);
    const eventType = normalizeEventType(query.type);
    const chartRangeQuery = queryStringValues(query.chartRange);
    const page = positivePage(query.page);
    const now = input.clock.now();
    const providers = filterVisibleProviders(
      input.repositories.providers.list(),
      input.config.AWM_FAKE_PROVIDER_ENABLED,
    );
    const selectedProviders = providerId
      ? providers.filter((provider) => provider.id === providerId)
      : providers;
    const logPage = readLogsPage(input, {
      providerId,
      range,
      tag,
      eventType,
      page,
      now,
    });
    const usageChartsHref = logsUsageHref(
      chartRangeQuery,
      providerId,
      providers.map((provider) => provider.id),
    );
    const routineEventsHref = logsPageHref(
      range,
      providerId,
      1,
      chartRangeQuery,
      eventType === 'scheduler_noop' ? tag : 'sync',
      eventType === 'scheduler_noop' ? null : 'scheduler_noop',
    );
    const samples = selectedProviders.flatMap((provider) =>
      input.repositories.windowSamples.list(provider.id, { limit: MAX_USAGE_POINTS * 8 }),
    );

    reply.type('text/html; charset=utf-8');
    return renderLogsPage({
      now,
      timeZone: readTimezoneSetting(settingsInput)?.timezone ?? input.config.AWM_TIMEZONE,
      filter: {
        range,
        ...(providerId ? { providerId } : {}),
        chartRanges: chartRangeQuery,
        tag,
        eventType,
      },
      providers: providers.map((provider) => ({
        id: provider.id,
        label: providerDisplayName(provider.id),
      })),
      events: logPage.events,
      samples: samples.map(historyUsageSample),
      ...(usageChartsHref ? { usageChartsHref } : {}),
      routineEventsHref,
      pagination: {
        page,
        pageSize: HISTORY_PAGE_SIZE,
        hasNext: logPage.hasNext,
        ...(page > 1
          ? {
              previousHref: logsPageHref(
                range,
                providerId,
                page - 1,
                chartRangeQuery,
                tag,
                eventType,
              ),
            }
          : {}),
        ...(logPage.hasNext
          ? { nextHref: logsPageHref(range, providerId, page + 1, chartRangeQuery, tag, eventType) }
          : {}),
      },
    });
  });

  app.get('/usage', async (request, reply) => {
    const query = asRecord(request.query);
    const usage = resolveUsageView(input, query);
    if (usage.error) {
      return reply
        .code(usage.error.statusCode)
        .type('text/plain; charset=utf-8')
        .send(
          usage.error.code === 'PROVIDER_NOT_FOUND'
            ? 'Provider not found'
            : 'Usage view unavailable',
        );
    }
    reply.type('text/html; charset=utf-8');
    return renderUsagePage({
      data: usage.data,
      series: usage.series,
      chartRanges: usage.chartRanges,
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
      authProviders: configuredAuthProviders(input),
      referenceInstant: input.clock.now(),
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
      fakeProviderEnabled: input.config.AWM_FAKE_PROVIDER_ENABLED,
    });
    const requestedProviderId = stringValue(asRecord(request.query).providerId);
    const selected =
      (requestedProviderId
        ? scheduling.providers.find((provider) => provider.providerId === requestedProviderId)
        : undefined) ??
      scheduling.providers.find(
        (provider) => provider.policy?.providerId === provider.providerId,
      ) ??
      scheduling.providers[0];
    return renderActivationSchedulePage({
      csrfToken: csrf.token,
      providers: settingsProviderViews(input),
      ...(selected ? { selectedProviderId: selected.providerId } : {}),
      ...(selected?.policy ? { policy: selected.policy } : {}),
      ...(scheduling.timezone ? { timezone: scheduling.timezone } : {}),
      ...(selected?.currentWindow ? { currentWindow: selected.currentWindow } : {}),
      ...(selected?.decision ? { decision: selected.decision } : {}),
      ...(selected?.upcoming ? { upcoming: selected.upcoming } : {}),
      referenceInstant: input.clock.now(),
      ...(notice ? { notice } : {}),
    });
  });

  app.get('/schedule/preview', async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const settings = settingsProviderViews(input);
    const normalized = normalizeActivationScheduleBody(request.query);
    const parsed = ActivationPolicySettingsSchema.safeParse(normalized);
    if (!parsed.success) {
      return reply.send(
        '<p class="horizon-empty" role="status">Complete the selected schedule to preview it.</p>',
      );
    }
    const savedTimezone = readTimezoneSetting(settingsInput)?.timezone;
    const existingPolicy = input.repositories.schedulePolicies
      .list(parsed.data.providerId)
      .find((candidate) => candidate.id === `activation-${parsed.data.providerId}`);
    const timezone = parsed.data.timezone ?? savedTimezone ?? existingPolicy?.timezone;
    if (!timezone) {
      return reply.send(
        '<p class="horizon-empty" role="status">Choose a time zone in Settings to see local schedule times.</p>',
      );
    }
    let policy;
    try {
      policy = parseActivationPolicy({
        ...parsed.data,
        id: `activation-${parsed.data.providerId}`,
        timezone,
        updatedAtMs: input.clock.now().getTime(),
      });
    } catch {
      return reply.send(
        '<p class="horizon-empty" role="status">Complete the selected schedule to preview it.</p>',
      );
    }
    const provider = settings.find((candidate) => candidate.id === policy.providerId);
    const state = input.repositories.providerState.get(policy.providerId);
    const currentWindow = deriveCurrentWindow(
      policy.providerId,
      state?.observation,
      state?.health,
      'windowKind' in policy ? policy.windowKind : undefined,
    );
    return reply.send(
      renderScheduleHorizon({
        policy,
        provider,
        currentWindow,
        referenceInstant: input.clock.now(),
        timezone,
      }),
    );
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
    const providerId = stringValue(asRecord(normalized).providerId);
    const providerQuery = providerId ? `&providerId=${encodeURIComponent(providerId)}` : '';
    return reply.code(303).redirect(`/schedule?updated=schedule${providerQuery}`);
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
    const timezone =
      readTimezoneSetting({ repositories: input.repositories })?.timezone ??
      input.config.AWM_TIMEZONE;
    return renderOverview(providers, input.clock.now(), timezone);
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

function configuredAuthProviderId(
  input: BuildServerInput,
  value: unknown,
): AuthProviderId | undefined {
  if (
    !input.authSessions ||
    typeof value !== 'string' ||
    !AUTH_PROVIDER_IDS.includes(value as AuthProviderId) ||
    !input.adapters.has(value)
  ) {
    return undefined;
  }
  return value as AuthProviderId;
}

function configuredAuthProviders(input: BuildServerInput) {
  return AUTH_PROVIDER_IDS.flatMap((providerId) => {
    if (!configuredAuthProviderId(input, providerId)) return [];
    return [{ providerId, status: readAuthStatus(input, providerId), configured: true }];
  });
}

function readAuthStatus(input: BuildServerInput, providerId: AuthProviderId): AuthSessionSnapshot {
  const current = input.authSessions?.status(providerId);
  if (!current || current.state !== 'IDLE') return current ?? idleAuthStatus(providerId);

  const state = input.repositories.providerState.get(providerId);
  if ((state?.health === 'UP' || state?.health === 'DEGRADED') && state.lastSuccessAtMs !== null) {
    return {
      ...current,
      state: 'SUCCEEDED',
      startedAt: new Date(state.lastSuccessAtMs).toISOString(),
    };
  }
  if (state?.health === 'AUTH_REQUIRED') {
    return { ...current, state: 'FAILED', reasonCode: 'AUTH_REQUIRED' };
  }
  return current;
}

function idleAuthStatus(providerId: AuthProviderId): AuthSessionSnapshot {
  return {
    providerId,
    state: 'IDLE',
    startedAt: null,
    expiresAt: null,
    authorizationUrl: null,
    userCode: null,
    requiresCodeSubmission: false,
    reasonCode: null,
  };
}

function authSessionFailure(error: unknown): {
  statusCode: number;
  error: { code: string; message: string };
} {
  if (!(error instanceof AuthSessionError)) {
    return {
      statusCode: 500,
      error: { code: 'AUTH_SESSION_FAILED', message: 'The sign-in flow could not be started.' },
    };
  }
  const failures = {
    PROVIDER_UNAVAILABLE: {
      statusCode: 404,
      error: {
        code: 'AUTH_PROVIDER_UNAVAILABLE',
        message: 'Sign-in is not available for this provider.',
      },
    },
    SESSION_ACTIVE: {
      statusCode: 409,
      error: { code: 'AUTH_SESSION_ACTIVE', message: 'A sign-in is already in progress.' },
    },
    SESSION_NOT_WAITING: {
      statusCode: 409,
      error: { code: 'AUTH_SESSION_NOT_WAITING', message: 'There is no sign-in code to submit.' },
    },
    CODE_INVALID: {
      statusCode: 400,
      error: {
        code: 'AUTH_CODE_INVALID',
        message: 'Enter the sign-in code shown by the provider.',
      },
    },
  } as const;
  return failures[error.code];
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

function logsPageHref(
  range: string,
  providerId: string | undefined,
  page: number,
  chartRanges: readonly string[] = [],
  tag: LogTag | null = null,
  eventType: string | null = null,
): string {
  const params = new URLSearchParams({ range, page: String(page) });
  if (providerId) params.set('provider', providerId);
  if (tag) params.set('tag', tag);
  if (eventType) params.set('type', eventType);
  for (const chartRange of chartRanges) params.append('chartRange', chartRange);
  return `/logs?${params.toString()}`;
}

function readLogsPage(
  input: BuildServerInput,
  options: {
    providerId: string | undefined;
    range: ReturnType<typeof normalizeHistoryRange>;
    tag: LogTag | null;
    eventType: string | null;
    page: number;
    now: Date;
  },
): { events: HistoryTimelineEvent[]; hasNext: boolean } {
  const pageStart = (options.page - 1) * HISTORY_PAGE_SIZE;
  const requiredCount = pageStart + HISTORY_PAGE_SIZE + 1;
  const includeInspections = options.tag === 'sync' || options.eventType === 'provider_inspected';
  const includeRoutineChecks = options.eventType === 'scheduler_noop';
  const excludeTypes = [
    ...(!includeInspections ? ['provider_inspected'] : []),
    ...(!includeRoutineChecks ? ['scheduler_noop'] : []),
  ];
  const matchingPage: HistoryTimelineEvent[] = [];
  let matchingCount = 0;
  let offset = 0;
  const fetchSize = 100;
  const maxOffset = 1_000_000;

  while (offset < maxOffset && matchingCount < requiredCount) {
    const batch = input.repositories.events.list(options.providerId, {
      limit: fetchSize,
      offset,
      afterMs: options.now.getTime() - getHistoryRange(options.range).durationMs,
      beforeMs: options.now.getTime() + 1,
      excludeTypes,
      ...(input.config.AWM_FAKE_PROVIDER_ENABLED ? {} : { excludeProviderId: 'fake' }),
    });
    if (batch.length === 0) break;

    const filtered = filterHistoryEvents(batch.map(historyTimelineEvent), options.now, {
      range: options.range,
      ...(options.providerId ? { providerId: options.providerId } : {}),
      tag: options.tag,
      eventType: options.eventType,
    });
    for (const event of filtered) {
      if (matchingCount >= pageStart && matchingPage.length < HISTORY_PAGE_SIZE + 1) {
        matchingPage.push(event);
      }
      matchingCount += 1;
    }

    offset += batch.length;
    if (batch.length < fetchSize) break;
  }

  return {
    events: matchingPage.slice(0, HISTORY_PAGE_SIZE),
    hasNext: matchingPage.length > HISTORY_PAGE_SIZE,
  };
}

function logsUsageHref(
  chartRangeQuery: readonly string[],
  providerId: string | undefined,
  visibleProviderIds: readonly string[],
): string | null {
  const ranges = normalizeChartRanges(chartRangeQuery);
  const visible = new Set(visibleProviderIds);
  const params = new URLSearchParams();
  if (providerId) params.set('provider', providerId);
  for (const [key, range] of Object.entries(ranges)) {
    const separator = key.indexOf('\u0000');
    if (separator < 1) continue;
    const selectedProvider = key.slice(0, separator);
    const windowKind = key.slice(separator + 1);
    if (!visible.has(selectedProvider) || (providerId && providerId !== selectedProvider)) continue;
    params.append('chartRange', serializeChartRangeSelection(selectedProvider, windowKind, range));
  }
  const query = params.toString();
  return query ? `/usage?${query}` : null;
}

function normalizeProviderSettingsBody(body: unknown): unknown {
  const record = asRecord(body);
  const preset = stringValue(record.refreshIntervalPreset);
  const pollIntervalSeconds =
    preset === 'custom'
      ? Number(record.customPollIntervalSeconds)
      : preset !== null && ['60', '300', '900'].includes(preset)
        ? Number(preset)
        : Number(record.pollIntervalSeconds);
  return {
    enabled: formBoolean(record.enabled),
    mode: record.mode,
    pollIntervalSeconds,
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
  if (record.policyKind === 'auto') {
    return {
      ...base,
      ...(typeof record.windowKind === 'string' ? { windowKind: record.windowKind } : {}),
    };
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
    const starts = splitList(record.periodStarts);
    const ends = splitList(record.periodEnds);
    const periods =
      starts.length > 0 && starts.length === ends.length
        ? starts.map((start, index) => ({ start, end: ends[index] }))
        : splitList(record.periods).map((value) => {
            const [start, end] = value.split('-');
            return { start, end };
          });
    return {
      ...base,
      windowKind: record.windowKind,
      periods,
    };
  }
  return base;
}

function normalizeTimezoneSettingsBody(body: unknown): unknown {
  const record = asRecord(body);
  return {
    timezone:
      record.timezoneChoice === 'custom'
        ? record.customTimezone
        : typeof record.timezoneChoice === 'string'
          ? record.timezoneChoice
          : record.timezone,
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
  return filterVisibleProviders(
    input.repositories.providers.list(),
    input.config.AWM_FAKE_PROVIDER_ENABLED,
  ).map((provider) => {
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
      staleAfterSeconds: input.repositories.providerState.get(provider.id)?.observation
        ?.staleAfterSeconds,
    };
  });
}

function readProviders(input: BuildServerInput): ProviderRead[] {
  const nowMs = input.clock.now().getTime();
  const timezone =
    readTimezoneSetting({ repositories: input.repositories })?.timezone ??
    input.config.AWM_TIMEZONE;
  return filterVisibleProviders(
    input.repositories.providers.list(),
    input.config.AWM_FAKE_PROVIDER_ENABLED,
  ).map((provider) => {
    const state = input.repositories.providerState.get(provider.id);
    const observation = state?.observation ?? null;
    const adapter = input.adapters.get(provider.id);
    const capabilities = adapter ? safeCapabilities(adapter) : undefined;
    const policyRecord = input.repositories.schedulePolicies
      .list(provider.id)
      .find((candidate) => candidate.id === `activation-${provider.id}`);
    let activationPolicy: ActivationPolicy | null = null;
    let activationPolicyNeedsAttention = false;
    if (policyRecord) {
      try {
        activationPolicy = activationPolicyFromRecord(policyRecord, timezone) ?? null;
        activationPolicyNeedsAttention = activationPolicy === null;
      } catch {
        activationPolicyNeedsAttention = true;
      }
    }

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
      activationPolicy,
      activationPolicyNeedsAttention,
      ...(capabilities ? { capabilities } : {}),
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

function resolveUsageView(input: BuildServerInput, query: Record<string, unknown>) {
  const providers = filterVisibleProviders(
    input.repositories.providers.list(),
    input.config.AWM_FAKE_PROVIDER_ENABLED,
  );
  const requestedProvider = stringValue(query.provider) ?? undefined;
  if (requestedProvider && !providers.some((provider) => provider.id === requestedProvider)) {
    return { error: { statusCode: 404 as const, code: 'PROVIDER_NOT_FOUND' } };
  }
  const chartRanges = { ...normalizeChartRanges(queryStringValues(query.chartRange)) };
  const requestedWindow = stringValue(query.window);
  // Older links used a range-only query parameter. Current chart controls send
  // the complete provider/window/range tuple in `chartRange`, so each graph's
  // selection survives empty intervals and unrelated filter submissions.
  const selectedRange = stringValue(query.chartRangeChoice);
  if (requestedProvider && requestedWindow && selectedRange) {
    chartRanges[chartRangeKey(requestedProvider, requestedWindow)] =
      normalizeHistoryRange(selectedRange);
  }
  const timezone =
    readTimezoneSetting({ repositories: input.repositories })?.timezone ??
    input.config.AWM_TIMEZONE;
  const now = input.clock.now();
  const data = readUsagePageData({
    repositories: input.repositories,
    now,
    timezone,
    ...(requestedProvider ? { providerId: requestedProvider } : {}),
    ...(requestedWindow && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(requestedWindow)
      ? { windowKind: requestedWindow }
      : {}),
    ...(typeof query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.day)
      ? { localDay: query.day }
      : {}),
    visibleProviderIds: new Set(providers.map((provider) => provider.id)),
    providers: providers.map((provider) => ({
      id: provider.id,
      label: providerDisplayName(provider.id),
    })),
  });

  const series: HistoryUsageSample[] = [];
  const providerId = data.selectedProviderId;
  if (providerId) {
    const rangeStartMs = now.getTime() - getHistoryRange('30d').durationMs;
    const provider = providers.find((item) => item.id === providerId);
    const maxGapMs = (provider?.pollIntervalSeconds ?? 300) * 2_000;
    for (const windowKind of input.repositories.windowSamples
      .listWindowKinds(providerId, rangeStartMs, now.getTime() + 1)
      .slice(0, 16)) {
      const range =
        chartRanges[chartRangeKey(providerId, windowKind)] ?? normalizeHistoryRange(undefined);
      const fromMs = now.getTime() - getHistoryRange(range).durationMs;
      const points = input.repositories.windowSamples.chartPoints(
        providerId,
        windowKind,
        fromMs,
        now.getTime() + 1,
        USAGE_CHART_BUCKETS,
        maxGapMs,
      );
      for (const point of points) {
        series.push({
          providerId,
          windowKind,
          observedAt: new Date(point.observedAtMs).toISOString(),
          usageRatio: point.usageRatio,
          remainingRatio: point.remainingRatio,
          ...(point.gapBefore ? { gapBefore: true } : {}),
        });
      }
    }
  }
  const chartSeries = buildUsageSeries(series, now, {
    range: normalizeHistoryRange(undefined),
    ...(providerId ? { providerId } : {}),
    chartRanges,
  });
  return { data, series: chartSeries, chartRanges };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeEventType(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null;
}

function queryStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function renderOverview(providers: ProviderRead[], now: Date, timezone: string): string {
  const cards = providers.map((provider) => renderProviderCard(provider, now, timezone)).join('');
  return renderAppShell({
    page: 'overview',
    title: 'Overview',
    description: 'Your usage windows, remaining allowance, and selected start policies.',
    content:
      cards ||
      '<section class="empty-state"><h2>No providers are set up</h2><p>Ask your administrator to connect a provider before usage appears here.</p></section>',
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
    data: event.data,
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

function renderProviderCard(provider: ProviderRead, now: Date, timezone: string): string {
  const staleClass = provider.freshness.stale ? ' stale' : '';
  const freshnessLabel =
    provider.freshness.ageSeconds === null
      ? provider.enabled
        ? 'Waiting for the first update'
        : 'Monitoring is paused'
      : `Last checked ${formatAge(provider.freshness.ageSeconds)} ago`;
  const windows =
    provider.windows.length > 0
      ? `<div class="window-grid">${provider.windows.map((window) => renderWindow(provider.id, window, now, timezone)).join('')}</div>`
      : '<div class="empty-state"><h3>Usage will appear here</h3><p>The first provider update has not arrived yet.</p></div>';

  const displayName = providerDisplayName(provider.id, provider.kind);
  const connectionState = !provider.enabled
    ? 'Monitoring paused'
    : provider.health === 'AUTH_REQUIRED'
      ? 'Sign-in required'
      : healthLabel(provider.health);
  const isConnected = provider.enabled && provider.health === 'UP';
  const automationState = !provider.enabled
    ? 'Automatic starts paused'
    : provider.activationPolicyNeedsAttention
      ? 'Schedule needs attention'
      : !provider.activationPolicy
        ? 'No start policy set'
        : !provider.activationPolicy.enabled
          ? 'Schedule paused'
          : provider.activationPolicy.kind === 'manual'
            ? 'Manual starts only'
            : provider.mode !== 'automation'
              ? 'Automatic starts off'
              : provider.capabilities?.windowTrigger.supported === true
                ? 'Automatic starts enabled'
                : 'Automatic starts unavailable';
  const logoUrl = providerLogoUrl(provider.id, provider.kind);
  const logoHtml = logoUrl
    ? `<img class="provider-logo" src="${logoUrl}" alt="" width="34" height="34">`
    : '';
  const staleMessage =
    provider.freshness.stale && provider.freshness.observedAt
      ? '<p class="stale-notice">This information may be out of date. Automatic starts wait for a fresh update.</p>'
      : '';
  const signInMessage =
    provider.health === 'AUTH_REQUIRED'
      ? '<p class="notice">Sign in with the official provider app, then return here to check again.</p>'
      : '';
  const onlineIndicator = isConnected
    ? '<span class="online-indicator" aria-hidden="true"></span>'
    : '';
  const connectionBadgeClass = isConnected ? 'badge-success' : 'badge-warning';
  const selectedPolicy = renderSelectedPolicy(provider);
  const details = `<details class="provider-details"><summary>Connection details</summary><dl><dt>Connection</dt><dd>${escapeHtml(healthLabel(provider.health))}</dd><dt>Last issue</dt><dd>${escapeHtml(errorLabel(provider.lastErrorCode))}</dd></dl></details>`;
  return `<article class="provider${staleClass}"><header class="provider-header"><div class="provider-identity">${logoHtml}<div><h2>${escapeHtml(displayName)}</h2><p class="provider-meta">${escapeHtml(freshnessLabel)}</p></div></div><div class="badges"><span class="badge ${connectionBadgeClass}">${onlineIndicator}${escapeHtml(connectionState)}</span><span class="badge">${escapeHtml(automationState)}</span></div></header>${staleMessage}${signInMessage}${selectedPolicy}${windows}${details}</article>`;
}

function renderSelectedPolicy(provider: ProviderRead): string {
  const scheduleHref = `/schedule?providerId=${encodeURIComponent(provider.id)}`;
  if (provider.activationPolicyNeedsAttention) {
    return `<section class="provider-policy" aria-label="Selected start policy"><div><span class="field-label">Selected start policy</span><strong>Saved policy needs attention</strong><p class="provider-meta">Review the schedule before relying on automatic starts.</p></div><a href="${escapeHtml(scheduleHref)}">Review schedule</a></section>`;
  }

  const policy = provider.activationPolicy;
  if (!policy) {
    return `<section class="provider-policy" aria-label="Selected start policy"><div><span class="field-label">Selected start policy</span><strong>No start policy selected</strong><p class="provider-meta">Choose how and when a new window should start.</p></div><a href="${escapeHtml(scheduleHref)}">Choose policy</a></section>`;
  }

  const labels: Record<ActivationPolicy['kind'], string> = {
    manual: 'Only when I ask',
    auto: 'Whenever possible',
    fixed: 'On a repeating cycle',
    custom_schedule: 'At specific times',
    active_hours: 'Within active hours',
  };
  const description = selectedPolicyDescription(provider.id, policy);
  const status = selectedPolicyStatus(provider, policy);
  return `<section class="provider-policy" aria-label="Selected start policy"><div><span class="field-label">Selected start policy</span><strong>${escapeHtml(labels[policy.kind])}</strong><p class="provider-meta">${escapeHtml(description)}</p><p class="provider-policy-status">${escapeHtml(status)}</p></div><a href="${escapeHtml(scheduleHref)}">Change</a></section>`;
}

function selectedPolicyDescription(providerId: string, policy: ActivationPolicy): string {
  if (policy.kind === 'manual') return 'New windows start only when you ask.';
  const window = policy.windowKind
    ? windowDisplayName(providerId, policy.windowKind)
    : 'Any available usage window';
  if (policy.kind === 'auto') {
    return `${window} · Starts after a fresh check confirms availability.`;
  }
  const timezone =
    policy.timezone === 'UTC' ? 'UTC' : `${timeZoneDisplayName(policy.timezone)} local time`;
  if (policy.kind === 'fixed') {
    return `${window} · Cycle start at ${formatPolicyTime(policy.anchorLocalTime)} · ${timezone}.`;
  }
  if (policy.kind === 'custom_schedule') {
    const times = summarizePolicyItems(policy.times.map(formatPolicyTime));
    return `${window} · Daily at ${times} · ${timezone}.`;
  }
  const periods = summarizePolicyItems(
    policy.periods.map(({ start, end }) => `${formatPolicyTime(start)}–${formatPolicyTime(end)}`),
  );
  return `${window} · Daily during ${periods} · ${timezone}.`;
}

function selectedPolicyStatus(provider: ProviderRead, policy: ActivationPolicy): string {
  if (!policy.enabled) return 'Paused · this policy will not plan new starts.';
  if (!provider.enabled) return 'Monitoring is paused for this provider.';
  if (policy.kind === 'manual') return 'Automatic starts are off; you start windows yourself.';
  if (provider.mode !== 'automation')
    return 'Saved, but automatic starts are off in provider settings.';
  if (provider.capabilities?.windowTrigger.supported !== true) {
    return 'Unavailable because this provider does not support automatic starts.';
  }
  return 'Active · each start still requires a fresh provider check.';
}

function formatPolicyTime(value: string): string {
  const [hours = 0, minutes = 0] = value.split(':').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(Date.UTC(2020, 0, 1, hours, minutes)));
}

function summarizePolicyItems(items: readonly string[]): string {
  const visible = items.slice(0, 3);
  const summary = visible.join(', ');
  return items.length > visible.length
    ? `${summary} and ${items.length - visible.length} more`
    : summary;
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

function formatLocalInstant(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: timezone || 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return formatUtc(value);
  }
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return 'less than a minute';
  if (ageSeconds < 3_600) return `${Math.floor(ageSeconds / 60)} min`;
  if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3_600)} hr`;
  return `${Math.floor(ageSeconds / 86_400)} days`;
}

function renderWindow(
  providerId: string,
  window: WindowSnapshot,
  now: Date,
  timezone: string,
): string {
  const usage = window.usageRatio;
  const label = windowDisplayName(providerId, window.windowKind, window.durationSeconds?.value);
  const percentUsed = usage ? Math.round(usage.value * 100) : null;
  const remaining = window.remainingRatio?.value ?? (usage ? 1 - usage.value : null);
  const remainingIsEstimated =
    !window.remainingRatio || isEstimatedSource(window.remainingRatio.source);
  const usageMarkup =
    usage && percentUsed !== null
      ? `<div class="quota-values"><strong>${percentUsed}%</strong><span>used</span><strong>${remaining === null ? '—' : `${remainingIsEstimated ? 'About ' : ''}${Math.round(remaining * 100)}%`}</strong><span>left</span></div><progress class="quota-progress" max="100" value="${percentUsed}" aria-label="${percentUsed}% of ${escapeHtml(label)} used">${percentUsed}%</progress>`
      : '<p class="muted">Usage has not been reported yet.</p>';
  const phase = windowPhaseLabel(window);
  const reset = window.resetAt
    ? `<div class="window-reset"><span class="field-label">Resets</span><strong>${isEstimatedSource(window.resetAt.source) ? 'About ' : ''}${escapeHtml(formatLocalInstant(window.resetAt.value, timezone))}</strong><span class="reset-relative">${escapeHtml(approximateResetText(window.resetAt, now))}</span><small>${escapeHtml(timeZoneDisplayName(timezone))} · local</small><small>${escapeHtml(formatUtc(window.resetAt.value))}</small></div>`
    : `<div class="window-reset"><span class="field-label">Reset time</span><strong class="unknown">Not available yet</strong></div>`;
  return `<section class="window-card"><div class="window-header"><h3>${escapeHtml(label)}</h3>${phase ? `<span class="badge">${escapeHtml(phase)}</span>` : ''}</div>${usageMarkup}${reset}</section>`;
}

function windowPhaseLabel(window: WindowSnapshot): string | null {
  if (
    window.phase.value !== 'UNKNOWN' &&
    (window.phase.source === 'inferred' ||
      ['medium', 'low', 'unknown'].includes(window.phase.confidence))
  ) {
    return null;
  }

  const labels: Record<WindowSnapshot['phase']['value'], string> = {
    ACTIVE: 'In use',
    INACTIVE: 'Available',
    EXHAUSTED: 'Limit reached',
    RESET_DUE: 'Ready to reset',
    UNKNOWN: 'Status not available',
  };
  return labels[window.phase.value];
}

function approximateResetText(fact: NonNullable<WindowSnapshot['resetAt']>, now: Date): string {
  const resetAtMs = Date.parse(fact.value);
  if (!Number.isFinite(resetAtMs)) return 'Reset time unavailable';

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
  return relative.startsWith('in ') ? `In about ${relative.slice(3)}` : `About ${relative}`;
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
