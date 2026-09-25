import type {
  Confidence,
  EvidenceSource,
  Fact,
  ProviderHealth,
  ProviderObservation,
  WindowPhase,
  WindowSnapshot,
} from '../domain/types.js';
import { parseProviderObservation, WindowSnapshotSchema } from '../domain/schemas.js';
import type { UsageInterval, UsageSampleInput, UsageSeriesState } from '../usage/aggregation.js';
import type { SqliteDatabase } from './database.js';

export type ProviderMode = 'monitor_only' | 'automation';
export type SchedulePolicyScope = 'default' | 'gemini' | 'claude_gpt' | 'legacy';
export type SchedulePolicyKind =
  'manual' | 'auto' | 'fixed' | 'custom_schedule' | 'active_hours' | 'target_reset' | 'work_window';
export type ActionIntentState =
  | 'planned'
  | 'executing'
  | 'succeeded'
  | 'confirmed'
  | 'uncertain'
  | 'skipped'
  | 'canceled'
  | 'failed_retryable'
  | 'failed_terminal';
export type EventSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface ProviderRecord {
  id: string;
  kind: string;
  enabled: boolean;
  mode: ProviderMode;
  modeExplicit?: boolean;
  pollIntervalSeconds: number;
  config: unknown;
  configVersion: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ProviderStateRecord {
  providerId: string;
  health: ProviderHealth;
  observedAtMs: number | null;
  staleAfterMs: number | null;
  observation: ProviderObservation | null;
  lastSuccessAtMs: number | null;
  lastErrorCode: string | null;
  updatedAtMs: number;
}

export interface EventRecord {
  id?: number;
  occurredAtMs: number;
  providerId: string | null;
  type: string;
  severity: EventSeverity;
  reasonCode: string | null;
  data: unknown;
}

export interface SchedulePolicyRecord {
  id: string;
  providerId: string;
  scope?: SchedulePolicyScope;
  requiresReview?: boolean;
  kind: SchedulePolicyKind;
  kindExplicit?: boolean;
  enabled: boolean;
  timezone: string;
  config: unknown;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ActionIntentRecord {
  id: string;
  providerId: string;
  policyId: string | null;
  actionType: string;
  dedupeKey: string;
  state: ActionIntentState;
  scheduledForMs: number;
  notBeforeMs: number | null;
  expiresAtMs: number | null;
  attemptCount: number;
  reasonCode: string;
  explanation: unknown;
  lastErrorCode: string | null;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  updatedAtMs: number;
}

export interface SettingRecord<T = unknown> {
  key: string;
  value: T;
  updatedAtMs: number;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  /** Inclusive lower bound for UTC epoch milliseconds. */
  afterMs?: number;
  beforeMs?: number;
  /** Exclude one provider while retaining system events with a null provider ID. */
  excludeProviderId?: string;
  /** Omit routine event types from bounded read views such as the activity timeline. */
  excludeTypes?: readonly string[];
}

export interface StorageRepositories {
  providers: ProviderRepository;
  providerState: ProviderStateRepository;
  windowSamples: WindowSampleRepository;
  usageAggregation: UsageAggregationRepository;
  events: EventRepository;
  settings: SettingsRepository;
  schedulePolicies: SchedulePolicyRepository;
  actionIntents: ActionIntentRepository;
}

export function createRepositories(db: SqliteDatabase): StorageRepositories {
  return {
    providers: new ProviderRepository(db),
    providerState: new ProviderStateRepository(db),
    windowSamples: new WindowSampleRepository(db),
    usageAggregation: new UsageAggregationRepository(db),
    events: new EventRepository(db),
    settings: new SettingsRepository(db),
    schedulePolicies: new SchedulePolicyRepository(db),
    actionIntents: new ActionIntentRepository(db),
  };
}

export function withTransaction<T>(db: SqliteDatabase, operation: () => T): T {
  return db.transaction(operation)();
}

export class ProviderRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(provider: ProviderRecord): void {
    this.db
      .prepare(
        `INSERT INTO providers (
          id, kind, enabled, mode, mode_explicit, poll_interval_seconds, config_json,
          config_version, created_at_ms, updated_at_ms
        ) VALUES (@id, @kind, @enabled, @mode, @modeExplicit, @pollIntervalSeconds, @config,
          @configVersion, @createdAtMs, @updatedAtMs)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          enabled = excluded.enabled,
          mode = excluded.mode,
          mode_explicit = excluded.mode_explicit,
          poll_interval_seconds = excluded.poll_interval_seconds,
          config_json = excluded.config_json,
          config_version = excluded.config_version,
          updated_at_ms = excluded.updated_at_ms`,
      )
      .run({
        ...provider,
        enabled: booleanToInteger(provider.enabled),
        modeExplicit: booleanToInteger(provider.modeExplicit ?? false),
        config: stringifyJson(provider.config),
      });
  }

  get(id: string): ProviderRecord | undefined {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      ProviderRow | undefined;
    return row ? providerFromRow(row) : undefined;
  }

  list(): ProviderRecord[] {
    return (this.db.prepare('SELECT * FROM providers ORDER BY id').all() as ProviderRow[]).map(
      providerFromRow,
    );
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM providers WHERE id = ?').run(id).changes === 1;
  }
}

export class ProviderStateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(state: ProviderStateRecord): void {
    const observation = state.observation ? parseProviderObservation(state.observation) : null;
    this.db
      .prepare(
        `INSERT INTO provider_state (
          provider_id, health, observed_at_ms, stale_after_ms, observation_json,
          last_success_at_ms, last_error_code, updated_at_ms
        ) VALUES (@providerId, @health, @observedAtMs, @staleAfterMs, @observation,
          @lastSuccessAtMs, @lastErrorCode, @updatedAtMs)
        ON CONFLICT(provider_id) DO UPDATE SET
          health = excluded.health,
          observed_at_ms = excluded.observed_at_ms,
          stale_after_ms = excluded.stale_after_ms,
          observation_json = excluded.observation_json,
          last_success_at_ms = excluded.last_success_at_ms,
          last_error_code = excluded.last_error_code,
          updated_at_ms = excluded.updated_at_ms`,
      )
      .run({
        ...state,
        observation: observation ? stringifyJson(observation) : null,
      });
  }

  get(providerId: string): ProviderStateRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM provider_state WHERE provider_id = ?')
      .get(providerId) as ProviderStateRow | undefined;
    return row ? providerStateFromRow(row) : undefined;
  }
}

