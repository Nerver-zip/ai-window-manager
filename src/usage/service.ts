import { localDateAt, resolveLocalOccurrenceOnDate, shiftLocalDate } from '../scheduler/time.js';
import { classifyWindowCadence } from '../domain/window-target.js';
import type { SqliteDatabase } from '../storage/database.js';
import type { StorageRepositories } from '../storage/repositories.js';
import { withTransaction } from '../storage/repositories.js';
import { aggregateDailyUsage, transitionUsageSample, type DailyUsageCell } from './aggregation.js';

export const USAGE_AGGREGATION_BATCH_SIZE = 500;
export const USAGE_HEATMAP_DAYS = 365;
// Six selected endpoints/boundaries/extrema per bucket plus a possible trailing
// unknown reading stay below the 384-point chart budget.
export const USAGE_CHART_BUCKETS = 63;

export interface AggregationBatchResult {
  processed: number;
  lastSampleId: number;
  pending: boolean;
}

/** Process a bounded page; each interval and the corresponding cursor commit atomically. */
export function processUsageAggregationBatch(
  db: SqliteDatabase,
  repositories: StorageRepositories,
  nowMs: number,
  limit = USAGE_AGGREGATION_BATCH_SIZE,
): AggregationBatchResult {
  if (!Number.isSafeInteger(nowMs)) throw new RangeError('nowMs must be a safe integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new RangeError('aggregation batch size must be between 1 and 5000');
  }
  const checkpoint = repositories.usageAggregation.checkpoint();
  const samples = repositories.windowSamples.listForUsageAggregation(
    checkpoint.lastSampleId,
    limit,
  );
  if (samples.length === 0) {
    return { processed: 0, lastSampleId: checkpoint.lastSampleId, pending: false };
  }

  withTransaction(db, () => {
    for (const sample of samples) {
      const previous = repositories.usageAggregation.seriesState(
        sample.providerId,
        sample.windowKind,
      );
      const transition = transitionUsageSample(previous, sample);
      if (transition.interval) repositories.usageAggregation.insertInterval(transition.interval);
      repositories.usageAggregation.saveSeriesState(
        sample.providerId,
        sample.windowKind,
        transition.state,
        nowMs,
      );
    }
    repositories.usageAggregation.advanceCheckpoint(samples.at(-1)!.id, nowMs);
  });

  const lastSampleId = samples.at(-1)!.id;
  return {
    processed: samples.length,
    lastSampleId,
    pending: repositories.usageAggregation.maxSampleId() > lastSampleId,
  };
}

export interface UsageProviderOption {
  id: string;
  label: string;
  kind?: string;
  configured?: boolean;
  statusLabel?: string;
}

export interface UsageSeriesOption {
  providerId: string;
  windowKind: string;
}

export interface UsagePageData {
  timezone: string;
  today: string;
  fromDate: string;
  days: DailyUsageCell[];
  selectedDay: DailyUsageCell | null;
  providers: UsageProviderOption[];
  selectedProviderId: string | null;
  windows: UsageSeriesOption[];
  selectedWindowKind: string | null;
  aggregationPending: boolean;
  generatedAtMs: number;
}

export function readUsagePageData(input: {
  repositories: StorageRepositories;
  now: Date;
  timezone: string;
  providerId?: string;
  windowKind?: string;
  localDay?: string;
  visibleProviderIds?: ReadonlySet<string>;
  providers?: readonly UsageProviderOption[];
}): UsagePageData {
  const nowMs = input.now.getTime();
  const today = localDateAt(input.now, input.timezone);
  const fromDate = shiftLocalDate(today, -(USAGE_HEATMAP_DAYS - 1));
  const fromMs = resolveLocalOccurrenceOnDate({
    localDate: fromDate,
    localTime: '00:00',
    timeZone: input.timezone,
  }).instant.getTime();
  const toMs = resolveLocalOccurrenceOnDate({
    localDate: shiftLocalDate(today, 1),
    localTime: '00:00',
    timeZone: input.timezone,
  }).instant.getTime();
  const eligible = repositoriesVisibleBuckets(input.repositories, input.visibleProviderIds);
  const providerOptions = input.providers
    ? input.providers.filter(
        (provider) => !input.visibleProviderIds || input.visibleProviderIds.has(provider.id),
      )
    : [...new Set(eligible.map((item) => item.providerId))].map((id) => ({ id, label: id }));
  const selectedProviderId = providerOptions.some((provider) => provider.id === input.providerId)
    ? input.providerId!
    : (providerOptions[0]?.id ?? null);
  const windows = eligible.filter((item) => item.providerId === selectedProviderId);
  const selectedWindowKind = windows.some((item) => item.windowKind === input.windowKind)
    ? input.windowKind!
    : (windows.find((item) => classifyWindowCadence(item) === 'weekly')?.windowKind ??
      windows[0]?.windowKind ??
      null);
  const intervals =
    selectedProviderId && selectedWindowKind
      ? input.repositories.usageAggregation.listIntervals(
          selectedProviderId,
          selectedWindowKind,
          fromMs,
          toMs,
        )
      : [];
  const days =
    selectedProviderId && selectedWindowKind
      ? aggregateDailyUsage({
          intervals,
          fromLocalDate: fromDate,
          toLocalDate: today,
          timeZone: input.timezone,
          nowMs,
        })
      : [];
  const selectedDay = days.find((day) => day.localDate === (input.localDay ?? today)) ?? null;
  const checkpoint = input.repositories.usageAggregation.checkpoint();
  return {
    timezone: input.timezone,
    today,
    fromDate,
    days,
    selectedDay,
    providers: providerOptions,
    selectedProviderId,
    windows,
    selectedWindowKind,
    aggregationPending: input.repositories.usageAggregation.maxSampleId() > checkpoint.lastSampleId,
    generatedAtMs: nowMs,
  };
}

function repositoriesVisibleBuckets(
  repositories: StorageRepositories,
  visibleProviderIds?: ReadonlySet<string>,
): UsageSeriesOption[] {
  return repositories.usageAggregation
    .listBuckets()
    .filter((bucket) => !visibleProviderIds || visibleProviderIds.has(bucket.providerId));
}
