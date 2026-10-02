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
import type { ProviderCleanupArtifactKind } from '../domain/provider-cleanup.js';
import type { SqliteDatabase } from './database.js';
import { WindowCycleRepository } from './window-cycles.js';
import { ACTION_DEADLINE_SQL } from '../domain/action-deadline.js';

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
  | 'resolved_unknown'
  | 'skipped'
  | 'canceled'
  | 'failed_retryable'
  | 'failed_terminal';
export type ProviderCleanupJobState = 'pending' | 'executing' | 'retryable';
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
  confirmationAttemptCount: number;
  confirmationNotBeforeMs: number | null;
  reasonCode: string;
  explanation: unknown;
  lastErrorCode: string | null;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  updatedAtMs: number;
}

/** Internal provider-side identifier; never include this record in a user-facing DTO. */
export interface ProviderCleanupJobRecord {
  id: string;
  providerId: string;
  artifactKind: ProviderCleanupArtifactKind;
  externalId: string;
  state: ProviderCleanupJobState;
  attemptCount: number;
  notBeforeMs: number;
  lastErrorCode: string | null;
  createdAtMs: number;
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
  windowCycles: WindowCycleRepository;
  providers: ProviderRepository;
  providerState: ProviderStateRepository;
  windowSamples: WindowSampleRepository;
  usageAggregation: UsageAggregationRepository;
  events: EventRepository;
  settings: SettingsRepository;
  schedulePolicies: SchedulePolicyRepository;
  actionIntents: ActionIntentRepository;
  providerCleanupJobs: ProviderCleanupJobRepository;
}