export class WindowSampleRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(snapshot: WindowSnapshot): number {
    const values = snapshotToColumns(WindowSnapshotSchema.parse(snapshot) as WindowSnapshot);
    const result = this.db
      .prepare(
        `INSERT INTO window_samples (
          provider_id, window_kind, observed_at_ms, phase,
          phase_source, phase_confidence, phase_observed_at_ms,
          started_at_ms, started_source, started_confidence, started_observed_at_ms,
          reset_at_ms, reset_source, reset_confidence, reset_observed_at_ms,
          duration_seconds, duration_source, duration_confidence, duration_observed_at_ms,
          usage_ratio, usage_source, usage_confidence, usage_observed_at_ms,
          remaining_ratio, remaining_source, remaining_confidence, remaining_observed_at_ms
        ) VALUES (
          @providerId, @windowKind, @observedAtMs, @phase,
          @phaseSource, @phaseConfidence, @phaseObservedAtMs,
          @startedAtMs, @startedSource, @startedConfidence, @startedObservedAtMs,
          @resetAtMs, @resetSource, @resetConfidence, @resetObservedAtMs,
          @durationSeconds, @durationSource, @durationConfidence, @durationObservedAtMs,
          @usageRatio, @usageSource, @usageConfidence, @usageObservedAtMs,
          @remainingRatio, @remainingSource, @remainingConfidence, @remainingObservedAtMs
        )`,
      )
      .run(values);
    return Number(result.lastInsertRowid);
  }

  get(id: number): WindowSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM window_samples WHERE id = ?').get(id) as
      WindowSampleRow | undefined;
    return row ? windowSnapshotFromRow(row) : undefined;
  }

  list(providerId: string, options: ListOptions = {}): WindowSnapshot[] {
    const limit = boundedLimit(options.limit);
    const offset = boundedOffset(options.offset);
    const clauses = ['provider_id = @providerId'];
    const params: Record<string, string | number> = { providerId, limit, offset };
    if (options.afterMs !== undefined) {
      clauses.push('observed_at_ms >= @afterMs');
      params.afterMs = options.afterMs;
    }
    if (options.beforeMs !== undefined) {
      clauses.push('observed_at_ms < @beforeMs');
      params.beforeMs = options.beforeMs;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM window_samples
         WHERE ${clauses.join(' AND ')}
         ORDER BY observed_at_ms DESC, id DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(params) as WindowSampleRow[];
    return rows.map(windowSnapshotFromRow);
  }

  latest(providerId: string, windowKind: string): WindowSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM window_samples
         WHERE provider_id = ? AND window_kind = ?
         ORDER BY observed_at_ms DESC, id DESC
         LIMIT 1`,
      )
      .get(providerId, windowKind) as WindowSampleRow | undefined;
    return row ? windowSnapshotFromRow(row) : undefined;
  }

  listForUsageAggregation(afterId: number, limit: number): UsageSampleInput[] {
    return this.db
      .prepare(
        `SELECT id, provider_id, window_kind, observed_at_ms, duration_seconds,
                duration_confidence, reset_at_ms, reset_confidence, usage_ratio,
                usage_confidence, usage_observed_at_ms
         FROM window_samples WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, boundedLimit(limit))
      .map((value) => {
        const row = value as {
          id: number;
          provider_id: string;
          window_kind: string;
          observed_at_ms: number;
          duration_seconds: number | null;
          duration_confidence: string | null;
          reset_at_ms: number | null;
          reset_confidence: string | null;
          usage_ratio: number | null;
          usage_confidence: string | null;
          usage_observed_at_ms: number | null;
        };
        return {
          id: row.id,
          providerId: row.provider_id,
          windowKind: row.window_kind,
          observedAtMs: row.observed_at_ms,
          durationSeconds: row.duration_seconds,
          durationConfidence: row.duration_confidence,
          resetAtMs: row.reset_at_ms,
          resetConfidence: row.reset_confidence,
          usageRatio: row.usage_ratio,
          usageConfidence: row.usage_confidence,
          usageObservedAtMs: row.usage_observed_at_ms,
        };
      });
  }

  chartPoints(
    providerId: string,
    windowKind: string,
    fromMs: number,
    toMs: number,
    buckets: number,
    maxGapMs = 600_000,
  ): Array<{
    id: number;
    observedAtMs: number;
    usageRatio: number | null;
    remainingRatio: number | null;
    gapBefore: boolean;
  }> {
    if (!Number.isSafeInteger(buckets) || buckets < 1 || buckets > 384) {
      throw new RangeError('chart buckets must be between 1 and 384');
    }
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs <= fromMs) {
      throw new RangeError('chart range must be a positive UTC interval');
    }
    if (!Number.isSafeInteger(maxGapMs) || maxGapMs < 1) {
      throw new RangeError('chart gap threshold must be a positive safe integer');
    }
    const rows = this.db
      .prepare(
        `WITH sequenced AS (
           SELECT id, observed_at_ms, usage_ratio, remaining_ratio,
                  LAG(observed_at_ms) OVER (ORDER BY observed_at_ms, id) AS previous_at
           FROM window_samples
           WHERE provider_id = @providerId AND window_kind = @windowKind
             AND observed_at_ms >= @scanFromMs AND observed_at_ms < @toMs
         ), filtered AS (
           SELECT id, observed_at_ms, usage_ratio, remaining_ratio,
                  CAST(MIN(@buckets - 1, ((observed_at_ms - @fromMs) * @buckets) / (@toMs - @fromMs)) AS INTEGER) AS bucket,
                  CASE WHEN previous_at IS NOT NULL AND observed_at_ms - previous_at > @maxGapMs THEN 1 ELSE 0 END AS gap_start
           FROM sequenced
           WHERE observed_at_ms >= @fromMs
         ), annotated AS (
           SELECT *,
             SUM(gap_start) OVER (PARTITION BY bucket) AS bucket_gap_count,
             MIN(CASE WHEN gap_start = 1 THEN observed_at_ms END) OVER (PARTITION BY bucket) AS first_gap_at,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY CASE WHEN gap_start = 1 THEN 0 ELSE 1 END, observed_at_ms, id) AS gap_rank
           FROM filtered
         ), ranked AS (
           SELECT *,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY observed_at_ms ASC, id ASC) AS first_rank,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY observed_at_ms DESC, id DESC) AS last_rank,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY CASE WHEN usage_ratio IS NULL THEN 1 ELSE 0 END, usage_ratio ASC, observed_at_ms ASC, id ASC) AS low_rank,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY CASE WHEN usage_ratio IS NULL THEN 1 ELSE 0 END, usage_ratio DESC, observed_at_ms ASC, id ASC) AS high_rank
           FROM annotated
         )
         SELECT DISTINCT id, observed_at_ms, usage_ratio, remaining_ratio,
                CASE
                  WHEN gap_start = 1 AND gap_rank = 1 THEN 1
                  WHEN bucket_gap_count > 1 AND observed_at_ms >= first_gap_at
                    AND (first_rank = 1 OR last_rank = 1 OR low_rank = 1 OR high_rank = 1) THEN 1
                  ELSE 0
                END AS gap_before
         FROM ranked
         WHERE first_rank = 1 OR last_rank = 1
            OR (usage_ratio IS NOT NULL AND (low_rank = 1 OR high_rank = 1))
            OR (gap_start = 1 AND gap_rank = 1)
         ORDER BY observed_at_ms ASC, id ASC`,
      )
      .all({
        providerId,
        windowKind,
        fromMs,
        toMs,
        buckets,
        maxGapMs,
        scanFromMs: fromMs - maxGapMs,
      }) as Array<{
      id: number;
      observed_at_ms: number;
      usage_ratio: number | null;
      remaining_ratio: number | null;
      gap_before: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      observedAtMs: row.observed_at_ms,
      usageRatio: row.usage_ratio,
      remainingRatio: row.remaining_ratio,
      gapBefore: row.gap_before === 1,
    }));
  }

  listWindowKinds(providerId: string, fromMs: number, toMs: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT window_kind FROM window_samples
           WHERE provider_id = ? AND observed_at_ms >= ? AND observed_at_ms < ?
           ORDER BY window_kind`,
        )
        .all(providerId, fromMs, toMs) as Array<{ window_kind: string }>
    ).map((row) => row.window_kind);
  }
}

export interface UsageAggregationCheckpoint {
  lastSampleId: number;
  updatedAtMs: number;
}

export type StoredUsageInterval = UsageInterval;

export class UsageAggregationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  checkpoint(): UsageAggregationCheckpoint {
    const row = this.db
      .prepare(
        'SELECT last_sample_id, updated_at_ms FROM usage_aggregation_checkpoint WHERE id = 1',
      )
      .get() as { last_sample_id: number; updated_at_ms: number };
    return { lastSampleId: row.last_sample_id, updatedAtMs: row.updated_at_ms };
  }

  maxSampleId(): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM window_samples')
      .get() as {
      max_id: number;
    };
    return row.max_id;
  }

  seriesState(providerId: string, windowKind: string): UsageSeriesState | null {
    const row = this.db
      .prepare(
        'SELECT state_json FROM usage_series_state WHERE provider_id = ? AND window_kind = ?',
      )
      .get(providerId, windowKind) as { state_json: string } | undefined;
    return row ? parseJson<UsageSeriesState>(row.state_json) : null;
  }

  saveSeriesState(
    providerId: string,
    windowKind: string,
    state: UsageSeriesState | null,
    updatedAtMs: number,
  ): void {
    if (!state) {
      this.db
        .prepare('DELETE FROM usage_series_state WHERE provider_id = ? AND window_kind = ?')
        .run(providerId, windowKind);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO usage_series_state(provider_id, window_kind, state_json, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_id, window_kind) DO UPDATE SET
           state_json = excluded.state_json, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(providerId, windowKind, stringifyJson(state), updatedAtMs);
  }

  insertInterval(value: UsageInterval): void {
    const previous = this.db
      .prepare(
        `SELECT source_sample_id, from_ms, usage_delta_ratio, quality, reason_code
         FROM usage_intervals
         WHERE provider_id = ? AND window_kind = ? AND to_ms = ?
         ORDER BY source_sample_id DESC LIMIT 1`,
      )
      .get(value.providerId, value.windowKind, value.fromMs) as
      | {
          source_sample_id: number;
          from_ms: number;
          usage_delta_ratio: number | null;
          quality: UsageInterval['quality'];
          reason_code: string | null;
        }
      | undefined;
    if (
      previous &&
      previous.usage_delta_ratio === value.usageDeltaRatio &&
      previous.quality === value.quality &&
      previous.reason_code === value.reasonCode
    ) {
      this.db
        .prepare(
          `UPDATE usage_intervals
           SET source_sample_id = ?, to_ms = ?
           WHERE source_sample_id = ?`,
        )
        .run(value.sourceSampleId, value.toMs, previous.source_sample_id);
      return;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_intervals(
           source_sample_id, provider_id, window_kind, from_ms, to_ms,
           usage_delta_ratio, quality, reason_code
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.sourceSampleId,
        value.providerId,
        value.windowKind,
        value.fromMs,
        value.toMs,
        value.usageDeltaRatio,
        value.quality,
        value.reasonCode,
      );
  }

  advanceCheckpoint(lastSampleId: number, updatedAtMs: number): void {
    this.db
      .prepare(
        'UPDATE usage_aggregation_checkpoint SET last_sample_id = ?, updated_at_ms = ? WHERE id = 1',
      )
      .run(lastSampleId, updatedAtMs);
  }

  listIntervals(
    providerId: string,
    windowKind: string,
    fromMs: number,
    toMs: number,
  ): StoredUsageInterval[] {
    const rows = this.db
      .prepare(
        `SELECT source_sample_id, provider_id, window_kind, from_ms, to_ms,
                usage_delta_ratio, quality, reason_code
         FROM usage_intervals
         WHERE provider_id = @providerId AND window_kind = @windowKind
           AND ((to_ms > @fromMs AND from_ms < @toMs)
             OR (from_ms = to_ms AND from_ms >= @fromMs AND from_ms < @toMs))
         ORDER BY from_ms, source_sample_id`,
      )
      .all({ providerId, windowKind, fromMs, toMs }) as Array<{
      source_sample_id: number;
      provider_id: string;
      window_kind: string;
      from_ms: number;
      to_ms: number;
      usage_delta_ratio: number | null;
      quality: UsageInterval['quality'];
      reason_code: string | null;
    }>;
    return rows.map((row) => ({
      sourceSampleId: row.source_sample_id,
      providerId: row.provider_id,
      windowKind: row.window_kind,
      fromMs: row.from_ms,
      toMs: row.to_ms,
      usageDeltaRatio: row.usage_delta_ratio,
      quality: row.quality,
      reasonCode: row.reason_code,
    }));
  }

  listBuckets(providerId?: string): Array<{ providerId: string; windowKind: string }> {
    const rows = providerId
      ? this.db
          .prepare(
            `SELECT provider_id, window_kind FROM usage_intervals WHERE provider_id = ?
             UNION
             SELECT provider_id, window_kind FROM usage_series_state
             WHERE provider_id = ? AND json_extract(state_json, '$.durationSeconds') = 604800
             ORDER BY provider_id, window_kind`,
          )
          .all(providerId, providerId)
      : this.db
          .prepare(
            `SELECT provider_id, window_kind FROM usage_intervals
             UNION
             SELECT provider_id, window_kind FROM usage_series_state
             WHERE json_extract(state_json, '$.durationSeconds') = 604800
             ORDER BY provider_id, window_kind`,
          )
          .all();
    return (rows as Array<{ provider_id: string; window_kind: string }>).map((row) => ({
      providerId: row.provider_id,
      windowKind: row.window_kind,
    }));
  }
}

export class EventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  append(event: EventRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO events (
          occurred_at_ms, provider_id, type, severity, reason_code, data_json
        ) VALUES (@occurredAtMs, @providerId, @type, @severity, @reasonCode, @data)`,
      )
      .run({ ...event, data: stringifyJson(event.data) });
    return Number(result.lastInsertRowid);
  }

  list(providerId?: string, options: ListOptions = {}): EventRecord[] {
    const limit = boundedLimit(options.limit);
    const offset = boundedOffset(options.offset);
    const clauses: string[] = [];
    const params: Record<string, string | number> = { limit, offset };
    if (providerId !== undefined) {
      clauses.push('provider_id = @providerId');
      params.providerId = providerId;
    }
    if (options.afterMs !== undefined) {
      clauses.push('occurred_at_ms >= @afterMs');
      params.afterMs = options.afterMs;
    }
    if (options.beforeMs !== undefined) {
      clauses.push('occurred_at_ms < @beforeMs');
      params.beforeMs = options.beforeMs;
    }
    if (options.excludeProviderId !== undefined) {
      clauses.push('(provider_id IS NULL OR provider_id <> @excludeProviderId)');
      params.excludeProviderId = options.excludeProviderId;
    }
    const excludedTypes = (options.excludeTypes ?? [])
      .filter((type) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(type))
      .slice(0, 32);
    if (excludedTypes.length > 0) {
      const placeholders = excludedTypes.map((type, index) => {
        const key = `excludeType${index}`;
        params[key] = type;
        return `@${key}`;
      });
      clauses.push(`type NOT IN (${placeholders.join(', ')})`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM events ${where}
         ORDER BY occurred_at_ms DESC, id DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(params) as EventRow[];
    return rows.map(eventFromRow);
  }
}

export class SettingsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  set<T>(key: string, value: T, updatedAtMs: number): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value_json, updated_at_ms)
         VALUES (@key, @value, @updatedAtMs)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run({ key, value: stringifyJson(value), updatedAtMs });
  }

  get<T = unknown>(key: string): SettingRecord<T> | undefined {
    const row = this.db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as
      SettingRow | undefined;
    return row
      ? { key: row.key, value: parseJson<T>(row.value_json), updatedAtMs: row.updated_at_ms }
      : undefined;
  }

  list(): SettingRecord[] {
    return (this.db.prepare('SELECT * FROM settings ORDER BY key').all() as SettingRow[]).map(
      (row) => ({ key: row.key, value: parseJson(row.value_json), updatedAtMs: row.updated_at_ms }),
    );
  }

  delete(key: string): boolean {
    return this.db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes === 1;
  }
}

