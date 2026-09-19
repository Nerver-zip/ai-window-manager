import Fastify from 'fastify';
import type { AppConfig } from '../config.js';
import type { ProviderCapabilities, ProviderObservation, WindowSnapshot } from '../domain/types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from '../scheduler/clock.js';
import type { SqliteDatabase } from '../storage/database.js';
import type {
  ActionIntentRecord,
  ProviderRecord,
  ProviderStateRecord,
  StorageRepositories,
} from '../storage/repositories.js';
import { registry } from '../metrics/metrics.js';

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
    bodyLimit: 64 * 1024,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    return payload;
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

  app.get('/api/v1/providers', () => ({
    providers: readProviders(input),
  }));

  app.get('/', async (_request, reply) => {
    const providers = readProviders(input);
    reply.type('text/html; charset=utf-8');
    return renderOverview(providers);
  });

  return app;
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
  const intent = input.repositories.actionIntents
    .listOpen(providerId)
    .find((candidate) => candidate.state === 'planned');

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

function renderOverview(providers: ProviderRead[]): string {
  const cards = providers.map(renderProviderCard).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Window Manager</title><style>body{font:16px system-ui;max-width:980px;margin:3rem auto;padding:0 1rem;background:#111;color:#eee}article{border:1px solid #444;border-radius:12px;padding:1rem;margin:1rem 0}dl{display:grid;grid-template-columns:minmax(8rem,14rem) 1fr;gap:.45rem 1rem}dt{color:#aaa}dd{margin:0}code{background:#222;padding:.2rem .4rem;border-radius:4px}.muted{color:#aaa}.stale{border-color:#d58b32}.warning{color:#ffbf69}.unknown{color:#aaa}</style></head><body><h1>AI Window Manager</h1><p class="muted">Persisted provider overview</p>${cards || '<p class="unknown">No providers configured.</p>'}<p><a href="/api/v1/providers">JSON providers</a> · <a href="/metrics">metrics</a></p></body></html>`;
}

function renderProviderCard(provider: ProviderRead): string {
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
      ? provider.windows.map(renderWindow).join('')
      : '<p class="unknown">Window: unknown</p>';
  const decision = provider.nextDecision
    ? `<p><strong>Next decision:</strong> ${escapeHtml(provider.nextDecision.decision)} · ${escapeHtml(provider.nextDecision.reasonCode ?? 'unknown')}</p><p><strong>Why:</strong> <code>${escapeHtml(JSON.stringify(provider.nextDecision.explanation))}</code></p>`
    : '<p><strong>Next decision:</strong> unknown</p><p><strong>Why:</strong> unknown</p>';

  return `<article class="provider${staleClass}"><h2>${escapeHtml(provider.id)}</h2><p class="muted">Kind: ${escapeHtml(provider.kind)} · Mode: ${escapeHtml(provider.mode)} · ${provider.enabled ? 'enabled' : 'disabled'}</p><dl><dt>Health</dt><dd>${escapeHtml(provider.health)}</dd><dt>Last updated</dt><dd>${escapeHtml(freshnessLabel)}</dd><dt>Last error</dt><dd>${escapeHtml(provider.lastErrorCode ?? 'none')}</dd></dl>${windows}${decision}</article>`;
}

function renderWindow(window: WindowSnapshot): string {
  return `<section><h3>${escapeHtml(window.windowKind)}</h3><dl><dt>Phase</dt><dd>${factText(window.phase.value, window.phase.source, window.phase.confidence)}</dd><dt>Usage</dt><dd>${factRatioText(window.usageRatio)}</dd><dt>Remaining</dt><dd>${factRatioText(window.remainingRatio)}</dd><dt>Reset</dt><dd>${factInstantText(window.resetAt)}</dd><dt>Duration</dt><dd>${factNumberText(window.durationSeconds, 's')}</dd></dl></section>`;
}

function factRatioText(fact: WindowSnapshot['usageRatio']): string {
  return fact
    ? factText(`${Math.round(fact.value * 100)}%`, fact.source, fact.confidence)
    : unknownText();
}

function factInstantText(fact: WindowSnapshot['resetAt']): string {
  return fact ? factText(fact.value, fact.source, fact.confidence) : unknownText();
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