export function createRepositories(db: SqliteDatabase): StorageRepositories {
  return {
    windowCycles: new WindowCycleRepository(db),
    providers: new ProviderRepository(db),
    providerState: new ProviderStateRepository(db),
    windowSamples: new WindowSampleRepository(db),
    usageAggregation: new UsageAggregationRepository(db),
    events: new EventRepository(db),
    settings: new SettingsRepository(db),
    schedulePolicies: new SchedulePolicyRepository(db),
    actionIntents: new ActionIntentRepository(db),
    providerCleanupJobs: new ProviderCleanupJobRepository(db),
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
    smoothingBreakBefore: boolean;
  }> {
    if (!Number.isSafeInteger(buckets) || buckets < 1 || buckets > 63) {
      throw new RangeError('chart buckets must be between 1 and 63');
    }
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs <= fromMs) {
      throw new RangeError('chart range must be a positive UTC interval');
    }
    if (!Number.isSafeInteger(maxGapMs) || maxGapMs < 1) {
      throw new RangeError('chart gap threshold must be a positive safe integer');
    }
    const rows = this.db
      .prepare(
        `WITH deduplicated AS (
           SELECT id, observed_at_ms, usage_ratio, remaining_ratio,
                  ROW_NUMBER() OVER (PARTITION BY observed_at_ms ORDER BY id DESC) AS timestamp_rank
           FROM window_samples
           WHERE provider_id = @providerId AND window_kind = @windowKind
             AND observed_at_ms >= @fromMs AND observed_at_ms < @toMs
         ), known AS (
           SELECT id, observed_at_ms, usage_ratio, remaining_ratio
           FROM deduplicated
           WHERE timestamp_rank = 1 AND usage_ratio BETWEEN 0 AND 1
         ), sequenced AS (
           SELECT *,
             LAG(observed_at_ms) OVER (ORDER BY observed_at_ms, id) AS previous_at,
             LAG(usage_ratio) OVER (ORDER BY observed_at_ms, id) AS previous_usage
           FROM known
         ), classified AS (
           SELECT *,
             CASE WHEN previous_at IS NOT NULL AND observed_at_ms - previous_at > @maxGapMs THEN 1 ELSE 0 END AS gap_start,
             CASE WHEN previous_usage IS NOT NULL AND usage_ratio < previous_usage THEN 1 ELSE 0 END AS decrease_start
           FROM sequenced
         ), runs AS (
           SELECT *,
             SUM(gap_start) OVER (ORDER BY observed_at_ms, id) AS run_id,
             SUM(CASE WHEN gap_start = 1 OR decrease_start = 1 THEN 1 ELSE 0 END)
               OVER (ORDER BY observed_at_ms, id) AS smoothing_id,
             LEAD(decrease_start) OVER (ORDER BY observed_at_ms, id) AS before_decrease,
             CAST(MIN(@buckets - 1, ((observed_at_ms - @fromMs) * @buckets) / (@toMs - @fromMs)) AS INTEGER) AS bucket
           FROM classified
         ), ranked AS (
           SELECT *,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY observed_at_ms, id) AS bucket_first,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY observed_at_ms DESC, id DESC) AS bucket_last,
             ROW_NUMBER() OVER (PARTITION BY bucket, run_id ORDER BY observed_at_ms, id) AS run_first,
             ROW_NUMBER() OVER (PARTITION BY bucket, run_id ORDER BY observed_at_ms DESC, id DESC) AS run_last,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY usage_ratio, observed_at_ms, id) AS lowest,
             ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY usage_ratio DESC, observed_at_ms, id) AS highest
           FROM runs
         ), candidates AS (
           SELECT *, CASE
             WHEN bucket_first = 1 OR bucket_last = 1 THEN 0
             WHEN run_first = 1 OR run_last = 1 THEN 1
             WHEN decrease_start = 1 OR before_decrease = 1 THEN 2
             ELSE 3 END AS priority
           FROM ranked
           WHERE bucket_first = 1 OR bucket_last = 1 OR run_first = 1 OR run_last = 1
              OR decrease_start = 1 OR before_decrease = 1 OR lowest = 1 OR highest = 1
         ), selected AS (
           SELECT *, ROW_NUMBER() OVER
             (PARTITION BY bucket ORDER BY priority, observed_at_ms, id) AS choice
           FROM candidates
         )
         SELECT id, observed_at_ms, usage_ratio, remaining_ratio, run_id, smoothing_id
         FROM selected WHERE choice <= 6
         ORDER BY observed_at_ms, id`,
      )
      .all({
        providerId,
        windowKind,
        fromMs,
        toMs,
        buckets,
        maxGapMs,
      }) as Array<{
      id: number;
      observed_at_ms: number;
      usage_ratio: number | null;
      remaining_ratio: number | null;
      run_id: number;
      smoothing_id: number;
    }>;
    const points = rows.map((row, index) => ({
      id: row.id,
      observedAtMs: row.observed_at_ms,
      usageRatio: row.usage_ratio,
      remainingRatio: row.remaining_ratio,
      gapBefore: index > 0 && row.run_id !== rows[index - 1]!.run_id,
      smoothingBreakBefore: index > 0 && row.smoothing_id !== rows[index - 1]!.smoothing_id,
    }));
    // Retain a trailing unknown sample for the raw remaining summary. Interior
    // unknowns are intentionally omitted: valid endpoints determine continuity.
    const latest = this.db
      .prepare(
        `SELECT id, observed_at_ms, usage_ratio, remaining_ratio FROM window_samples
         WHERE provider_id = ? AND window_kind = ? AND observed_at_ms >= ? AND observed_at_ms < ?
         ORDER BY observed_at_ms DESC, id DESC LIMIT 1`,
      )
      .get(providerId, windowKind, fromMs, toMs) as
      | {
          id: number;
          observed_at_ms: number;
          usage_ratio: number | null;
          remaining_ratio: number | null;
        }
      | undefined;
    if (latest && latest.usage_ratio === null) {
      points.push({
        id: latest.id,
        observedAtMs: latest.observed_at_ms,
        usageRatio: null,
        remainingRatio: latest.remaining_ratio,
        gapBefore: false,
        smoothingBreakBefore: false,
      });
    }
    return points;
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

export class ProviderCleanupJobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  createIfAbsent(job: ProviderCleanupJobRecord): {
    created: boolean;
    job: ProviderCleanupJobRecord;
  } {
    validateCleanupArtifact(job.providerId, job.artifactKind, job.externalId);
    return withTransaction(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT INTO provider_cleanup_jobs (
            id, provider_id, artifact_kind, external_id, state, attempt_count,
            not_before_ms, last_error_code, created_at_ms, updated_at_ms
          ) VALUES (
            @id, @providerId, @artifactKind, @externalId, @state, @attemptCount,
            @notBeforeMs, @lastErrorCode, @createdAtMs, @updatedAtMs
          ) ON CONFLICT(provider_id, artifact_kind, external_id) DO NOTHING`,
        )
        .run(job);
      const stored = this.getByArtifact(job.providerId, job.artifactKind, job.externalId);
      if (!stored) throw new Error('provider cleanup job was not available after insert');
      return { created: result.changes === 1, job: stored };
    });
  }

  get(id: string): ProviderCleanupJobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM provider_cleanup_jobs WHERE id = ?').get(id) as
      ProviderCleanupJobRow | undefined;
    return row ? providerCleanupJobFromRow(row) : undefined;
  }

  listDue(nowMs: number, limit = 20): ProviderCleanupJobRecord[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db
      .prepare(
        `SELECT * FROM provider_cleanup_jobs
         WHERE state IN ('pending', 'retryable') AND not_before_ms <= ?
         ORDER BY not_before_ms, created_at_ms, id
         LIMIT ?`,
      )
      .all(nowMs, bounded) as ProviderCleanupJobRow[];
    return rows.map(providerCleanupJobFromRow);
  }

  hasOpenForProvider(providerId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM provider_cleanup_jobs
           WHERE provider_id = ? AND state IN ('pending', 'executing', 'retryable')
           LIMIT 1`,
        )
        .get(providerId) !== undefined
    );
  }

  claim(id: string, nowMs: number): ProviderCleanupJobRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE provider_cleanup_jobs
         SET state = 'executing', attempt_count = attempt_count + 1, updated_at_ms = @nowMs
         WHERE id = @id AND state IN ('pending', 'retryable') AND not_before_ms <= @nowMs`,
      )
      .run({ id, nowMs });
    return result.changes === 1 ? this.get(id) : undefined;
  }

  markRetryable(
    id: string,
    updatedAtMs: number,
    retryAtMs: number,
    lastErrorCode: string,
  ): boolean {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(lastErrorCode)) {
      throw new TypeError('provider cleanup error code is invalid');
    }
    return (
      this.db
        .prepare(
          `UPDATE provider_cleanup_jobs SET
             state = 'retryable', not_before_ms = @retryAtMs,
             last_error_code = @lastErrorCode, updated_at_ms = @updatedAtMs
           WHERE id = @id AND state = 'executing'`,
        )
        .run({ id, updatedAtMs, retryAtMs, lastErrorCode }).changes === 1
    );
  }

  recoverExecuting(nowMs: number): number {
    return this.db
      .prepare(
        `UPDATE provider_cleanup_jobs SET
           state = 'retryable', not_before_ms = @nowMs,
           last_error_code = 'CLEANUP_INTERRUPTED', updated_at_ms = @nowMs
         WHERE state = 'executing'`,
      )
      .run({ nowMs }).changes;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM provider_cleanup_jobs WHERE id = ?').run(id).changes === 1;
  }

  private getByArtifact(
    providerId: string,
    artifactKind: ProviderCleanupArtifactKind,
    externalId: string,
  ): ProviderCleanupJobRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM provider_cleanup_jobs
         WHERE provider_id = ? AND artifact_kind = ? AND external_id = ?`,
      )
      .get(providerId, artifactKind, externalId) as ProviderCleanupJobRow | undefined;
    return row ? providerCleanupJobFromRow(row) : undefined;
  }
}