export class SchedulePolicyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(policy: SchedulePolicyRecord): void {
    this.db
      .prepare(
        `INSERT INTO schedule_policies (
          id, provider_id, scope, requires_review, kind, kind_explicit, enabled, timezone, config_json, created_at_ms, updated_at_ms
        ) VALUES (@id, @providerId, @scope, @requiresReview, @kind, @kindExplicit, @enabled, @timezone, @config, @createdAtMs, @updatedAtMs)
        ON CONFLICT(id) DO UPDATE SET
          provider_id = excluded.provider_id,
          scope = excluded.scope,
          requires_review = excluded.requires_review,
          kind = excluded.kind,
          kind_explicit = excluded.kind_explicit,
          enabled = excluded.enabled,
          timezone = excluded.timezone,
          config_json = excluded.config_json,
          updated_at_ms = excluded.updated_at_ms`,
      )
      .run({
        ...policy,
        scope: policy.scope ?? 'default',
        requiresReview: booleanToInteger(policy.requiresReview ?? false),
        enabled: booleanToInteger(policy.enabled),
        kindExplicit: booleanToInteger(policy.kindExplicit ?? false),
        config: stringifyJson(policy.config),
      });
  }

  get(id: string): SchedulePolicyRecord | undefined {
    const row = this.db.prepare('SELECT * FROM schedule_policies WHERE id = ?').get(id) as
      SchedulePolicyRow | undefined;
    return row ? schedulePolicyFromRow(row) : undefined;
  }

  list(providerId?: string): SchedulePolicyRecord[] {
    const rows =
      providerId === undefined
        ? this.db.prepare('SELECT * FROM schedule_policies ORDER BY id').all()
        : this.db
            .prepare('SELECT * FROM schedule_policies WHERE provider_id = ? ORDER BY id')
            .all(providerId);
    return (rows as SchedulePolicyRow[]).map(schedulePolicyFromRow);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM schedule_policies WHERE id = ?').run(id).changes === 1;
  }
}

