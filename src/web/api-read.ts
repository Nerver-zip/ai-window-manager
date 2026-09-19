import { z } from 'zod';
import {
  ProviderCapabilitiesSchema,
  ProviderIdSchema,
  UtcInstantSchema,
} from '../domain/schemas.js';
import type {
  Fact,
  ProviderCapabilities,
  ProviderObservation,
  WindowSnapshot,
} from '../domain/types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from '../scheduler/clock.js';
import type {
  ActionIntentRecord,
  EventRecord,
  ProviderRecord,
  ProviderStateRecord,
  SettingRecord,
  StorageRepositories,
} from '../storage/repositories.js';

export const MAX_HISTORY_LIMIT = 500;
export const DEFAULT_HISTORY_LIMIT = 100;

const HISTORY_SCAN_LIMIT = 1000;
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
const EVENT_DATA_KEYS = new Set([
  'actionType',
  'dedupeKey',
  'errorCode',
  'health',
  'intentId',
  'lastErrorCode',
  'policyId',
  'reasonCode',
  'result',
  'retryable',
  'state',
  'windowKinds',
  'explanation',
]);

const EVENT_TYPE_SCHEMA = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'type must be a lowercase event identifier');

const HistoryQuerySchema = z
  .object({
    provider: ProviderIdSchema.optional(),
    type: EVENT_TYPE_SCHEMA.optional(),
    from: UtcInstantSchema.optional(),
    to: UtcInstantSchema.optional(),
    limit: z
      .string()
      .regex(/^\d+$/, 'limit must be a positive integer')
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_HISTORY_LIMIT))
      .optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
      context.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'from must be earlier than or equal to to',
      });
    }
  });

const PUBLIC_SETTING_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  timezone: z.string().refine(isValidTimeZone, 'timezone must be a valid IANA timezone'),
  retention_window_samples_days: positiveDaysSchema(),
  retention_usage_events_days: positiveDaysSchema(),
  retention_lifecycle_events_days: positiveDaysSchema(),
  retention_action_intents_days: positiveDaysSchema(),
};

function positiveDaysSchema(): z.ZodType {
  return z.number().int().min(1).max(3650);
}

export interface ReadApiInput {
  repositories: StorageRepositories;
  clock: Clock;
  adapters?: ReadonlyMap<string, ProviderAdapter>;
}

export interface ReadApiSuccess<T> {
  statusCode: 200;
  body: T;
}

export interface ReadApiErrorBody {
  error: {
    code: 'BAD_REQUEST' | 'NOT_FOUND';
    message: string;
  };
}

export interface ReadApiError {
  statusCode: 400 | 404;
  body: ReadApiErrorBody;
}

export type ReadApiResult<T> = ReadApiSuccess<T> | ReadApiError;

export interface FreshnessDto {
  observedAt: string | null;
  ageSeconds: number | null;
  staleAfterSeconds: number | null;
  stale: boolean;
}

export interface WindowFactDto<T> {
  value: T;
  source: Fact<T>['source'];
  confidence: Fact<T>['confidence'];
  observedAt: string;
}

export interface WindowSnapshotDto {
  providerId: string;
  windowKind: string;
  observedAt: string;
  phase: WindowFactDto<WindowSnapshot['phase']['value']>;
  startedAt?: WindowFactDto<string>;
  durationSeconds?: WindowFactDto<number>;
  resetAt?: WindowFactDto<string>;
  usageRatio?: WindowFactDto<number>;
  remainingRatio?: WindowFactDto<number>;
}

export interface ProviderObservationDto {
  providerId: string;
  health: ProviderObservation['health'];
  observedAt: string;
  windows: WindowSnapshotDto[];
  staleAfterSeconds: number;
}