export class ActionIntentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  resolutionRequest(id: string): ActionResolutionRequest | undefined {
    return this.db
      .prepare(
        `SELECT intent_id AS intentId, generation, state, reason_code AS reasonCode,
      requested_at_ms AS requestedAtMs, checked_at_ms AS checkedAtMs
      FROM action_resolution_requests WHERE intent_id = ?`,
      )
      .get(id) as ActionResolutionRequest | undefined;
  }

  requestResolution(
    id: string,
    nowMs: number,
  ): { created: boolean; request: ActionResolutionRequest } {
    return withTransaction(this.db, () => {
      const intent = this.get(id);
      if (!intent || intent.state !== 'uncertain') throw new Error('intent is not uncertain');
      const result = this.db
        .prepare(
          `INSERT INTO action_resolution_requests
        (intent_id, state, reason_code, requested_at_ms)
        VALUES (?, 'pending', 'ACTION_RESOLUTION_REQUESTED', ?)
        ON CONFLICT(intent_id) DO UPDATE SET generation = generation + 1, state = 'pending',
          reason_code = 'ACTION_RESOLUTION_REQUESTED', requested_at_ms = excluded.requested_at_ms, checked_at_ms = NULL
        WHERE action_resolution_requests.state = 'checked'
          AND action_resolution_requests.checked_at_ms <= excluded.requested_at_ms - 30000`,
        )
        .run(id, nowMs);
      if (result.changes === 1)
        this.db
          .prepare(
            `INSERT INTO events
        (occurred_at_ms, provider_id, type, severity, reason_code, data_json)
        VALUES (?, ?, 'action_resolution_requested', 'warn', 'ACTION_RESOLUTION_REQUESTED', ?)`,
          )
          .run(nowMs, intent.providerId, stringifyJson({ intentId: id }));
      return { created: result.changes === 1, request: this.resolutionRequest(id)! };
    });
  }

  completeResolutionRequest(
    request: ActionResolutionRequest,
    nowMs: number,
    reasonCode: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE action_resolution_requests SET state = 'checked', checked_at_ms = ?, reason_code = ?
      WHERE intent_id = ? AND generation = ? AND state = 'pending'`,
        )
        .run(nowMs, reasonCode, request.intentId, request.generation).changes === 1
    );
  }

  createIfAbsent(intent: ActionIntentRecord): { created: boolean; intent: ActionIntentRecord } {
    return withTransaction(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT INTO action_intents (
            id, provider_id, policy_id, action_type, dedupe_key, state,
            scheduled_for_ms, not_before_ms, expires_at_ms, attempt_count,
            confirmation_attempt_count, confirmation_not_before_ms,
            reason_code, explanation_json, last_error_code, created_at_ms,
            started_at_ms, finished_at_ms, updated_at_ms
          ) VALUES (
            @id, @providerId, @policyId, @actionType, @dedupeKey, @state,
            @scheduledForMs, @notBeforeMs, @expiresAtMs, @attemptCount,
            @confirmationAttemptCount, @confirmationNotBeforeMs,
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

  /** Bind only an unsent intent; never reconstruct a legacy side effect's cycle. */
  bindObservedCycle(
    intent: ActionIntentRecord,
    windowKind: string,
    cycleAtMs: number,
    nowMs: number,
  ): ActionIntentRecord | undefined {
    if (!Number.isSafeInteger(cycleAtMs) || !Number.isSafeInteger(nowMs))
      throw new RangeError('invalid observed cycle timestamp');
    const result = this.db
      .prepare(
        `UPDATE action_intents SET
          explanation_json = json_set(explanation_json, '$.observedCycleAt', @cycleAtIso),
          updated_at_ms = @nowMs
        WHERE id = @id AND provider_id = @providerId
          AND state IN ('planned', 'failed_retryable')
          AND updated_at_ms = @expectedUpdated
          AND explanation_json = @expectedExplanation
          AND json_type(explanation_json, '$.observedCycleAt') IS NULL
          AND json_extract(explanation_json, '$.windowKind') = @windowKind
          AND EXISTS (SELECT 1 FROM observed_window_cycles
            WHERE provider_id = @providerId AND window_kind = @windowKind
              AND cycle_at_ms = @cycleAtMs)`,
      )
      .run({
        id: intent.id,
        providerId: intent.providerId,
        expectedUpdated: intent.updatedAtMs,
        expectedExplanation: stringifyJson(intent.explanation),
        windowKind,
        cycleAtMs,
        cycleAtIso: new Date(cycleAtMs).toISOString(),
        nowMs,
      });
    return result.changes === 1 ? this.get(intent.id) : undefined;
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
      confirmationNotBeforeMs: null,
    });
  }

  /** Service must first verify a fresh matching closed-cycle observation. */
  resolveUnknownIfUncertain(
    intent: ActionIntentRecord,
    resolvedAtMs: number,
    verifiedAtMs: number,
  ): boolean {
    if (
      !Number.isSafeInteger(resolvedAtMs) ||
      !Number.isSafeInteger(verifiedAtMs) ||
      verifiedAtMs > resolvedAtMs
    )
      throw new RangeError('invalid action resolution timestamp');
    return withTransaction(this.db, () => {
      const closure = this.db
        .prepare(
          `SELECT cycle_at_ms AS cycleAtMs, ended_at_ms AS endedAtMs,
        observed_at_ms AS observedAtMs, window_kind AS windowKind
        FROM observed_cycle_closures WHERE intent_id = ? AND provider_id = ?`,
        )
        .get(intent.id, intent.providerId) as
        | { cycleAtMs: number; endedAtMs: number; observedAtMs: number; windowKind: string }
        | undefined;
      if (!closure || verifiedAtMs < closure.observedAtMs) return false;
      const result = this.db
        .prepare(
          `UPDATE action_intents SET state = 'resolved_unknown',
        finished_at_ms = @resolvedAtMs, updated_at_ms = @resolvedAtMs, confirmation_not_before_ms = NULL
        WHERE id = @id AND state = 'uncertain' AND updated_at_ms = @expectedUpdated
          AND confirmation_attempt_count = @expectedAttempts`,
        )
        .run({
          id: intent.id,
          resolvedAtMs,
          expectedUpdated: intent.updatedAtMs,
          expectedAttempts: intent.confirmationAttemptCount,
        });
      if (result.changes !== 1) return false;
      this.db
        .prepare(
          `INSERT INTO events (occurred_at_ms, provider_id, type, severity, reason_code, data_json)
        VALUES (?, ?, 'action_resolved_unknown', 'warn', 'ACTION_OUTCOME_UNKNOWN', ?)`,
        )
        .run(
          resolvedAtMs,
          intent.providerId,
          stringifyJson({
            intentId: intent.id,
            windowKind: closure.windowKind,
            cycleAtMs: closure.cycleAtMs,
            endedAtMs: closure.endedAtMs,
            verifiedAtMs,
            outcome: 'unknown',
          }),
        );
      return true;
    });
  }

  claimConfirmationAttempt(
    id: string,
    nowMs: number,
    nextEligibleAtMs: number,
  ): ActionIntentRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE action_intents SET
          confirmation_attempt_count = confirmation_attempt_count + 1,
          confirmation_not_before_ms = @nextEligibleAtMs,
          updated_at_ms = @nowMs
         WHERE id = @id
           AND state IN ('succeeded', 'uncertain')
           AND (
             confirmation_not_before_ms IS NULL
             OR confirmation_not_before_ms <= @nowMs
           )`,
      )
      .run({ id, nowMs, nextEligibleAtMs });
    return result.changes === 1 ? this.get(id) : undefined;
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

  markSkippedBeforeDispatch(id: string, updatedAtMs: number, reasonCode: string): boolean {
    return this.transition(id, ['executing'], 'skipped', updatedAtMs, {
      finishedAtMs: updatedAtMs,
      lastErrorCode: reasonCode,
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
           AND (
             action_type <> 'trigger_window'
             OR NOT EXISTS (
               SELECT 1 FROM action_intents AS other
               WHERE other.provider_id = action_intents.provider_id
                 AND other.action_type = 'trigger_window'
                 AND other.id <> action_intents.id
                 AND other.state IN (
                   'executing', 'succeeded', 'uncertain', 'failed_retryable', 'planned'
                 )
                 AND (
                   other.state IN ('executing', 'succeeded', 'uncertain')
                   OR (
                     action_intents.state = 'planned'
                     AND other.state = 'failed_retryable'
                   )
                   OR (
                     action_intents.state = 'planned'
                     AND other.state = 'planned'
                     AND (
                       other.scheduled_for_ms < action_intents.scheduled_for_ms
                       OR (
                         other.scheduled_for_ms = action_intents.scheduled_for_ms
                         AND other.id < action_intents.id
                       )
                     )
                   )
                   OR (
                     action_intents.state = 'failed_retryable'
                     AND other.state = 'failed_retryable'
                     AND (
                       other.scheduled_for_ms < action_intents.scheduled_for_ms
                       OR (
                         other.scheduled_for_ms = action_intents.scheduled_for_ms
                         AND other.id < action_intents.id
                       )
                     )
                   )
                 )
             )
           )
           AND (not_before_ms IS NULL OR not_before_ms <= @nowMs)
           AND ${ACTION_DEADLINE_SQL}`,
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
      confirmationNotBeforeMs?: number | null;
      finishedAtMs?: number | null;
    } = {},
  ): boolean {
    const placeholders = expectedStates.map((_state, index) => `@expected${index}`).join(', ');
    const result = this.db
      .prepare(
        `UPDATE action_intents SET
          state = @nextState,
          not_before_ms = CASE WHEN @hasNotBefore = 1 THEN @notBeforeMs ELSE not_before_ms END,
          confirmation_not_before_ms = CASE
            WHEN @hasConfirmationNotBefore = 1 THEN @confirmationNotBeforeMs
            ELSE confirmation_not_before_ms END,
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
        hasConfirmationNotBefore: Object.hasOwn(details, 'confirmationNotBeforeMs') ? 1 : 0,
        confirmationNotBeforeMs: details.confirmationNotBeforeMs ?? null,
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

export interface ActionResolutionRequest {
  intentId: string;
  generation: number;
  state: 'pending' | 'checked';
  reasonCode: string;
  requestedAtMs: number;
  checkedAtMs: number | null;
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
  confirmation_attempt_count: number;
  confirmation_not_before_ms: number | null;
  reason_code: string;
  explanation_json: string;
  last_error_code: string | null;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  updated_at_ms: number;
}

interface ProviderCleanupJobRow {
  id: string;
  provider_id: string;
  artifact_kind: ProviderCleanupArtifactKind;
  external_id: string;
  state: ProviderCleanupJobState;
  attempt_count: number;
  not_before_ms: number;
  last_error_code: string | null;
  created_at_ms: number;
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
    confirmationAttemptCount: row.confirmation_attempt_count,
    confirmationNotBeforeMs: row.confirmation_not_before_ms,
    reasonCode: row.reason_code,
    explanation: parseJson(row.explanation_json),
    lastErrorCode: row.last_error_code,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function providerCleanupJobFromRow(row: ProviderCleanupJobRow): ProviderCleanupJobRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    artifactKind: row.artifact_kind,
    externalId: row.external_id,
    state: row.state,
    attemptCount: row.attempt_count,
    notBeforeMs: row.not_before_ms,
    lastErrorCode: row.last_error_code,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function booleanToInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function validateCleanupArtifact(
  providerId: string,
  artifactKind: ProviderCleanupArtifactKind,
  externalId: string,
): void {
  const expectedProvider =
    artifactKind === 'codex_thread'
      ? 'codex'
      : artifactKind === 'antigravity_conversation'
        ? 'antigravity'
        : undefined;
  if (
    !expectedProvider ||
    providerId !== expectedProvider ||
    typeof externalId !== 'string' ||
    externalId.length < 1 ||
    externalId.length > 256 ||
    Array.from(externalId).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new TypeError('provider cleanup artifact is invalid');
  }
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