export class ActionIntentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  createIfAbsent(intent: ActionIntentRecord): { created: boolean; intent: ActionIntentRecord } {
    return withTransaction(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT INTO action_intents (
            id, provider_id, policy_id, action_type, dedupe_key, state,
            scheduled_for_ms, not_before_ms, expires_at_ms, attempt_count,
            reason_code, explanation_json, last_error_code, created_at_ms,
            started_at_ms, finished_at_ms, updated_at_ms
          ) VALUES (
            @id, @providerId, @policyId, @actionType, @dedupeKey, @state,
            @scheduledForMs, @notBeforeMs, @expiresAtMs, @attemptCount,
            @reasonCode, @explanation, @lastErrorCode, @createdAtMs,
            @startedAtMs, @finishedAtMs, @updatedAtMs
          ) ON CONFLICT(dedupe_key) DO NOTHING`,
        )
        .run({ ...intent, explanation: stringifyJson(intent.explanation) });
      const stored = this.getByDedupeKey(intent.dedupeKey);
      if (!stored) throw new Error('action intent was not available after insert');
      return { created: result.changes === 1, intent: stored };
    });
  }

  get(id: string): ActionIntentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM action_intents WHERE id = ?').get(id) as
      ActionIntentRow | undefined;
    return row ? actionIntentFromRow(row) : undefined;
  }

  getByDedupeKey(dedupeKey: string): ActionIntentRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM action_intents WHERE dedupe_key = ?')
      .get(dedupeKey) as ActionIntentRow | undefined;
    return row ? actionIntentFromRow(row) : undefined;
  }

  listOpen(providerId?: string): ActionIntentRecord[] {
    const states = ['planned', 'executing', 'succeeded', 'uncertain', 'failed_retryable'];
    const placeholders = states.map(() => '?').join(', ');
    const params: Array<string> = [...states];
    let query = `SELECT * FROM action_intents WHERE state IN (${placeholders})`;
    if (providerId !== undefined) {
      query += ' AND provider_id = ?';
      params.push(providerId);
    }
    query += ' ORDER BY scheduled_for_ms, id';
    return (this.db.prepare(query).all(...params) as ActionIntentRow[]).map(actionIntentFromRow);
  }

  countsByState(providerId: string): Partial<Record<ActionIntentState, number>> {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM action_intents
         WHERE provider_id = ?
         GROUP BY state`,
      )
      .all(providerId) as Array<{ state: ActionIntentState; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
  }

