const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_CLOCK_JUMP_THRESHOLD_MS = MINUTE_MS;

const SAMPLE_OFFSETS_HOURS = Array.from({ length: 49 }, (_, index) => -72 + index * 3);

const formatterOptions: Intl.DateTimeFormatOptions = {
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

interface CalendarFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface SamplePoint {
  instantMs: number;
  offsetMs: number;
}

export interface LocalOccurrenceInput {
  /** Wall-clock time in the exact HH:mm format. */
  localTime: string;
  /** IANA timezone used for every calendar conversion. */
  timeZone: string;
  /** The local calendar date is taken from this instant in timeZone. */
  referenceInstant: Date;
}

export type LocalOccurrenceResolution =
  'exact' | 'nonexistent_shifted_to_next_valid' | 'ambiguous_earlier';

export interface LocalOccurrence {
  instant: Date;
  timeZone: string;
  localDate: string;
  requestedLocalTime: string;
  resolvedLocalTime: string;
  resolution: LocalOccurrenceResolution;
  wasAdjusted: boolean;
  wasAmbiguous: boolean;
}

export interface ClockSample {
  wallTime: Date;
  monotonicMs: number;
}

export interface ClockProgressComparison {
  wallElapsedMs: number;
  monotonicElapsedMs: number;
  skewMs: number;
  significant: boolean;
}

/**
 * Resolve a wall-clock occurrence on the reference instant's local calendar date.
 *
 * The runtime's IANA timezone database is used through Intl; the host timezone is
 * never consulted. A nonexistent local minute resolves to the first instant after
 * its forward gap. An ambiguous local minute resolves to the earlier instant.
 */
export function resolveLocalOccurrence(input: LocalOccurrenceInput): LocalOccurrence {
  const referenceMs = validDateMs(input.referenceInstant, 'referenceInstant');
  const { hour, minute } = parseLocalTime(input.localTime);
  const formatter = createFormatter(input.timeZone);
  const referenceFields = formatFields(formatter, referenceMs);
  const requestedFields: CalendarFields = {
    year: referenceFields.year,
    month: referenceFields.month,
    day: referenceFields.day,
    hour,
    minute,
    second: 0,
  };
  const requestedWallMs = calendarFieldsToUtcMs(requestedFields);
  const samplePoints = sampleTimeZoneOffsets(formatter, requestedWallMs);
  const offsets = [...new Set(samplePoints.map((point) => point.offsetMs))];
  const candidates = offsets
    .map((offsetMs) => requestedWallMs - offsetMs)
    .filter((instantMs) => fieldsEqual(formatFields(formatter, instantMs), requestedFields))
    .sort((left, right) => left - right);

  const localDate = formatLocalDate(referenceFields);
  if (candidates.length > 0) {
    const instantMs = candidates[0];
    if (instantMs === undefined) {
      throw new RangeError('Resolved local occurrence did not produce an instant');
    }
    const wasAmbiguous = candidates.length > 1;
    return {
      instant: new Date(instantMs),
      timeZone: input.timeZone,
      localDate,
      requestedLocalTime: input.localTime,
      resolvedLocalTime: formatLocalTime(formatFields(formatter, instantMs)),
      resolution: wasAmbiguous ? 'ambiguous_earlier' : 'exact',
      wasAdjusted: false,
      wasAmbiguous,
    };
  }

  const gap = findForwardGap(formatter, requestedWallMs, samplePoints);
  if (!gap) {
    throw new RangeError(
      `Local time ${input.localTime} cannot be resolved in timezone ${input.timeZone}`,
    );
  }

  return {
    instant: new Date(gap.transitionMs),
    timeZone: input.timeZone,
    localDate,
    requestedLocalTime: input.localTime,
    resolvedLocalTime: formatLocalTime(formatFields(formatter, gap.transitionMs)),
    resolution: 'nonexistent_shifted_to_next_valid',
    wasAdjusted: true,
    wasAmbiguous: false,
  };
}

/**
 * Compare elapsed wall-clock time with elapsed monotonic time.
 *
 * The caller chooses the threshold appropriate for its reconcile policy; this
 * helper only reports the measured skew and never changes scheduling state.
 */
export function compareWallAndMonotonicElapsed(
  previous: ClockSample,
  current: ClockSample,
  significantSkewMs = DEFAULT_CLOCK_JUMP_THRESHOLD_MS,
): ClockProgressComparison {
  const previousWallMs = validDateMs(previous.wallTime, 'previous.wallTime');
  const currentWallMs = validDateMs(current.wallTime, 'current.wallTime');
  if (!Number.isFinite(previous.monotonicMs) || !Number.isFinite(current.monotonicMs)) {
    throw new RangeError('monotonicMs values must be finite');
  }
  if (!Number.isFinite(significantSkewMs) || significantSkewMs < 0) {
    throw new RangeError('significantSkewMs must be a non-negative finite number');
  }

  const wallElapsedMs = currentWallMs - previousWallMs;
  const monotonicElapsedMs = current.monotonicMs - previous.monotonicMs;
  const skewMs = wallElapsedMs - monotonicElapsedMs;
  return {
    wallElapsedMs,
    monotonicElapsedMs,
    skewMs,
    significant: Math.abs(skewMs) > significantSkewMs,
  };
}

function parseLocalTime(value: string): Pick<CalendarFields, 'hour' | 'minute'> {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError('localTime must use the HH:mm format');

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new RangeError('localTime must be a valid 24-hour time');
  }
  return { hour, minute };
}

