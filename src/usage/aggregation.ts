import { localDateAt, resolveLocalOccurrenceOnDate, shiftLocalDate } from '../scheduler/time.js';

export const WEEK_SECONDS = 7 * 24 * 60 * 60;
export const USAGE_INTERVAL_MAX_MS = 15 * 60 * 1000;
export const USAGE_ALGORITHM_VERSION = 1;

export type UsageIntervalQuality = 'observed' | 'partial' | 'unknown';

export interface UsageSampleInput {
  id: number;
  providerId: string;
  windowKind: string;
  observedAtMs: number;
  durationSeconds: number | null;
  durationConfidence: string | null;
  resetAtMs: number | null;
  resetConfidence: string | null;
  usageRatio: number | null;
  usageConfidence: string | null;
  usageObservedAtMs: number | null;
}

export interface UsageSeriesState {
  version: number;
  lastSampleId: number;
  lastObservedAtMs: number;
  lastUsageRatio: number;
  highWaterRatio: number;
  durationSeconds: number;
  resetAtMs: number | null;
}

export interface UsageInterval {
  sourceSampleId: number;
  providerId: string;
  windowKind: string;
  fromMs: number;
  toMs: number;
  usageDeltaRatio: number | null;
  quality: UsageIntervalQuality;
  reasonCode: string | null;
}

export interface UsageTransition {
  state: UsageSeriesState | null;
  interval?: UsageInterval;
}

function trusted(confidence: string | null): boolean {
  return confidence === 'exact' || confidence === 'high';
}

function trustworthyReset(sample: UsageSampleInput): number | null {
  if (
    sample.resetAtMs === null ||
    !trusted(sample.resetConfidence) ||
    sample.resetAtMs <= sample.observedAtMs
  ) {
    return null;
  }
  return sample.resetAtMs;
}

function interval(
  sample: UsageSampleInput,
  fromMs: number,
  toMs: number,
  usageDeltaRatio: number | null,
  quality: UsageIntervalQuality,
  reasonCode: string | null,
): UsageInterval {
  return {
    sourceSampleId: sample.id,
    providerId: sample.providerId,
    windowKind: sample.windowKind,
    fromMs,
    toMs,
    usageDeltaRatio,
    quality,
    reasonCode,
  };
}

/**
 * Convert one persisted cumulative weekly-usage observation into a durable
 * positive delta. A falling counter is never interpreted as a reset unless the
 * previously reported weekly boundary has passed and a new future boundary is
 * present. This is deliberately conservative when observations are missing.
 */