export interface ActionIntentDto {
  id: string;
  policyId: string | null;
  actionType: string;
  state: ActionIntentRecord['state'];
  dedupeKey: string;
  scheduledFor: string;
  notBefore: string | null;
  expiresAt: string | null;
  attemptCount: number;
  reasonCode: string;
  explanation: Record<string, JsonPrimitive>;
  lastErrorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface SchedulerDecisionDto {
  decision: 'create_intent' | 'noop';
  reasonCode: string | null;
  explanation: Record<string, JsonPrimitive>;
  eventType: string;
  occurredAt: string;
  actionIntent?: ActionIntentDto;
}

export interface ProviderDto {
  id: string;
  kind: string;
  enabled: boolean;
  mode: ProviderRecord['mode'];
  health: ProviderStateRecord['health'] | 'UNKNOWN';
  lastErrorCode: string | null;
  observation: ProviderObservationDto | null;
  windows: WindowSnapshotDto[];
  freshness: FreshnessDto;
  capabilities?: ProviderCapabilities;
  nextDecision: SchedulerDecisionDto | null;
}

export interface ProviderDetailDto extends ProviderDto {
  openActionIntents: ActionIntentDto[];
}

export interface ProvidersResponseDto {
  providers: ProviderDto[];
}

export interface ProviderResponseDto {
  provider: ProviderDetailDto;
}

export interface HistoryEventDto {
  id: number;
  occurredAt: string;
  providerId: string | null;
  type: string;
  severity: EventRecord['severity'];
  reasonCode: string | null;
  data: Record<string, JsonValue>;
}

export interface HistoryResponseDto {
  events: HistoryEventDto[];
  limit: number;
}

export interface SettingDto {
  key: string;
  value: JsonValue;
  updatedAt: string;
}

export interface SettingsResponseDto {
  settings: SettingDto[];
}

export interface HistoryQuery {
  provider?: string;
  type?: string;
  from?: string;
  to?: string;
  limit: number;
}

export interface ReadApiHandlers {
  getProviders(): ReadApiSuccess<ProvidersResponseDto>;
  getProvider(id: unknown): ReadApiResult<ProviderResponseDto>;
  getHistory(query: unknown): ReadApiResult<HistoryResponseDto>;
  getSettings(): ReadApiSuccess<SettingsResponseDto>;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function createReadApi(input: ReadApiInput): ReadApiHandlers {
  return {
    getProviders: () => success({ providers: readProviders(input) }),
    getProvider: (id) => readProvider(input, id),
    getHistory: (query) => readHistory(input, query),
    getSettings: () => success({ settings: readSettings(input.repositories.settings.list()) }),
  };
}

function readProviders(input: ReadApiInput): ProviderDto[] {
  const nowMs = input.clock.now().getTime();
  return input.repositories.providers
    .list()
    .map((provider) => readProviderDto(input, provider, nowMs));
}

function readProvider(input: ReadApiInput, rawId: unknown): ReadApiResult<ProviderResponseDto> {
  const parsedId = ProviderIdSchema.safeParse(rawId);
  if (!parsedId.success) return badRequest('provider id is invalid');

  const provider = input.repositories.providers.get(parsedId.data);
  if (!provider) return notFound('provider not found');

  return success({
    provider: readProviderDetailDto(input, provider, input.clock.now().getTime()),
  });
}

function readHistory(input: ReadApiInput, rawQuery: unknown): ReadApiResult<HistoryResponseDto> {
  const parsedQuery = parseHistoryQuery(rawQuery);
  if (!parsedQuery.success) return badRequest(parsedQuery.message);
  const query = parsedQuery.query;
  const fromMs = query.from ? Date.parse(query.from) : undefined;
  const toMs = query.to ? Date.parse(query.to) : undefined;

  const events = input.repositories.events
    .list(undefined, { limit: HISTORY_SCAN_LIMIT })
    .filter((event) => {
      if (query.provider !== undefined && event.providerId !== query.provider) return false;
      if (query.type !== undefined && event.type !== query.type) return false;
      if (fromMs !== undefined && event.occurredAtMs < fromMs) return false;
      if (toMs !== undefined && event.occurredAtMs > toMs) return false;
      return true;
    })
    .slice(0, query.limit)
    .map(eventDto);

  return success({ events, limit: query.limit });
}

function readSettings(records: SettingRecord[]): SettingDto[] {
  return records.flatMap((record) => {
    const schema = PUBLIC_SETTING_SCHEMAS[record.key];
    if (!schema) return [];
    const parsed = schema.safeParse(record.value);
    if (!parsed.success || !isJsonValue(parsed.data)) return [];
    return [
      {
        key: record.key,
        value: parsed.data,
        updatedAt: instant(record.updatedAtMs),
      },
    ];
  });
}

function readProviderDto(
  input: ReadApiInput,
  provider: ProviderRecord,
  nowMs: number,
): ProviderDto {
  const state = input.repositories.providerState.get(provider.id);
  const observation = state?.observation ? observationDto(state.observation) : null;
  const decision = readDecision(input, provider.id);
  const adapter = input.adapters?.get(provider.id);
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
}

function readProviderDetailDto(
  input: ReadApiInput,
  provider: ProviderRecord,
  nowMs: number,
): ProviderDetailDto {
  const base = readProviderDto(input, provider, nowMs);
  const openActionIntents = input.repositories.actionIntents
    .listOpen(provider.id)
    .slice(0, 100)
    .map(actionIntentDto);
  return { ...base, openActionIntents };
}

function safeCapabilities(adapter: ProviderAdapter): ProviderCapabilities | undefined {
  try {
    const parsed = ProviderCapabilitiesSchema.safeParse(adapter.capabilities());
    return parsed.success ? (parsed.data as ProviderCapabilities) : undefined;
  } catch {
    return undefined;
  }
}

function freshness(state: ProviderStateRecord | undefined, nowMs: number): FreshnessDto {
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
    observedAt: instant(state.observedAtMs),
    ageSeconds,
    staleAfterSeconds: Math.floor(state.staleAfterMs / 1000),
    stale: nowMs - state.observedAtMs > state.staleAfterMs,
  };
}

function readDecision(input: ReadApiInput, providerId: string): SchedulerDecisionDto | null {
  const events = input.repositories.events.list(providerId, { limit: 100 });
  const event = events.find((candidate) => DECISION_EVENT_TYPES.has(candidate.type));
  const intent = input.repositories.actionIntents
    .listOpen(providerId)
    .find((candidate) => candidate.state === 'planned');

  if (event) {
    const explanation = explanationDto(event.data);
    const result: SchedulerDecisionDto = {
      decision: event.type === 'action_intent_planned' ? 'create_intent' : 'noop',
      reasonCode: event.reasonCode ?? stringValue(explanation.reasonCode),
      explanation,
      eventType: event.type,
      occurredAt: instant(event.occurredAtMs),
    };
    if (intent) result.actionIntent = actionIntentDto(intent);
    return result;
  }

  if (intent) {
    return {
      decision: 'create_intent',
      reasonCode: intent.reasonCode,
      explanation: explanationDto(intent.explanation),
      eventType: 'action_intent',
      occurredAt: instant(intent.createdAtMs),
      actionIntent: actionIntentDto(intent),
    };
  }

  return null;
}

function observationDto(observation: ProviderObservation): ProviderObservationDto {
  return {
    providerId: observation.providerId,
    health: observation.health,
    observedAt: observation.observedAt,
    windows: observation.windows.map(windowDto),
    staleAfterSeconds: observation.staleAfterSeconds,
  };
}

function windowDto(window: WindowSnapshot): WindowSnapshotDto {
  const result: WindowSnapshotDto = {
    providerId: window.providerId,
    windowKind: window.windowKind,
    observedAt: window.observedAt,
    phase: factDto(window.phase),
  };
  if (window.startedAt) result.startedAt = factDto(window.startedAt);
  if (window.durationSeconds) result.durationSeconds = factDto(window.durationSeconds);
  if (window.resetAt) result.resetAt = factDto(window.resetAt);
  if (window.usageRatio) result.usageRatio = factDto(window.usageRatio);
  if (window.remainingRatio) result.remainingRatio = factDto(window.remainingRatio);
  return result;
}

function factDto<T>(fact: Fact<T>): WindowFactDto<T> {
  return {
    value: fact.value,
    source: fact.source,
    confidence: fact.confidence,
    observedAt: fact.observedAt,
  };
}

function actionIntentDto(intent: ActionIntentRecord): ActionIntentDto {
  return {
    id: intent.id,
    policyId: intent.policyId,
    actionType: intent.actionType,
    state: intent.state,
    dedupeKey: intent.dedupeKey,
    scheduledFor: instant(intent.scheduledForMs),
    notBefore: nullableInstant(intent.notBeforeMs),
    expiresAt: nullableInstant(intent.expiresAtMs),
    attemptCount: intent.attemptCount,
    reasonCode: intent.reasonCode,
    explanation: explanationDto(intent.explanation),
    lastErrorCode: intent.lastErrorCode,
    createdAt: instant(intent.createdAtMs),
    startedAt: nullableInstant(intent.startedAtMs),
    finishedAt: nullableInstant(intent.finishedAtMs),
    updatedAt: instant(intent.updatedAtMs),
  };
}

function eventDto(event: EventRecord): HistoryEventDto {
  return {
    id: event.id ?? 0,
    occurredAt: instant(event.occurredAtMs),
    providerId: event.providerId,
    type: event.type,
    severity: event.severity,
    reasonCode: event.reasonCode,
    data: eventDataDto(event.data),
  };
}

function eventDataDto(value: unknown): Record<string, JsonValue> {
  const source = asRecord(value);
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!EVENT_DATA_KEYS.has(key)) continue;
    if (key === 'explanation') {
      result[key] = explanationDto(item);
      continue;
    }
    if (key === 'windowKinds' && Array.isArray(item)) {
      const values = item
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 32);
      result[key] = values;
      continue;
    }
    if (isJsonPrimitive(item) && (typeof item !== 'string' || item.length <= 256)) {
      result[key] = item;
    }
  }
  return result;
}