  claimPlanned(id: string, nowMs: number): ActionIntentRecord | undefined {
    return this.claim(id, 'planned', nowMs);
  }

  claimRetryable(id: string, nowMs: number): ActionIntentRecord | undefined {
    return this.claim(id, 'failed_retryable', nowMs);
  }

  markSucceededIfExecuting(id: string, updatedAtMs: number): boolean {
    return this.transition(id, ['executing'], 'succeeded', updatedAtMs);
  }

  markUncertainIfExecuting(
    id: string,
    updatedAtMs: number,
    lastErrorCode: string | null = 'ACTION_DISPATCH_UNCERTAIN',
  ): boolean {
    return this.transition(id, ['executing'], 'uncertain', updatedAtMs, { lastErrorCode });
  }

  markUncertainIfSucceeded(
    id: string,
    updatedAtMs: number,
    lastErrorCode: string | null = 'ACTION_CONFIRMATION_FAILED',
  ): boolean {
    return this.transition(id, ['succeeded'], 'uncertain', updatedAtMs, { lastErrorCode });
  }

  markConfirmedIfSucceededOrUncertain(id: string, updatedAtMs: number): boolean {
    return this.transition(id, ['succeeded', 'uncertain'], 'confirmed', updatedAtMs, {
      finishedAtMs: updatedAtMs,
      lastErrorCode: null,
    });
  }