export function transitionUsageSample(
  previous: UsageSeriesState | null,
  sample: UsageSampleInput,
): UsageTransition {
  const observedAtMs = sample.observedAtMs;
  const duration =
    sample.durationSeconds !== null && trusted(sample.durationConfidence)
      ? sample.durationSeconds
      : previous?.durationSeconds;
  const isWeekly = duration === WEEK_SECONDS;

  if (!isWeekly) {
    if (!previous) return { state: null };
    return {
      state: null,
      interval: interval(
        sample,
        previous.lastObservedAtMs,
        Math.max(previous.lastObservedAtMs, observedAtMs),
        null,
        'unknown',
        'WINDOW_DURATION_CHANGED',
      ),
    };
  }

  const usageIsFresh =
    sample.usageRatio !== null &&
    Number.isFinite(sample.usageRatio) &&
    sample.usageRatio >= 0 &&
    sample.usageRatio <= 1 &&
    trusted(sample.usageConfidence) &&
    sample.usageObservedAtMs !== null &&
    sample.usageObservedAtMs <= observedAtMs &&
    observedAtMs - sample.usageObservedAtMs <= USAGE_INTERVAL_MAX_MS;

  if (!usageIsFresh || sample.usageRatio === null) {
    return {
      state: previous,
      ...(previous
        ? {
            interval: interval(
              sample,
              previous.lastObservedAtMs,
              Math.max(previous.lastObservedAtMs, observedAtMs),
              null,
              'unknown',
              'WEEKLY_USAGE_UNAVAILABLE',
            ),
          }
        : {}),
    };
  }

  const currentUsage = sample.usageRatio;
  const resetAtMs = trustworthyReset(sample);
  if (!previous) {
    return {
      state: {
        version: USAGE_ALGORITHM_VERSION,
        lastSampleId: sample.id,
        lastObservedAtMs: observedAtMs,
        lastUsageRatio: currentUsage,
        highWaterRatio: currentUsage,
        durationSeconds: WEEK_SECONDS,
        resetAtMs,
      },
    };
  }

  if (observedAtMs < previous.lastObservedAtMs) {
    return {
      state: previous,
      interval: interval(
        sample,
        observedAtMs,
        observedAtMs,
        null,
        'unknown',
        'OUT_OF_ORDER_SAMPLE',
      ),
    };
  }
  if (observedAtMs === previous.lastObservedAtMs) {
    return {
      state: previous,
      interval: interval(
        sample,
        observedAtMs,
        observedAtMs,
        null,
        'unknown',
        'CONFLICTING_SAMPLE_TIMESTAMP',
      ),
    };
  }

  const resetWasObserved =
    previous.resetAtMs !== null &&
    previous.resetAtMs <= observedAtMs &&
    resetAtMs !== null &&
    resetAtMs > observedAtMs &&
    resetAtMs > previous.resetAtMs;

  if (resetWasObserved && previous.resetAtMs !== null) {
    const elapsedFromBoundary = observedAtMs - previous.resetAtMs;
    const boundaryCanBeAttributed = elapsedFromBoundary <= WEEK_SECONDS * 1000;
    const nextState: UsageSeriesState = {
      version: USAGE_ALGORITHM_VERSION,
      lastSampleId: sample.id,
      lastObservedAtMs: observedAtMs,
      lastUsageRatio: currentUsage,
      highWaterRatio: currentUsage,
      durationSeconds: WEEK_SECONDS,
      resetAtMs,
    };
    return {
      state: nextState,
      interval: interval(
        sample,
        previous.resetAtMs,
        observedAtMs,
        boundaryCanBeAttributed ? currentUsage : null,
        boundaryCanBeAttributed ? 'partial' : 'unknown',
        boundaryCanBeAttributed ? 'WEEKLY_RESET_CONFIRMED' : 'MULTIPLE_CYCLES_UNOBSERVED',
      ),
    };
  }

  const correction = currentUsage < previous.highWaterRatio;
  const gapMs = observedAtMs - previous.lastObservedAtMs;
  const delta = correction ? 0 : currentUsage - previous.highWaterRatio;
  const nextState: UsageSeriesState = {
    version: USAGE_ALGORITHM_VERSION,
    lastSampleId: sample.id,
    lastObservedAtMs: observedAtMs,
    lastUsageRatio: currentUsage,
    highWaterRatio: Math.max(previous.highWaterRatio, currentUsage),
    durationSeconds: WEEK_SECONDS,
    resetAtMs: resetAtMs ?? previous.resetAtMs,
  };
  return {
    state: nextState,
    interval: interval(
      sample,
      previous.lastObservedAtMs,
      observedAtMs,
      delta,
      correction || gapMs > USAGE_INTERVAL_MAX_MS ? 'partial' : 'observed',
      correction ? 'COUNTER_CORRECTION' : gapMs > USAGE_INTERVAL_MAX_MS ? 'OBSERVATION_GAP' : null,
    ),
  };
}

export interface DailyUsageInterval {
  fromMs: number;
  toMs: number;
  usageDeltaRatio: number | null;
  quality: UsageIntervalQuality;
  reasonCode: string | null;
}

export interface DailyUsageCell {
  localDate: string;
  usagePercentagePoints: number | null;
  status: 'no_data' | 'partial' | 'observed';
  coverageSeconds: number;
  daySeconds: number;
  reasons: string[];
}

interface MutableDay {
  usage: number;
  coverageMs: number;
  firstCoverageMs: number | null;
  lastCoverageMs: number | null;
  partial: boolean;
  hasData: boolean;
  reasons: Set<string>;
}

const dayStartFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dayStartMs(localDate: string, timeZone: string): number {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!dateMatch) throw new RangeError('localDate must use YYYY-MM-DD');
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const wallMs = Date.UTC(year, month - 1, day);
  const check = new Date(wallMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError('localDate must be a valid calendar date');
  }
  let formatter = dayStartFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dayStartFormatterCache.set(timeZone, formatter);
  }
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const instantMs = wallMs + hours * 60 * 60 * 1000;
    const fields = localFields(formatter, instantMs);
    offsets.add(
      Date.UTC(
        fields.year,
        fields.month - 1,
        fields.day,
        fields.hour,
        fields.minute,
        fields.second,
      ) - instantMs,
    );
  }
  const candidates = [...offsets]
    .map((offset) => wallMs - offset)
    .filter((instantMs) => {
      const fields = localFields(formatter, instantMs);
      return (
        fields.year === year &&
        fields.month === month &&
        fields.day === day &&
        fields.hour === 0 &&
        fields.minute === 0 &&
        fields.second === 0
      );
    })
    .sort((left, right) => left - right);
  if (candidates[0] !== undefined) return candidates[0];
  return resolveLocalOccurrenceOnDate({
    localDate,
    localTime: '00:00',
    timeZone,
  }).instant.getTime();
}

function localFields(
  formatter: Intl.DateTimeFormat,
  instantMs: number,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Map(
    formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.get('year')!,
    month: parts.get('month')!,
    day: parts.get('day')!,
    hour: parts.get('hour')!,
    minute: parts.get('minute')!,
    second: parts.get('second')!,
  };
}

