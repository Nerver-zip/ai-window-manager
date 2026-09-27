import { promises as fs } from 'node:fs';
import path from 'node:path';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { renderAppShell } from './ui/layout.js';
import { renderProviderPicker } from './ui/provider-picker.js';
import { APP_CSS } from './ui/styles.js';
import { APP_JS } from './ui/chart-interactions.js';
import { AUTH_ONBOARDING_CSS } from './ui/auth-onboarding-styles.js';
import { AUTH_ONBOARDING_JS } from './ui/auth-onboarding-interactions.js';
import { PROGRESSIVE_INTERACTIONS_JS } from './ui/progressive-interactions.js';
import { OPERATOR_AUTH_CSS } from './ui/operator-auth-styles.js';
import { renderOperatorLoginPage, renderOperatorLogoutPage } from './ui/operator-auth.js';
import {
  AuthSessionError,
  type AuthProviderId,
  type AuthSessionManager,
  type AuthSessionSnapshot,
} from '../auth/session-manager.js';
import { OPERATOR_SESSION_COOKIE_NAME, type OperatorAuthService } from '../auth/operator-auth.js';
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
import { PROVIDER_CLIENT_IDS, type ProviderClientId } from '../provider-clients/runtime-store.js';
import type { ProviderClientUpdateWebControls } from '../provider-clients/web-controls.js';
import type { Clock } from '../scheduler/clock.js';
import { activationPolicyFromRecord, parseActivationPolicy } from '../scheduler/policy.js';
import {
  activationPolicyId,
  activationPolicyScopes,
  policyScopeForWindowKind,
  type ActivationPolicyScope,
  windowKindBelongsToPolicyScope,
} from '../scheduler/policy-scope.js';
import { deriveCurrentWindowForTarget } from '../scheduler/current-window.js';
import { resolveWindowTarget } from '../domain/window-target.js';
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
import { readUsagePageData, USAGE_CHART_BUCKETS } from '../usage/service.js';
import { chartContinuityGapMs } from '../usage/chart-continuity.js';
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
  createCsrfToken,
  ensureCsrfToken,
  getSecurityHeaders,
  readCookie,
  serializeCsrfCookie,
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
  windowGroupDisplayName,
  windowDisplayName,
} from './ui/presentation.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    awmRateLimit?: { maxRequests: number; timeWindowMs: number };
  }
}

const ASSETS_DIR = path.resolve(process.cwd(), 'assets');
const STATIC_IMAGE_ASSETS = [
  ['logo.png', 'logo.png'],
  ['providers/agy.png', 'providers/agy.png'],
  ['providers/antigravity.png', 'providers/antigravity.png'],
  ['providers/codex.png', 'providers/codex.png'],
] as const;
const DEFAULT_REQUEST_RATE_LIMIT = 300;
const REQUEST_RATE_LIMIT_WINDOW_MS = 60_000;
const REQUEST_RATE_LIMIT_CACHE_SIZE = 5_000;
const PROVIDER_AUTH_OPERATION_RATE_LIMIT = 12;
const PROVIDER_AUTH_OPERATION_RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const PROVIDER_CLIENT_OPERATION_RATE_LIMIT = 6;
const AUTH_PROVIDER_IDS: readonly AuthProviderId[] = ['codex', 'antigravity'];
const APP_CSS_WITH_AUTH = `${APP_CSS}\n${AUTH_ONBOARDING_CSS}\n${OPERATOR_AUTH_CSS}`;
const APP_JS_WITH_ENHANCEMENTS = `${APP_JS}\n${AUTH_ONBOARDING_JS}\n${PROGRESSIVE_INTERACTIONS_JS}`;

export interface BuildServerInput {
  config: AppConfig;
  db: SqliteDatabase;
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  clock: Clock;
  authSessions?: AuthSessionManager;
  operatorAuth: OperatorAuthService;
  requestReconcile?: () => void;
  providerClientUpdates?: ProviderClientUpdateWebControls;
  /** Test-only override for exercising rate-limit boundaries without waiting a minute. */
  requestRateLimitForTests?: { maxRequests: number; timeWindowMs: number };
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
  activationPolicies?: ProviderPolicyRead[];
  capabilities?: ProviderCapabilities;
  triggerModels?: { gemini: string; claudeGpt: string };
}

interface ProviderPolicyRead {
  scope: ActivationPolicyScope;
  policy: ActivationPolicy | null;
  needsAttention: boolean;
}

interface OverviewAuthConnection {
  connected: boolean;
  inProgress: boolean;
}