  markRetryableIfExecuting(
    id: string,
    updatedAtMs: number,
    retryAtMs: number,
    lastErrorCode: string,
  ): boolean {
    return this.transition(id, ['executing'], 'failed_retryable', updatedAtMs, {
      notBeforeMs: retryAtMs,
      lastErrorCode,
    });
  }

  markRetryableIfPlannedOrRetryable(
    id: string,
    updatedAtMs: number,
    retryAtMs: number,
    lastErrorCode: string,
  ): boolean {
    return this.transition(id, ['planned', 'failed_retryable'], 'failed_retryable', updatedAtMs, {
      notBeforeMs: retryAtMs,
      lastErrorCode,
    });
  }

  markTerminalIfExecuting(id: string, updatedAtMs: number, lastErrorCode: string): boolean {
    return this.transition(id, ['executing'], 'failed_terminal', updatedAtMs, {
      finishedAtMs: updatedAtMs,
      lastErrorCode,
    });
  }

  markSkippedIfPlanned(id: string, updatedAtMs: number, reasonCode: string): boolean {
    return this.transition(id, ['planned'], 'skipped', updatedAtMs, {
      finishedAtMs: updatedAtMs,
      lastErrorCode: reasonCode,
    });
  }

  markSkippedIfPlannedOrRetryable(id: string, updatedAtMs: number, reasonCode: string): boolean {
    return this.transition(id, ['planned', 'failed_retryable'], 'skipped', updatedAtMs, {
      finishedAtMs: updatedAtMs,
      lastErrorCode: reasonCode,
    });
  }

  recoverExecuting(id: string, updatedAtMs: number): boolean {
    return this.transition(id, ['executing'], 'uncertain', updatedAtMs, {
      lastErrorCode: 'ACTION_RECOVERY_REQUIRED',
    });
  }

  private claim(
    id: string,
    expectedState: Extract<ActionIntentState, 'planned' | 'failed_retryable'>,
    nowMs: number,
  ): ActionIntentRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE action_intents SET
          state = 'executing',
          attempt_count = attempt_count + 1,
          started_at_ms = COALESCE(started_at_ms, @nowMs),
          updated_at_ms = @nowMs
         WHERE id = @id
           AND state = @expectedState
           AND (not_before_ms IS NULL OR not_before_ms <= @nowMs)
           AND (
             expires_at_ms IS NULL
             OR expires_at_ms > @nowMs
             OR (
               expires_at_ms = scheduled_for_ms
               AND expires_at_ms = @nowMs
               AND json_extract(explanation_json, '$.toleranceSeconds') = 0
             )
           )`,
      )
      .run({ id, expectedState, nowMs });
    return result.changes === 1 ? this.get(id) : undefined;
  }

  private transition(
    id: string,
    expectedStates: readonly ActionIntentState[],
    nextState: ActionIntentState,
    updatedAtMs: number,
    details: {
      lastErrorCode?: string | null;
      notBeforeMs?: number | null;
      finishedAtMs?: number | null;
    } = {},
  ): boolean {
    const placeholders = expectedStates.map((_state, index) => `@expected${index}`).join(', ');
    const result = this.db
      .prepare(
        `UPDATE action_intents SET
          state = @nextState,
          not_before_ms = CASE WHEN @hasNotBefore = 1 THEN @notBeforeMs ELSE not_before_ms END,
          last_error_code = CASE WHEN @hasLastError = 1 THEN @lastErrorCode ELSE last_error_code END,
          finished_at_ms = CASE WHEN @hasFinishedAt = 1 THEN @finishedAtMs ELSE finished_at_ms END,
          updated_at_ms = @updatedAtMs
         WHERE id = @id AND state IN (${placeholders})`,
      )
      .run({
        id,
        nextState,
        updatedAtMs,
        hasNotBefore: Object.hasOwn(details, 'notBeforeMs') ? 1 : 0,
        notBeforeMs: details.notBeforeMs ?? null,
        hasLastError: Object.hasOwn(details, 'lastErrorCode') ? 1 : 0,
        lastErrorCode: details.lastErrorCode ?? null,
        hasFinishedAt: Object.hasOwn(details, 'finishedAtMs') ? 1 : 0,
        finishedAtMs: details.finishedAtMs ?? null,
        ...Object.fromEntries(expectedStates.map((state, index) => [`expected${index}`, state])),
      });
    return result.changes === 1;
  }

  setState(
    id: string,
    state: ActionIntentState,
    updatedAtMs: number,
    details: {
      attemptCount?: number;
      lastErrorCode?: string | null;
      startedAtMs?: number | null;
      finishedAtMs?: number | null;
    } = {},
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE action_intents SET
          state = @state,
          attempt_count = COALESCE(@attemptCount, attempt_count),
          last_error_code = CASE WHEN @hasLastError = 1 THEN @lastErrorCode ELSE last_error_code END,
          started_at_ms = COALESCE(@startedAtMs, started_at_ms),
          finished_at_ms = COALESCE(@finishedAtMs, finished_at_ms),
          updated_at_ms = @updatedAtMs
         WHERE id = @id`,
      )
      .run({
        id,
        state,
        updatedAtMs,
        attemptCount: details.attemptCount ?? null,
        hasLastError: Object.hasOwn(details, 'lastErrorCode') ? 1 : 0,
        lastErrorCode: details.lastErrorCode ?? null,
        startedAtMs: details.startedAtMs ?? null,
        finishedAtMs: details.finishedAtMs ?? null,
      });
    return result.changes === 1;
  }
}