/** Project UTC contribution intervals onto calendar dates in the saved IANA zone. */
export function aggregateDailyUsage(input: {
  intervals: readonly DailyUsageInterval[];
  fromLocalDate: string;
  toLocalDate: string;
  timeZone: string;
  nowMs: number;
}): DailyUsageCell[] {
  const days: Array<{ localDate: string; startMs: number; endMs: number; state: MutableDay }> = [];
  for (
    let date = input.fromLocalDate, count = 0;
    date <= input.toLocalDate && count < 370;
    date = shiftLocalDate(date, 1), count += 1
  ) {
    const startMs = dayStartMs(date, input.timeZone);
    days.push({
      localDate: date,
      startMs,
      endMs: dayStartMs(shiftLocalDate(date, 1), input.timeZone),
      state: {
        usage: 0,
        coverageMs: 0,
        firstCoverageMs: null,
        lastCoverageMs: null,
        partial: false,
        hasData: false,
        reasons: new Set(),
      },
    });
  }

  for (const item of input.intervals) {
    const firstIndex = findDayIndex(days, item.fromMs);
    if (firstIndex < 0) continue;
    const lastIndex = findDayIndex(days, Math.max(item.fromMs, item.toMs - 1));
    if (lastIndex < 0) continue;
    const dayIndexes = Array.from({ length: lastIndex - firstIndex + 1 }, (_, i) => firstIndex + i);
    if (item.quality === 'unknown' || item.usageDeltaRatio === null) {
      for (const index of dayIndexes) {
        const day = days[index]!.state;
        day.partial = true;
        if (item.reasonCode) day.reasons.add(item.reasonCode);
      }
      continue;
    }

    if (item.quality === 'observed' && item.toMs > item.fromMs) {
      const totalMs = item.toMs - item.fromMs;
      for (const index of dayIndexes) {
        const dayRecord = days[index]!;
        const dayStart = dayRecord.startMs;
        const dayEnd = dayRecord.endMs;
        const overlapStart = Math.max(item.fromMs, dayStart);
        const overlapEnd = Math.min(item.toMs, dayEnd);
        const overlapMs = Math.max(0, overlapEnd - overlapStart);
        if (overlapMs <= 0) continue;
        const day = dayRecord.state;
        day.hasData = true;
        day.coverageMs += overlapMs;
        day.firstCoverageMs = Math.min(day.firstCoverageMs ?? overlapStart, overlapStart);
        day.lastCoverageMs = Math.max(day.lastCoverageMs ?? overlapEnd, overlapEnd);
        day.usage += (item.usageDeltaRatio * overlapMs) / totalMs;
      }
      continue;
    }

    if (dayIndexes.length === 1) {
      const day = days[dayIndexes[0]!]!.state;
      day.hasData = true;
      day.partial = true;
      day.usage += item.usageDeltaRatio;
      if (item.reasonCode) day.reasons.add(item.reasonCode);
      continue;
    }

    for (const index of dayIndexes) {
      const day = days[index]!.state;
      day.partial = true;
      if (item.reasonCode) day.reasons.add(item.reasonCode);
    }
  }

  return days.map(({ localDate, startMs, endMs, state: day }) => {
    const effectiveEndMs = Math.min(endMs, input.nowMs);
    const dayMs = Math.max(0, effectiveEndMs - startMs);
    const leadingGap = day.firstCoverageMs === null ? dayMs : day.firstCoverageMs - startMs;
    const trailingGap = day.lastCoverageMs === null ? dayMs : effectiveEndMs - day.lastCoverageMs;
    const complete =
      dayMs > 0 &&
      day.coverageMs >= dayMs * 0.8 &&
      leadingGap <= USAGE_INTERVAL_MAX_MS &&
      trailingGap <= USAGE_INTERVAL_MAX_MS &&
      !day.partial;
    const isToday = localDate === localDateAt(new Date(input.nowMs), input.timeZone);
    const status =
      !day.hasData && !day.partial ? 'no_data' : complete && !isToday ? 'observed' : 'partial';
    return {
      localDate,
      usagePercentagePoints: day.hasData ? day.usage * 100 : null,
      status,
      coverageSeconds: Math.round(day.coverageMs / 1000),
      daySeconds: Math.round(dayMs / 1000),
      reasons: [...day.reasons].sort(),
    };
  });
}

function findDayIndex(
  days: readonly { startMs: number; endMs: number }[],
  instantMs: number,
): number {
  let low = 0;
  let high = days.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const day = days[middle]!;
    if (instantMs < day.startMs) high = middle - 1;
    else if (instantMs >= day.endMs) low = middle + 1;
    else return middle;
  }
  return -1;
}