export function buildServer(input: BuildServerInput) {
  const app = Fastify({
    logger: { level: input.config.AWM_LOG_LEVEL },
    bodyLimit: DEFAULT_HTTP_BODY_LIMIT_BYTES,
    trustProxy: input.config.AWM_TRUST_PROXY.length ? input.config.AWM_TRUST_PROXY : false,
  });
  let staticImageAssets: ReadonlyMap<string, Buffer> = new Map();

  // IP identity follows Fastify's configured trustProxy list; forwarded headers
  // are not used unless their exact proxy source was explicitly configured.
  app.register(rateLimit, {
    // The app is assembled synchronously, so enforcement uses the plugin's
    // decorated limiter from one root onRequest hook after Fastify is ready.
    // Route-specific policies are selected from the private config below.
    global: false,
    max: DEFAULT_REQUEST_RATE_LIMIT,
    timeWindow: REQUEST_RATE_LIMIT_WINDOW_MS,
    cache: REQUEST_RATE_LIMIT_CACHE_SIZE,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
    }),
  });

  const rateLimitHandlers = new Map<string, ReturnType<typeof app.rateLimit>>();
  app.addHook('onRequest', async (request, reply) => {
    const policy = request.routeOptions.config.awmRateLimit ?? {
      maxRequests: input.requestRateLimitForTests?.maxRequests ?? DEFAULT_REQUEST_RATE_LIMIT,
      timeWindowMs: input.requestRateLimitForTests?.timeWindowMs ?? REQUEST_RATE_LIMIT_WINDOW_MS,
    };
    const key = `${policy.maxRequests}:${policy.timeWindowMs}`;
    let handler = rateLimitHandlers.get(key);
    if (!handler) {
      handler = app.rateLimit({ max: policy.maxRequests, timeWindow: policy.timeWindowMs });
      rateLimitHandlers.set(key, handler);
    }
    await handler.call(app, request, reply);
  });

  app.addHook('onReady', async () => {
    staticImageAssets = await readStaticImageAssets();
  });

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicRequest(request.method, request.url)) return;
    const sessionToken = readCookie(request.headers.cookie, OPERATOR_SESSION_COOKIE_NAME);
    if (input.operatorAuth.sessions.has(sessionToken)) return;

    const routePath = request.url.split('?', 1)[0] ?? '/';
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      !routePath.startsWith('/api/') &&
      routePath !== '/metrics'
    ) {
      const next = safeInternalPath(request.raw.url);
      const reason = sessionToken ? 'session_expired' : undefined;
      return reply.code(303).redirect(loginHref(next, reason));
    }

    return reply.code(401).send({
      error: { code: 'AUTH_REQUIRED', message: 'authentication required' },
    });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const routePath = request.url.split('?', 1)[0] ?? '/';
    const headers = getSecurityHeaders({ noStore: !isStaticPath(routePath) });
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
    reply.type('application/javascript; charset=utf-8').send(APP_JS_WITH_ENHANCEMENTS),
  );
  app.get('/assets/images/*', async (request, reply) => {
    const rawPath = (request.params as { '*': string })['*'];
    const buffer = staticImageAssets.get(rawPath);
    if (!buffer) return reply.code(404).send({ error: 'not found' });
    reply.header('Cache-Control', 'public, max-age=86400, immutable');
    return reply.type('image/png').send(buffer);
  });
  app.get('/favicon.ico', async (_request, reply) => {
    const buffer = staticImageAssets.get('logo.png');
    if (!buffer) return reply.code(404).send({ error: 'not found' });
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

  app.get('/login', async (request, reply) => {
    const query = asRecord(request.query);
    const next = safeInternalPath(stringValue(query.next));
    const sessionToken = readCookie(request.headers.cookie, OPERATOR_SESSION_COOKIE_NAME);
    if (input.operatorAuth.sessions.has(sessionToken)) return reply.code(303).redirect(next);
    const csrf = ensureCsrfToken(request.headers.cookie, { secure: isSecureRequest(request) });
    if (csrf.setCookie) reply.header('Set-Cookie', csrf.setCookie);
    reply.type('text/html; charset=utf-8');
    const error = loginPageError(stringValue(query.reason));
    return renderOperatorLoginPage({ csrfToken: csrf.token, next, ...(error ? { error } : {}) });
  });

  app.post('/login', async (request, reply) => {
    const body = asRecord(request.body);
    const next = safeInternalPath(stringValue(body.next));
    const previousToken = readCookie(request.headers.cookie, OPERATOR_SESSION_COOKIE_NAME);
    if (previousToken) input.operatorAuth.sessions.destroy(previousToken);
    const result = await input.operatorAuth.login(body.username, body.password, request.ip);
    if (result.status === 'authenticated') {
      const csrfToken = createCsrfToken();
      const secure = isSecureRequest(request);
      reply.header('Set-Cookie', [
        serializeOperatorSessionCookie(
          result.session.token,
          input.config.AWM_AUTH_SESSION_TTL_SECONDS,
          secure,
        ),
        serializeCsrfCookie(csrfToken, { secure }),
      ]);
      return reply.code(303).redirect(next);
    }

    const throttled = result.status === 'too_many_attempts';
    if (throttled) reply.header('Retry-After', String(result.retryAfterSeconds));
    reply.code(throttled ? 429 : 401);
    reply.type('text/html; charset=utf-8');
    const csrf = ensureCsrfToken(request.headers.cookie, { secure: isSecureRequest(request) });
    if (csrf.setCookie) reply.header('Set-Cookie', csrf.setCookie);
    return renderOperatorLoginPage({
      csrfToken: csrf.token,
      next,
      error: throttled ? 'too_many_attempts' : 'invalid_credentials',
    });
  });

  app.get('/logout', async (request, reply) => {
    const csrf = ensureCsrfToken(request.headers.cookie, { secure: isSecureRequest(request) });
    if (csrf.setCookie) reply.header('Set-Cookie', csrf.setCookie);
    reply.type('text/html; charset=utf-8');
    return renderOperatorLogoutPage({ csrfToken: csrf.token });
  });

  app.post('/logout', async (request, reply) => {
    const sessionToken = readCookie(request.headers.cookie, OPERATOR_SESSION_COOKIE_NAME);
    if (sessionToken) input.operatorAuth.sessions.destroy(sessionToken);
    const secure = isSecureRequest(request) ? '; Secure' : '';
    reply.header('Set-Cookie', [
      `${OPERATOR_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
      `awm_csrf=; Path=/; SameSite=Strict; Max-Age=0${secure}`,
    ]);
    return reply.code(303).redirect('/login');
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

  app.post(
    '/api/v1/providers/:id/auth/start',
    {
      config: {
        awmRateLimit: {
          maxRequests: PROVIDER_AUTH_OPERATION_RATE_LIMIT,
          timeWindowMs: PROVIDER_AUTH_OPERATION_RATE_LIMIT_WINDOW_MS,
        },
      },
    },
    async (request, reply) => {
      const providerId = configuredAuthProviderId(input, (request.params as { id?: unknown }).id);
      if (!providerId) return reply.code(404).send({ error: { code: 'PROVIDER_NOT_FOUND' } });
      if (input.providerClientUpdates?.isRuntimeChanging(providerId)) {
        return reply.code(409).send({
          error: {
            code: 'PROVIDER_CLIENT_UPDATE_IN_PROGRESS',
            message: 'Wait for the provider app update to finish before signing in.',
          },
        });
      }
      try {
        return reply.code(202).send(input.authSessions!.start(providerId));
      } catch (error) {
        const failure = authSessionFailure(error);
        return reply.code(failure.statusCode).send({ error: failure.error });
      }
    },
  );

  app.post(
    '/api/v1/providers/:id/auth/submit',
    {
      config: {
        awmRateLimit: {
          maxRequests: PROVIDER_AUTH_OPERATION_RATE_LIMIT,
          timeWindowMs: PROVIDER_AUTH_OPERATION_RATE_LIMIT_WINDOW_MS,
        },
      },
    },
    async (request, reply) => {
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
    },
  );

  app.post(
    '/api/v1/providers/:id/auth/cancel',
    {
      config: {
        awmRateLimit: {
          maxRequests: PROVIDER_AUTH_OPERATION_RATE_LIMIT,
          timeWindowMs: PROVIDER_AUTH_OPERATION_RATE_LIMIT_WINDOW_MS,
        },
      },
    },
    async (request, reply) => {
      const providerId = configuredAuthProviderId(input, (request.params as { id?: unknown }).id);
      if (!providerId) return reply.code(404).send({ error: { code: 'PROVIDER_NOT_FOUND' } });
      return reply.code(200).send(input.authSessions!.cancel(providerId));
    },
  );

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
  app.get('/api/v1/provider-clients', async (_request, reply) => {
    const controls = input.providerClientUpdates;
    if (!controls) return reply.code(503).send({ error: 'PROVIDER_CLIENT_UPDATES_UNAVAILABLE' });
    return {
      providerClients: PROVIDER_CLIENT_IDS.map((providerId) => ({
        ...controls.getStatus(providerId),
        autoUpdate: controls.autoUpdateEnabled(providerId),
      })),
    };
  });
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

  app.post(
    '/api/v1/provider-clients/:id/:operation',
    {
      config: {
        awmRateLimit: {
          maxRequests: PROVIDER_CLIENT_OPERATION_RATE_LIMIT,
          timeWindowMs: REQUEST_RATE_LIMIT_WINDOW_MS,
        },
      },
    },
    async (request, reply) => {
      const controls = input.providerClientUpdates;
      if (!controls) return reply.code(503).send({ error: 'PROVIDER_CLIENT_UPDATES_UNAVAILABLE' });
      const providerId = parseProviderClientId((request.params as { id?: unknown }).id);
      if (!providerId) return reply.code(404).send({ error: 'PROVIDER_CLIENT_NOT_FOUND' });
      const operation = stringValue((request.params as { operation?: unknown }).operation);
      if (operation !== 'check' && operation !== 'update' && operation !== 'rollback') {
        return reply.code(404).send({ error: 'PROVIDER_CLIENT_OPERATION_NOT_FOUND' });
      }
      const accepted = startProviderClientOperation(controls, providerId, operation);
      return accepted
        ? reply.code(202).send({ accepted: true, providerId, operation })
        : reply.code(409).send({
            accepted: false,
            error: { code: 'PROVIDER_CLIENT_OPERATION_RUNNING' },
          });
    },
  );

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
        label: providerDisplayName(provider.id, provider.kind),
        kind: provider.kind,
        ...providerConnectionPresentation(input.repositories.providerState.get(provider.id)),
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
      secure: isSecureRequest(request),
    });
    if (csrf.setCookie) reply.header('Set-Cookie', csrf.setCookie);
    reply.type('text/html; charset=utf-8');
    const notice = queryMessage(request.query);
    const timezone = readTimezoneSetting(settingsInput);
    const providers = settingsProviderViews(input);
    const authProviders = configuredAuthProviders(input);
    const requestedConnectId = stringValue(asRecord(request.query).connect);
    const connectProviderId =
      requestedConnectId &&
      providers.some((provider) => provider.id === requestedConnectId) &&
      authProviders.some((provider) => provider.providerId === requestedConnectId)
        ? requestedConnectId
        : undefined;
    return renderSettingsUiPage({
      csrfToken: csrf.token,
      providers,
      authProviders,
      ...(connectProviderId ? { connectProviderId } : {}),
      referenceInstant: input.clock.now(),
      ...(timezone ? { timezone } : {}),
      ...(notice ? { notice } : {}),
    });
  });

  app.get('/schedule', async (request, reply) => {
    const csrf = ensureCsrfToken(request.headers.cookie, {
      secure: isSecureRequest(request),
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
    const requestedScope = stringValue(asRecord(request.query).scope);
    const selected =
      (requestedProviderId
        ? scheduling.providers.find((provider) => provider.providerId === requestedProviderId)
        : undefined) ??
      scheduling.providers.find(
        (provider) => provider.policy?.providerId === provider.providerId,
      ) ??
      scheduling.providers[0];
    const selectedScope: ActivationPolicyScope = selected?.policyScopes
      ? requestedScope === 'claude_gpt'
        ? 'claude_gpt'
        : 'gemini'
      : 'default';
    const selectedPolicyScope = selected?.policyScopes?.find(
      (scope) => scope.scope === selectedScope,
    );
    const scheduleRead = selectedPolicyScope ?? selected;
    return renderActivationSchedulePage({
      csrfToken: csrf.token,
      providers: settingsProviderViews(input),
      ...(selected ? { selectedProviderId: selected.providerId } : {}),
      ...(scheduleRead?.policy ? { policy: scheduleRead.policy } : {}),
      ...(selected ? { policyScope: selectedScope } : {}),
      ...(selectedPolicyScope?.requiresReview ? { policyNeedsReview: true } : {}),
      ...(scheduling.timezone ? { timezone: scheduling.timezone } : {}),
      ...(scheduleRead?.currentWindow ? { currentWindow: scheduleRead.currentWindow } : {}),
      ...(scheduleRead?.decision ? { decision: scheduleRead.decision } : {}),
      ...(scheduleRead?.upcoming ? { upcoming: scheduleRead.upcoming } : {}),
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
    const providerRecord = input.repositories.providers.get(parsed.data.providerId);
    const parsedWindowKind = 'windowKind' in parsed.data ? parsed.data.windowKind : undefined;
    const scope: ActivationPolicyScope =
      providerRecord?.kind === 'antigravity'
        ? parsed.data.scope === 'claude_gpt'
          ? 'claude_gpt'
          : parsed.data.scope === 'gemini'
            ? 'gemini'
            : ((parsedWindowKind ? policyScopeForWindowKind(parsedWindowKind) : undefined) ??
              'gemini')
        : 'default';
    if (
      providerRecord?.kind === 'antigravity' &&
      parsedWindowKind &&
      policyScopeForWindowKind(parsedWindowKind) !== scope
    ) {
      return reply.send(
        '<p class="horizon-empty" role="status">Choose a usage window from the selected quota family.</p>',
      );
    }
    const policyId = activationPolicyId(parsed.data.providerId, scope);
    const savedTimezone = readTimezoneSetting(settingsInput)?.timezone;
    const existingPolicy = input.repositories.schedulePolicies
      .list(parsed.data.providerId)
      .find((candidate) => candidate.id === policyId);
    const timezone = parsed.data.timezone ?? savedTimezone ?? existingPolicy?.timezone;
    if (!timezone) {
      return reply.send(
        '<p class="horizon-empty" role="status">Choose a time zone in Settings to see local schedule times.</p>',
      );
    }
    let policy: ActivationPolicy;
    try {
      policy = parseActivationPolicy({
        ...parsed.data,
        id: policyId,
        providerId: parsed.data.providerId,
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
    const requestedWindowKind = 'windowKind' in policy ? policy.windowKind : undefined;
    const target = resolveWindowTarget(requestedWindowKind, state?.observation?.windows ?? []);
    const windowKind =
      target.status === 'exact' || target.status === 'legacy_resolved'
        ? target.windowKind
        : undefined;
    if (windowKind && 'windowKind' in policy) policy = { ...policy, windowKind };
    const currentWindow = deriveCurrentWindowForTarget(
      policy.providerId,
      state?.observation,
      state?.health,
      windowKind,
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

  app.post('/settings/provider-clients/:id/:operation', async (request, reply) => {
    const controls = input.providerClientUpdates;
    if (!controls)
      return reply.code(503).type('text/plain').send('Provider app updates unavailable');
    const providerId = parseProviderClientId((request.params as { id?: unknown }).id);
    if (!providerId) return reply.code(404).type('text/plain').send('Provider app not found');
    const operation = stringValue((request.params as { operation?: unknown }).operation);
    if (operation === 'auto-update') {
      const enabled = formBoolean(asRecord(request.body).autoUpdate);
      controls.setAutoUpdateEnabled(providerId, enabled);
      return reply.code(303).redirect('/settings?updated=provider-client-preference');
    }
    if (operation !== 'check' && operation !== 'update' && operation !== 'rollback') {
      return reply.code(404).type('text/plain').send('Provider app operation not found');
    }
    if (!startProviderClientOperation(controls, providerId, operation)) {
      return reply.code(303).redirect('/settings?updated=provider-client-running');
    }
    return reply.code(303).redirect(`/settings?updated=provider-client-${operation}`);
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
    const scope = stringValue(asRecord(normalized).scope);
    const scopeQuery = scope && scope !== 'default' ? `&scope=${encodeURIComponent(scope)}` : '';
    return reply.code(303).redirect(`/schedule?updated=schedule${providerQuery}${scopeQuery}`);
  });

  app.post('/providers/:id/trigger', async (request, reply) => {
    const providerId = (request.params as { id?: unknown }).id;
    const body = asRecord(request.body);
    const command = {
      ...(typeof body.windowKind === 'string' ? { windowKind: body.windowKind } : {}),
      ...(typeof body.idempotencyKey === 'string' ? { idempotencyKey: body.idempotencyKey } : {}),
    };
    const result = commandApi.trigger(providerId, command);
    const query = new URLSearchParams();
    if (typeof providerId === 'string') query.set('provider', providerId);
    query.set('updated', result.statusCode === 202 ? 'start-requested' : 'start-unavailable');
    return reply.code(303).redirect(`/?${query.toString()}`);
  });

  app.post('/api/v1/providers/:id/inspect', async (request, reply) => {
    const result = commandApi.inspect((request.params as { id?: unknown }).id);
    return reply.code(result.statusCode).send(result.body);
  });

  app.post('/api/v1/providers/:id/trigger', async (request, reply) => {
    const result = commandApi.trigger((request.params as { id?: unknown }).id, request.body);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get('/', async (request, reply) => {
    const providers = readProviders(input);
    reply.type('text/html; charset=utf-8');
    const csrf = ensureCsrfToken(request.headers.cookie, {
      secure: isSecureRequest(request),
    });
    if (csrf.setCookie) reply.header('Set-Cookie', csrf.setCookie);
    const timezone =
      readTimezoneSetting({ repositories: input.repositories })?.timezone ??
      input.config.AWM_TIMEZONE;
    const requestedProviderId = stringValue(asRecord(request.query).provider) ?? undefined;
    const selectedProviderId = providers.some((provider) => provider.id === requestedProviderId)
      ? requestedProviderId
      : providers[0]?.id;
    const authConnections = new Map(
      configuredAuthProviders(input).map(
        ({ providerId, status }) =>
          [
            providerId,
            {
              connected:
                status.state === 'SUCCEEDED' || status.reasonCode === 'ALREADY_AUTHENTICATED',
              inProgress: ['STARTING', 'AWAITING_USER_ACTION', 'VERIFYING'].includes(status.state),
            },
          ] as const,
      ),
    );
    return renderOverview(
      providers,
      input.clock.now(),
      timezone,
      selectedProviderId,
      csrf.token,
      queryMessage(request.query),
      authConnections,
    );
  });

  return app;
}

async function readStaticImageAssets(): Promise<ReadonlyMap<string, Buffer>> {
  const loaded = await Promise.all(
    STATIC_IMAGE_ASSETS.map(async ([requestPath, filePath]) => {
      const buffer = await fs.readFile(path.join(ASSETS_DIR, 'images', filePath));
      return [requestPath, buffer] as const;
    }),
  );
  return new Map(loaded);
}

function expectedOrigin(
  request: {
    protocol: string;
    headers: Record<string, string | string[] | undefined>;
  },
  fallbackPort: number,
): string {
  const protocol = isSecureRequest(request) ? 'https' : 'http';
  const host =
    typeof request.headers.host === 'string' ? request.headers.host : `127.0.0.1:${fallbackPort}`;
  return `${protocol}://${host}`;
}

function isSecureRequest(request: { protocol: string }): boolean {
  return request.protocol === 'https';
}

function isPublicRequest(method: string, requestUrl: string): boolean {
  const pathname = requestUrl.split('?', 1)[0] ?? '/';
  const readOnlyMethod = method === 'GET' || method === 'HEAD';
  if (readOnlyMethod && (pathname === '/healthz' || pathname === '/favicon.ico')) return true;
  if (readOnlyMethod && pathname.startsWith('/assets/')) return true;
  return pathname === '/login' && (method === 'GET' || method === 'POST');
}

function isStaticPath(pathname: string): boolean {
  return pathname === '/favicon.ico' || pathname.startsWith('/assets/');
}

function safeInternalPath(candidate: unknown): string {
  if (
    typeof candidate !== 'string' ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    containsControlCharacter(candidate)
  ) {
    return '/';
  }
  try {
    const target = new URL(candidate, 'http://awm.invalid');
    if (
      target.origin !== 'http://awm.invalid' ||
      target.hash !== '' ||
      target.pathname === '/login' ||
      target.pathname === '/logout'
    ) {
      return '/';
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return '/';
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function loginHref(next: string, reason?: string): string {
  const query = new URLSearchParams({ next });
  if (reason === 'session_expired') query.set('reason', reason);
  return `/login?${query.toString()}`;
}

function loginPageError(reason: string | null): 'session_expired' | undefined {
  return reason === 'session_expired' ? reason : undefined;
}

function serializeOperatorSessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = [
    `${OPERATOR_SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
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
    ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
  };
  if (typeof record.timezone === 'string' && record.timezone.length > 0) {
    (base as Record<string, unknown>).timezone = record.timezone;
  }
  if (record.policyKind === 'manual' || record.policyKind === 'auto') {
    return {
      ...base,
      ...(typeof record.windowKind === 'string' && record.windowKind.length > 0
        ? { windowKind: record.windowKind }
        : {}),
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

function parseProviderClientId(value: unknown): ProviderClientId | undefined {
  return value === 'codex' || value === 'antigravity' ? value : undefined;
}

function startProviderClientOperation(
  controls: ProviderClientUpdateWebControls,
  providerId: ProviderClientId,
  operation: 'check' | 'update' | 'rollback',
): boolean {
  if (operation === 'check') return controls.startCheck(providerId);
  if (operation === 'update') return controls.startUpdate(providerId);
  return controls.startRollback(providerId);
}

function queryMessage(query: unknown): string | null {
  const value = asRecord(query).updated;
  return value === 'provider'
    ? 'Provider settings saved.'
    : value === 'schedule'
      ? 'Schedule saved.'
      : value === 'timezone'
        ? 'Time zone saved.'
        : value === 'provider-client-preference'
          ? 'Provider app update preference saved.'
          : value === 'provider-client-check'
            ? 'Checking the official stable release. Refresh this page to see the result.'
            : value === 'provider-client-update'
              ? 'Provider app update started. Refresh this page to see progress.'
              : value === 'provider-client-rollback'
                ? 'Restoring the previous provider app version. Refresh this page to see progress.'
                : value === 'provider-client-running'
                  ? 'A provider app operation is already running.'
                  : value === 'start-requested'
                    ? 'Start request queued. A fresh provider check will run before any message is sent.'
                    : value === 'start-unavailable'
                      ? 'Could not request a start. Check the provider connection, settings, and selected usage window.'
                      : null;
}

function settingsProviderViews(input: BuildServerInput): SettingsProviderView[] {
  return filterVisibleProviders(
    input.repositories.providers.list(),
    input.config.AWM_FAKE_PROVIDER_ENABLED,
  ).map((provider) => {
    const adapter = input.adapters.get(provider.id);
    const capabilities = adapter ? safeCapabilities(adapter) : undefined;
    const state = input.repositories.providerState.get(provider.id);
    const connection = providerConnectionPresentation(state);
    const providerClientId = parseProviderClientId(provider.id);
    const providerClientStatus =
      providerClientId && input.providerClientUpdates
        ? input.providerClientUpdates.getStatus(providerClientId)
        : undefined;
    return {
      id: provider.id,
      kind: provider.kind,
      enabled: provider.enabled,
      mode: provider.mode,
      pollIntervalSeconds: provider.pollIntervalSeconds,
      ...(capabilities ? { capabilities } : {}),
      windows: state?.observation?.windows ?? [],
      staleAfterSeconds: state?.observation?.staleAfterSeconds,
      configured: connection.configured,
      connectionLabel: connection.statusLabel,
      ...(providerClientId && providerClientStatus && input.providerClientUpdates
        ? {
            providerClientUpdate: {
              ...providerClientStatus,
              autoUpdate: input.providerClientUpdates.autoUpdateEnabled(providerClientId),
            },
          }
        : {}),
      ...(provider.kind === 'antigravity' && capabilities?.windowTrigger.supported
        ? {
            triggerModels: {
              gemini: input.config.AWM_ANTIGRAVITY_GEMINI_TRIGGER_MODEL,
              claudeGpt: input.config.AWM_ANTIGRAVITY_CLAUDE_GPT_TRIGGER_MODEL,
            },
          }
        : {}),
    };
  });
}

function providerConnectionPresentation(
  state: Pick<ProviderRead, 'health' | 'observation'> | null | undefined,
): {
  configured: boolean;
  statusLabel: string;
} {
  const health = state?.health;
  return {
    configured: health === 'UP' || health === 'DEGRADED' || Boolean(state?.observation),
    statusLabel:
      health === 'UP'
        ? 'Connected'
        : health === 'DEGRADED'
          ? 'Needs attention'
          : health === 'AUTH_REQUIRED'
            ? 'Sign in to connect'
            : state?.observation
              ? 'Check connection'
              : 'Set up in Settings',
  };
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
    const policyRecords = input.repositories.schedulePolicies.list(provider.id);
    const activationPolicies = activationPolicyScopes(provider.kind).map((scope) => {
      const policyRecord = policyRecords.find(
        (candidate) => candidate.id === activationPolicyId(provider.id, scope),
      );
      let policy: ActivationPolicy | null = null;
      let needsAttention = policyRecord?.requiresReview ?? false;
      if (policyRecord) {
        needsAttention ||= (policyRecord.scope ?? 'default') !== scope;
        try {
          policy = activationPolicyFromRecord(policyRecord, timezone) ?? null;
          needsAttention ||= policy === null;
        } catch {
          needsAttention = true;
        }
      }
      const requestedWindowKind = policy && 'windowKind' in policy ? policy.windowKind : undefined;
      const target = resolveWindowTarget(requestedWindowKind, observation?.windows ?? []);
      const selectedWindowKind =
        target.status === 'exact' || target.status === 'legacy_resolved'
          ? target.windowKind
          : undefined;
      if (provider.kind === 'antigravity' && requestedWindowKind) {
        if (!windowKindBelongsToPolicyScope(requestedWindowKind, scope)) {
          needsAttention = true;
        } else if (observation && target.status !== 'exact') {
          needsAttention = true;
        }
      } else if (policy && !requestedWindowKind && (observation?.windows.length ?? 0) > 0) {
        needsAttention = true;
      }
      if (selectedWindowKind && policy && 'windowKind' in policy) {
        policy = { ...policy, windowKind: selectedWindowKind };
      }
      return { scope, policy, needsAttention } satisfies ProviderPolicyRead;
    });
    const activationPolicy = activationPolicies[0]?.policy ?? null;
    const activationPolicyNeedsAttention = activationPolicies.some((item) => item.needsAttention);
    const requestedWindowKind =
      activationPolicy && 'windowKind' in activationPolicy
        ? activationPolicy.windowKind
        : undefined;
    const target = resolveWindowTarget(requestedWindowKind, observation?.windows ?? []);
    const selectedWindowKind =
      target.status === 'exact' || target.status === 'legacy_resolved'
        ? target.windowKind
        : undefined;

    return {
      id: provider.id,
      kind: provider.kind,
      enabled: provider.enabled,
      mode: provider.mode,
      health: state?.health ?? 'UNKNOWN',
      lastErrorCode: state?.lastErrorCode ?? null,
      observation,
      currentWindow: deriveCurrentWindowForTarget(
        provider.id,
        observation,
        state?.health,
        selectedWindowKind,
      ),
      windows: observation?.windows ?? [],
      freshness: freshness(state, nowMs),
      activationPolicy,
      activationPolicyNeedsAttention,
      ...(provider.kind === 'antigravity' ? { activationPolicies } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(provider.kind === 'antigravity' && capabilities?.windowTrigger.supported
        ? {
            triggerModels: {
              gemini: input.config.AWM_ANTIGRAVITY_GEMINI_TRIGGER_MODEL,
              claudeGpt: input.config.AWM_ANTIGRAVITY_CLAUDE_GPT_TRIGGER_MODEL,
            },
          }
        : {}),
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
      label: providerDisplayName(provider.id, provider.kind),
      kind: provider.kind,
      ...providerConnectionPresentation(input.repositories.providerState.get(provider.id)),
    })),
  });

  const series: HistoryUsageSample[] = [];
  const providerId = data.selectedProviderId;
  if (providerId) {
    const rangeStartMs = now.getTime() - getHistoryRange('30d').durationMs;
    const provider = providers.find((item) => item.id === providerId);
    const maxGapMs = chartContinuityGapMs(
      provider?.pollIntervalSeconds ?? 300,
      input.config.AWM_RECONCILE_INTERVAL_SECONDS,
    );
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
          ...(point.smoothingBreakBefore ? { smoothingBreakBefore: true } : {}),
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

function renderOverview(
  providers: ProviderRead[],
  now: Date,
  timezone: string,
  selectedProviderId: string | undefined,
  csrfToken: string,
  notice: string | null,
  authConnections: ReadonlyMap<string, OverviewAuthConnection>,
): string {
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selector =
    providers.length > 1
      ? `<form class="overview-provider-switcher" method="get" action="/" data-awm-enhance="navigation" data-awm-target="overview-workspace" data-provider-picker-auto-submit aria-label="Choose provider">${renderProviderPicker(
          {
            name: 'provider',
            legend: 'Provider',
            options: providers.map((provider) => ({
              value: provider.id,
              label: providerDisplayName(provider.id, provider.kind),
              kind: provider.kind,
              ...providerConnectionPresentation(provider),
            })),
            selectedValue: selectedProviderId ?? null,
          },
        )}<noscript><button type="submit">Show provider</button></noscript></form>`
      : '';
  const card = selectedProvider
    ? renderProviderCard(
        selectedProvider,
        now,
        timezone,
        csrfToken,
        authConnections.get(selectedProvider.id),
      )
    : '';
  const workspace =
    card && selectedProvider
      ? `${selector}<div data-awm-region="overview-provider:${escapeHtml(selectedProvider.id)}">${notice ? `<div class="notice" role="status">${escapeHtml(notice)}</div>` : ''}${card}</div>`
      : '<section class="empty-state"><h2>No providers are set up</h2><p>Ask your administrator to connect a provider before usage appears here.</p></section>';
  return renderAppShell({
    page: 'overview',
    title: 'Overview',
    description: 'Your usage windows, remaining allowance, and selected start policies.',
    content: `<div data-awm-region="overview-workspace">${workspace}</div>`,
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

function renderProviderCard(
  provider: ProviderRead,
  now: Date,
  timezone: string,
  csrfToken: string,
  authConnection?: OverviewAuthConnection,
): string {
  const staleClass = provider.freshness.stale ? ' stale' : '';
  const freshnessLabel =
    provider.freshness.ageSeconds === null
      ? provider.enabled
        ? 'Waiting for the first update'
        : 'Monitoring is paused'
      : `Last checked ${formatAge(provider.freshness.ageSeconds)} ago`;
  const windows = renderProviderWindows(provider, now, timezone, csrfToken);

  const displayName = providerDisplayName(provider.id, provider.kind);
  const connectionState = !provider.enabled
    ? 'Monitoring paused'
    : provider.health === 'AUTH_REQUIRED'
      ? 'Sign-in required'
      : healthLabel(provider.health);
  const isConnected = provider.enabled && provider.health === 'UP';
  const antigravitySchedules = provider.activationPolicies;
  const antigravityHasAnyPolicy = antigravitySchedules?.some(({ policy }) => policy !== null);
  const antigravityHasAutomaticPolicy = antigravitySchedules?.some(
    ({ policy }) => policy?.enabled && policy.kind !== 'manual',
  );
  const antigravityOnlyManual = antigravitySchedules?.every(
    ({ policy }) => !policy?.enabled || policy.kind === 'manual',
  );
  const antigravityHasEnabledPolicy = antigravitySchedules?.some(({ policy }) => policy?.enabled);
  const automationState = !provider.enabled
    ? 'Automatic starts paused'
    : provider.activationPolicyNeedsAttention
      ? 'Schedule needs attention'
      : provider.kind === 'antigravity' && !antigravityHasAnyPolicy
        ? 'No start policy set'
        : provider.kind === 'antigravity' &&
            antigravitySchedules?.every(({ policy }) => !policy?.enabled)
          ? 'Schedules paused'
          : provider.kind === 'antigravity' &&
              provider.mode !== 'automation' &&
              antigravityHasAutomaticPolicy
            ? 'Automatic starts off'
            : provider.kind === 'antigravity' &&
                antigravityHasEnabledPolicy &&
                antigravityOnlyManual
              ? 'Manual starts only'
              : provider.kind === 'antigravity' && antigravityHasAutomaticPolicy
                ? provider.capabilities?.windowTrigger.supported === true
                  ? 'Automatic starts enabled'
                  : 'Automatic starts unavailable'
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
  const onboardingAction =
    authConnection && !authConnection.connected
      ? `<a class="button button-primary provider-onboarding-cta" href="/settings?connect=${encodeURIComponent(provider.id)}#provider-${encodeURIComponent(provider.id)}">${authConnection.inProgress ? 'Continue sign-in' : `Connect ${escapeHtml(displayName)}`}</a>`
      : '';
  const onlineIndicator = isConnected
    ? '<span class="online-indicator" aria-hidden="true"></span>'
    : '';
  const connectionBadgeClass = isConnected ? 'badge-success' : 'badge-warning';
  const selectedPolicy = renderSelectedPolicy(provider);
  const details = `<details class="provider-details"><summary>Connection details</summary><dl><dt>Connection</dt><dd>${escapeHtml(healthLabel(provider.health))}</dd><dt>Last issue</dt><dd>${escapeHtml(errorLabel(provider.lastErrorCode))}</dd></dl></details>`;
  return `<article class="provider${staleClass}"><header class="provider-header"><div class="provider-identity">${logoHtml}<div><h2>${escapeHtml(displayName)}</h2><p class="provider-meta">${escapeHtml(freshnessLabel)}</p></div></div><div class="badges"><span class="badge ${connectionBadgeClass}">${onlineIndicator}${escapeHtml(connectionState)}</span><span class="badge">${escapeHtml(automationState)}</span></div></header>${staleMessage}${onboardingAction}${selectedPolicy}${windows}${details}</article>`;
}

function renderProviderWindows(
  provider: ProviderRead,
  now: Date,
  timezone: string,
  csrfToken: string,
): string {
  if (provider.windows.length === 0) {
    return '<div class="empty-state"><h3>Usage will appear here</h3><p>The first provider update has not arrived yet.</p></div>';
  }

  const renderedWindows = (windows: readonly WindowSnapshot[], headingTag: 'h3' | 'h4' = 'h3') =>
    windows
      .map((window) => renderWindow(provider, window, now, timezone, csrfToken, headingTag))
      .join('');

  const groups = new Map<string | null, WindowSnapshot[]>();
  for (const window of provider.windows) {
    const label = windowGroupDisplayName(window.windowKind);
    const windows = groups.get(label) ?? [];
    windows.push(window);
    groups.set(label, windows);
  }

  if (groups.size === 1 && groups.has(null)) {
    return `<div class="window-grid">${renderedWindows(provider.windows)}</div>`;
  }

  return `<div class="window-families">${Array.from(groups, ([label, windows]) =>
    label
      ? `<section class="window-family" aria-label="${escapeHtml(label)}"><h3>${escapeHtml(label)}</h3><div class="window-grid">${renderedWindows(windows, 'h4')}</div></section>`
      : `<div class="window-grid">${renderedWindows(windows)}</div>`,
  ).join('')}</div>`;
}

function renderSelectedPolicy(provider: ProviderRead): string {
  if (provider.activationPolicies) {
    return `<section class="provider-policy" aria-label="Selected start policies"><div><span class="field-label">Selected start policies</span><div class="provider-policy-families">${provider.activationPolicies
      .map((item) => renderProviderPolicyFamily(provider, item))
      .join('')}</div></div></section>`;
  }
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
  const description = selectedPolicyDescription(provider, policy);
  const status = selectedPolicyStatus(provider, policy);
  const statusMarkup = status ? `<p class="provider-policy-status">${escapeHtml(status)}</p>` : '';
  return `<section class="provider-policy" aria-label="Selected start policy"><div><span class="field-label">Selected start policy</span><strong>${escapeHtml(labels[policy.kind])}</strong><p class="provider-meta">${escapeHtml(description)}</p>${statusMarkup}</div><a href="${escapeHtml(scheduleHref)}">Change</a></section>`;
}

function renderProviderPolicyFamily(provider: ProviderRead, item: ProviderPolicyRead): string {
  const family = item.scope === 'gemini' ? 'Gemini Models' : 'Claude and GPT Models';
  const scheduleHref = `/schedule?providerId=${encodeURIComponent(provider.id)}&scope=${item.scope}`;
  if (item.needsAttention) {
    return `<article class="provider-policy-family"><strong>${family}</strong><p class="provider-policy-status">Schedule needs review before automatic starts can resume.</p><a href="${escapeHtml(scheduleHref)}">Review schedule</a></article>`;
  }
  const policy = item.policy;
  if (!policy) {
    return `<article class="provider-policy-family"><strong>${family}</strong><p class="provider-meta">No start policy selected.</p><a href="${escapeHtml(scheduleHref)}">Choose policy</a></article>`;
  }
  const labels: Record<ActivationPolicy['kind'], string> = {
    manual: 'Only when I ask',
    auto: 'Whenever possible',
    fixed: 'On a repeating cycle',
    custom_schedule: 'At specific times',
    active_hours: 'Within active hours',
  };
  const status = selectedPolicyStatus(provider, policy);
  return `<article class="provider-policy-family"><strong>${escapeHtml(family)} · ${escapeHtml(labels[policy.kind])}</strong><p class="provider-meta">${escapeHtml(selectedPolicyDescription(provider, policy))}</p>${status ? `<p class="provider-policy-status">${escapeHtml(status)}</p>` : ''}<a href="${escapeHtml(scheduleHref)}">Change</a></article>`;
}

function selectedPolicyDescription(provider: ProviderRead, policy: ActivationPolicy): string {
  const selectedWindow = policy.windowKind
    ? provider.observation?.windows.find((window) => window.windowKind === policy.windowKind)
    : undefined;
  const cadence = policy.windowKind
    ? windowDisplayName(provider.id, policy.windowKind, selectedWindow?.durationSeconds?.value)
    : undefined;
  const group = policy.windowKind ? windowGroupDisplayName(policy.windowKind) : null;
  const managedWindow = cadence ? (group ? `${group} · ${cadence}` : cadence) : undefined;
  if (policy.kind === 'manual') {
    return managedWindow
      ? `New windows start only when you ask · ${managedWindow}.`
      : 'New windows start only when you ask.';
  }
  const window = managedWindow ?? 'Any available usage window';
  if (policy.kind === 'auto') {
    return window;
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

function selectedPolicyStatus(provider: ProviderRead, policy: ActivationPolicy): string | null {
  if (!policy.enabled) return 'Paused · this policy will not plan new starts.';
  if (!provider.enabled) return 'Monitoring is paused for this provider.';
  if (policy.kind === 'manual') return 'Automatic starts are off; you start windows yourself.';
  if (provider.mode !== 'automation')
    return 'Saved, but automatic starts are off in provider settings.';
  if (provider.capabilities?.windowTrigger.supported !== true) {
    return 'Unavailable because this provider does not support automatic starts.';
  }
  return null;
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
  provider: ProviderRead,
  window: WindowSnapshot,
  now: Date,
  timezone: string,
  csrfToken: string,
  headingTag: 'h3' | 'h4' = 'h3',
): string {
  const usage = window.usageRatio;
  const label = windowDisplayName(provider.id, window.windowKind, window.durationSeconds?.value);
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
  const model = triggerModelForWindow(provider, window);
  const targetLabel = windowGroupDisplayName(window.windowKind);
  const actionLabel = targetLabel ? `${targetLabel}, ${label}` : label;
  const startAction = canManuallyTrigger(provider, window)
    ? `<form class="manual-start-form" method="post" action="/providers/${encodeURIComponent(provider.id)}/trigger" data-awm-enhance="mutation" data-awm-target="overview-provider:${escapeHtml(provider.id)}" data-awm-uncertain-message="The start request may have been accepted. Refresh provider status; do not repeat the request until its result is clear."><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}"><input type="hidden" name="windowKind" value="${escapeHtml(window.windowKind)}">${model ? `<p class="manual-start-model">Start model: <strong>${escapeHtml(triggerModelDisplayName(model))}</strong></p>` : ''}<button class="button button-secondary" type="submit" data-awm-pending-label="Queueing start…" aria-label="Start ${escapeHtml(actionLabel)} now">Start this window now</button></form>`
    : '';
  return `<section class="window-card"><div class="window-header"><${headingTag}>${escapeHtml(label)}</${headingTag}>${phase ? `<span class="badge">${escapeHtml(phase)}</span>` : ''}</div>${usageMarkup}${reset}${startAction}</section>`;
}

function canManuallyTrigger(provider: ProviderRead, window: WindowSnapshot): boolean {
  const capability = provider.capabilities?.windowTrigger;
  return Boolean(
    provider.enabled &&
    provider.mode === 'automation' &&
    capability?.supported &&
    (!capability.supportedWindowKinds ||
      capability.supportedWindowKinds.includes(window.windowKind)),
  );
}

function triggerModelForWindow(provider: ProviderRead, window: WindowSnapshot): string | null {
  if (!canManuallyTrigger(provider, window)) return null;
  if (provider.kind !== 'antigravity' || !provider.triggerModels) return null;
  if (window.windowKind.startsWith('antigravity_gemini_')) return provider.triggerModels.gemini;
  if (window.windowKind.startsWith('antigravity_claude_gpt_'))
    return provider.triggerModels.claudeGpt;
  return null;
}

function triggerModelDisplayName(model: string): string {
  const knownNames: Record<string, string> = {
    'gemini-3.8-flash-low': 'Gemini 3.8 Flash Low',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  };
  return knownNames[model] ?? model;
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