interface ProviderRow {
  id: string;
  kind: string;
  enabled: number;
  mode: ProviderMode;
  mode_explicit: number;
  poll_interval_seconds: number;
  config_json: string;
  config_version: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface ProviderStateRow {
  provider_id: string;
  health: ProviderHealth;
  observed_at_ms: number | null;
  stale_after_ms: number | null;
  observation_json: string | null;
  last_success_at_ms: number | null;
  last_error_code: string | null;
  updated_at_ms: number;
}

interface WindowSampleRow {
  id: number;
  provider_id: string;
  window_kind: string;
  observed_at_ms: number;
  phase: WindowPhase;
  phase_source: EvidenceSource | null;
  phase_confidence: Confidence | null;
  phase_observed_at_ms: number | null;
  started_at_ms: number | null;
  started_source: EvidenceSource | null;
  started_confidence: Confidence | null;
  started_observed_at_ms: number | null;
  reset_at_ms: number | null;
  reset_source: EvidenceSource | null;
  reset_confidence: Confidence | null;
  reset_observed_at_ms: number | null;
  duration_seconds: number | null;
  duration_source: EvidenceSource | null;
  duration_confidence: Confidence | null;
  duration_observed_at_ms: number | null;
  usage_ratio: number | null;
  usage_source: EvidenceSource | null;
  usage_confidence: Confidence | null;
  usage_observed_at_ms: number | null;
  remaining_ratio: number | null;
  remaining_source: EvidenceSource | null;
  remaining_confidence: Confidence | null;
  remaining_observed_at_ms: number | null;
}

interface EventRow {
  id: number;
  occurred_at_ms: number;
  provider_id: string | null;
  type: string;
  severity: EventSeverity;
  reason_code: string | null;
  data_json: string;
}

interface SettingRow {
  key: string;
  value_json: string;
  updated_at_ms: number;
}

interface SchedulePolicyRow {
  id: string;
  provider_id: string;
  scope: SchedulePolicyScope;
  requires_review: number;
  kind: SchedulePolicyKind;
  kind_explicit: number;
  enabled: number;
  timezone: string;
  config_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

interface ActionIntentRow {
  id: string;
  provider_id: string;
  policy_id: string | null;
  action_type: string;
  dedupe_key: string;
  state: ActionIntentState;
  scheduled_for_ms: number;
  not_before_ms: number | null;
  expires_at_ms: number | null;
  attempt_count: number;
  reason_code: string;
  explanation_json: string;
  last_error_code: string | null;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  updated_at_ms: number;
}

function providerFromRow(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled === 1,
    mode: row.mode,
    modeExplicit: row.mode_explicit === 1,
    pollIntervalSeconds: row.poll_interval_seconds,
    config: parseJson(row.config_json),
    configVersion: row.config_version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function providerStateFromRow(row: ProviderStateRow): ProviderStateRecord {
  return {
    providerId: row.provider_id,
    health: row.health,
    observedAtMs: row.observed_at_ms,
    staleAfterMs: row.stale_after_ms,
    observation: row.observation_json
      ? parseProviderObservation(parseJson(row.observation_json))
      : null,
    lastSuccessAtMs: row.last_success_at_ms,
    lastErrorCode: row.last_error_code,
    updatedAtMs: row.updated_at_ms,
  };
}

function snapshotToColumns(snapshot: WindowSnapshot): Record<string, string | number | null> {
  return {
    providerId: snapshot.providerId,
    windowKind: snapshot.windowKind,
    observedAtMs: epochMs(snapshot.observedAt),
    phase: snapshot.phase.value,
    phaseSource: snapshot.phase.source,
    phaseConfidence: snapshot.phase.confidence,
    phaseObservedAtMs: epochMs(snapshot.phase.observedAt),
    ...factColumns('started', snapshot.startedAt),
    ...factColumns('reset', snapshot.resetAt),
    ...factColumns('duration', snapshot.durationSeconds),
    ...factColumns('usage', snapshot.usageRatio),
    ...factColumns('remaining', snapshot.remainingRatio),
  };
}

function factColumns(
  prefix: string,
  fact: Fact<string | number> | undefined,
): Record<string, string | number | null> {
  return {
    [`${prefix}${prefix === 'duration' ? 'Seconds' : prefix === 'usage' ? 'Ratio' : prefix === 'remaining' ? 'Ratio' : 'AtMs'}`]:
      fact ? (typeof fact.value === 'string' ? epochMs(fact.value) : fact.value) : null,
    [`${prefix}Source`]: fact?.source ?? null,
    [`${prefix}Confidence`]: fact?.confidence ?? null,
    [`${prefix}ObservedAtMs`]: fact ? epochMs(fact.observedAt) : null,
  };
}

function windowSnapshotFromRow(row: WindowSampleRow): WindowSnapshot {
  const snapshot: WindowSnapshot = {
    providerId: row.provider_id,
    windowKind: row.window_kind,
    observedAt: instant(row.observed_at_ms),
    phase: {
      value: row.phase,
      source: row.phase_source ?? 'unknown',
      confidence: row.phase_confidence ?? 'unknown',
      observedAt: instant(row.phase_observed_at_ms ?? row.observed_at_ms),
    },
  };
  const startedAt = optionalInstantFact(
    row.started_at_ms,
    row.started_source,
    row.started_confidence,
    row.started_observed_at_ms,
    row.observed_at_ms,
  );
  if (startedAt) snapshot.startedAt = startedAt;
  const resetAt = optionalInstantFact(
    row.reset_at_ms,
    row.reset_source,
    row.reset_confidence,
    row.reset_observed_at_ms,
    row.observed_at_ms,
  );
  if (resetAt) snapshot.resetAt = resetAt;
  const durationSeconds = optionalNumberFact(
    row.duration_seconds,
    row.duration_source,
    row.duration_confidence,
    row.duration_observed_at_ms,
    row.observed_at_ms,
  );
  if (durationSeconds) snapshot.durationSeconds = durationSeconds;
  const usageRatio = optionalNumberFact(
    row.usage_ratio,
    row.usage_source,
    row.usage_confidence,
    row.usage_observed_at_ms,
    row.observed_at_ms,
  );
  if (usageRatio) snapshot.usageRatio = usageRatio;
  const remainingRatio = optionalNumberFact(
    row.remaining_ratio,
    row.remaining_source,
    row.remaining_confidence,
    row.remaining_observed_at_ms,
    row.observed_at_ms,
  );
  if (remainingRatio) snapshot.remainingRatio = remainingRatio;
  return WindowSnapshotSchema.parse(snapshot) as WindowSnapshot;
}

function optionalInstantFact(
  value: number | null,
  source: EvidenceSource | null,
  confidence: Confidence | null,
  observedAtMs: number | null,
  fallbackObservedAtMs: number,
): Fact<string> | undefined {
  if (value === null) return undefined;
  return {
    value: instant(value),
    source: source ?? 'unknown',
    confidence: confidence ?? 'unknown',
    observedAt: instant(observedAtMs ?? fallbackObservedAtMs),
  };
}

function optionalNumberFact(
  value: number | null,
  source: EvidenceSource | null,
  confidence: Confidence | null,
  observedAtMs: number | null,
  fallbackObservedAtMs: number,
): Fact<number> | undefined {
  if (value === null) return undefined;
  return {
    value,
    source: source ?? 'unknown',
    confidence: confidence ?? 'unknown',
    observedAt: instant(observedAtMs ?? fallbackObservedAtMs),
  };
}

function eventFromRow(row: EventRow): EventRecord {
  return {
    id: row.id,
    occurredAtMs: row.occurred_at_ms,
    providerId: row.provider_id,
    type: row.type,
    severity: row.severity,
    reasonCode: row.reason_code,
    data: parseJson(row.data_json),
  };
}

function schedulePolicyFromRow(row: SchedulePolicyRow): SchedulePolicyRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    scope: row.scope,
    requiresReview: row.requires_review === 1,
    kind: row.kind,
    kindExplicit: row.kind_explicit === 1,
    enabled: row.enabled === 1,
    timezone: row.timezone,
    config: parseJson(row.config_json),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function actionIntentFromRow(row: ActionIntentRow): ActionIntentRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    policyId: row.policy_id,
    actionType: row.action_type,
    dedupeKey: row.dedupe_key,
    state: row.state,
    scheduledForMs: row.scheduled_for_ms,
    notBeforeMs: row.not_before_ms,
    expiresAtMs: row.expires_at_ms,
    attemptCount: row.attempt_count,
    reasonCode: row.reason_code,
    explanation: parseJson(row.explanation_json),
    lastErrorCode: row.last_error_code,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function booleanToInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  return Math.max(1, Math.min(1000, Math.trunc(value)));
}

function boundedOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  return Math.max(0, Math.min(1_000_000, Math.trunc(value)));
}

function stringifyJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('storage JSON value cannot be undefined');
  return serialized;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function epochMs(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RangeError(`invalid UTC instant: ${value}`);
  return milliseconds;
}

function instant(value: number): string {
  return new Date(value).toISOString();
}