function createFormatter(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new RangeError('timeZone must be a non-empty IANA timezone');
  }
  try {
    return new Intl.DateTimeFormat('en-US', { ...formatterOptions, timeZone });
  } catch {
    throw new RangeError(`Invalid IANA timezone: ${timeZone}`);
  }
}

function formatFields(formatter: Intl.DateTimeFormat, instantMs: number): CalendarFields {
  const parts = new Map(
    formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]),
  );
  const fields = {
    year: numericPart(parts, 'year'),
    month: numericPart(parts, 'month'),
    day: numericPart(parts, 'day'),
    hour: numericPart(parts, 'hour'),
    minute: numericPart(parts, 'minute'),
    second: numericPart(parts, 'second'),
  };
  return fields;
}

function numericPart(parts: Map<string, string>, name: string): number {
  const value = parts.get(name);
  if (value === undefined) throw new RangeError(`Timezone formatter omitted ${name}`);
  const result = Number(value);
  if (!Number.isInteger(result))
    throw new RangeError(`Timezone formatter returned invalid ${name}`);
  return result;
}

function calendarFieldsToUtcMs(fields: CalendarFields): number {
  const date = new Date(
    Date.UTC(2000, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second),
  );
  date.setUTCFullYear(fields.year);
  const result = date.getTime();
  if (!Number.isFinite(result))
    throw new RangeError('Calendar date is outside the supported range');
  return result;
}

function sampleTimeZoneOffsets(formatter: Intl.DateTimeFormat, wallMs: number): SamplePoint[] {
  return SAMPLE_OFFSETS_HOURS.map((hours) => {
    const instantMs = wallMs + hours * HOUR_MS;
    return { instantMs, offsetMs: offsetAt(formatter, instantMs) };
  });
}

function offsetAt(formatter: Intl.DateTimeFormat, instantMs: number): number {
  const instantSecondMs = Math.floor(instantMs / 1000) * 1000;
  const localFields = formatFields(formatter, instantSecondMs);
  return calendarFieldsToUtcMs(localFields) - instantSecondMs;
}

function findForwardGap(
  formatter: Intl.DateTimeFormat,
  wallMs: number,
  samplePoints: SamplePoint[],
): { transitionMs: number } | undefined {
  for (let index = 1; index < samplePoints.length; index += 1) {
    const before = samplePoints[index - 1];
    const after = samplePoints[index];
    if (!before || !after) continue;
    if (after.offsetMs <= before.offsetMs) continue;

    const transitionMs = findTransition(formatter, before, after);
    const gapStartWallMs = transitionMs + before.offsetMs;
    const gapEndWallMs = transitionMs + after.offsetMs;
    if (wallMs >= gapStartWallMs && wallMs < gapEndWallMs) {
      return { transitionMs };
    }
  }
  return undefined;
}

function findTransition(
  formatter: Intl.DateTimeFormat,
  before: SamplePoint,
  after: SamplePoint,
): number {
  let low = before.instantMs;
  let high = after.instantMs;
  while (high - low > 1_000) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(formatter, middle) === before.offsetMs) low = middle;
    else high = middle;
  }
  return high;
}

function fieldsEqual(left: CalendarFields, right: CalendarFields): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function formatLocalDate(fields: CalendarFields): string {
  return `${fields.year.toString().padStart(4, '0')}-${fields.month
    .toString()
    .padStart(2, '0')}-${fields.day.toString().padStart(2, '0')}`;
}

function formatLocalTime(fields: CalendarFields): string {
  return `${fields.hour.toString().padStart(2, '0')}:${fields.minute.toString().padStart(2, '0')}`;
}

function validDateMs(value: Date, name: string): number {
  const result = value.getTime();
  if (!Number.isFinite(result)) throw new RangeError(`${name} must be a valid Date`);
  return result;
}