function explanationDto(value: unknown): Record<string, JsonPrimitive> {
  const candidate = asRecord(value);
  const nested = asRecord(candidate.explanation);
  const source = Object.keys(nested).length > 0 ? nested : candidate;
  const result: Record<string, JsonPrimitive> = {};
  for (const [key, item] of Object.entries(source)) {
    if (EXPLANATION_KEYS.has(key) && isJsonPrimitive(item)) result[key] = item;
  }
  return result;
}

function parseHistoryQuery(
  value: unknown,
): { success: true; query: HistoryQuery } | { success: false; message: string } {
  const parsed = HistoryQuerySchema.safeParse(value ?? {});
  if (!parsed.success) return { success: false, message: 'history query is invalid' };
  return {
    success: true,
    query: {
      ...(parsed.data.provider ? { provider: parsed.data.provider } : {}),
      ...(parsed.data.type ? { type: parsed.data.type } : {}),
      ...(parsed.data.from ? { from: parsed.data.from } : {}),
      ...(parsed.data.to ? { to: parsed.data.to } : {}),
      limit: parsed.data.limit ?? DEFAULT_HISTORY_LIMIT,
    },
  };
}

function success<T>(body: T): ReadApiSuccess<T> {
  return { statusCode: 200, body };
}

function badRequest(message: string): ReadApiError {
  return { statusCode: 400, body: { error: { code: 'BAD_REQUEST', message } } };
}

function notFound(message: string): ReadApiError {
  return { statusCode: 404, body: { error: { code: 'NOT_FOUND', message } } };
}

function nullableInstant(value: number | null): string | null {
  return value === null ? null : instant(value);
}

function instant(value: number): string {
  return new Date(value).toISOString();
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every(isJsonValue);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
