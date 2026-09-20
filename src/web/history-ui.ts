/**
 * Pure SSR helpers for the bounded history view.
 *
 * The route integration owns database reads and must pass already-sanitized
 * provider keys, events, and window samples. This module deliberately accepts
 * no repository or provider dependencies and never renders arbitrary event
 * payloads.
 */

export const HISTORY_RANGES = [
  { value: '24h', label: '24h', durationMs: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', durationMs: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type HistoryRange = (typeof HISTORY_RANGES)[number]['value'];
export type HistorySeverity = 'debug' | 'info' | 'warn' | 'error';

export const MAX_HISTORY_EVENTS = 100;
export const MAX_USAGE_SERIES = 16;
export const MAX_USAGE_POINTS = 96;

export interface HistoryProviderOption {
  id: string;
  label?: string;
}

/** The only event fields consumed by the renderer. Raw event data is excluded. */
export interface HistoryTimelineEvent {
  id: number;
  occurredAt: string;
  providerId: string | null;
  type: string;
  severity: HistorySeverity;
  reasonCode: string | null;
}

/** A sanitized projection of a persisted window sample for the usage graph. */
export interface HistoryUsageSample {
  providerId: string;
  windowKind: string;
  observedAt: string;
  usageRatio?: number | null;
  remainingRatio?: number | null;
}

export interface HistoryFilter {
  range: HistoryRange;
  providerId?: string;
}

export interface HistoryTimelineItem extends HistoryTimelineEvent {
  displayType: string;
  displaySeverity: HistorySeverity;
  displayReason: string;
}

export interface HistoryUsagePoint {
  observedAt: string;
  usageRatio: number | null;
  remainingRatio: number | null;
}

export interface HistoryUsageSeries {
  providerId: string;
  windowKind: string;
  points: HistoryUsagePoint[];
}

export interface HistoryPageInput {
  now: Date;
  filter?: { range?: unknown; providerId?: unknown };
  providers: readonly HistoryProviderOption[];
  events: readonly HistoryTimelineEvent[];
  samples: readonly HistoryUsageSample[];
}

export interface BoundedHistoryView {
  range: HistoryRange;
  providerId: string | null;
  events: HistoryTimelineItem[];
  series: HistoryUsageSeries[];
}

const EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  action_claimed: 'Action claimed',
  action_confirmed: 'Action confirmed',
  action_intent_planned: 'Action intent planned',
  action_succeeded: 'Action succeeded',
  action_uncertain: 'Action outcome uncertain',
  provider_inspected: 'Provider inspected',
  provider_inspection_failed: 'Provider inspection failed',
  provider_auth_required: 'Provider authentication required',
  schedule_missed: 'Schedule missed',
  scheduler_noop: 'Scheduler decision',
  settings_changed: 'Settings changed',
  schedule_changed: 'Schedule changed',
};

const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_WINDOW_KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeHistoryRange(value: unknown): HistoryRange {
  return isHistoryRange(value) ? value : '24h';
}

export function getHistoryRange(value: HistoryRange) {
  return HISTORY_RANGES.find((range) => range.value === value) ?? HISTORY_RANGES[0];
}

export function filterHistoryEvents(
  events: readonly HistoryTimelineEvent[],
  now: Date,
  filter: HistoryFilter,
): HistoryTimelineItem[] {
  const range = getHistoryRange(filter.range);
  const nowMs = now.getTime();
  const fromMs = nowMs - range.durationMs;

  return events
    .map(sanitizeEvent)
    .filter((event): event is HistoryTimelineItem => event !== null)
    .filter((event) => {
      const occurredAtMs = Date.parse(event.occurredAt);
      if (!Number.isFinite(occurredAtMs)) return false;
      if (occurredAtMs < fromMs || occurredAtMs > nowMs) return false;
      return filter.providerId === undefined || event.providerId === filter.providerId;
    })
    .sort((left, right) => {
      const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
      return byTime || right.id - left.id;
    })
    .slice(0, MAX_HISTORY_EVENTS);
}

export function buildUsageSeries(
  samples: readonly HistoryUsageSample[],
  now: Date,
  filter: HistoryFilter,
): HistoryUsageSeries[] {
  const range = getHistoryRange(filter.range);
  const nowMs = now.getTime();
  const fromMs = nowMs - range.durationMs;
  const grouped = new Map<string, HistoryUsageSeries>();

  for (const sample of samples) {
    const providerId = safeProviderId(sample.providerId);
    const windowKind = safeWindowKind(sample.windowKind);
    const observedAtMs = Date.parse(sample.observedAt);
    if (
      providerId === null ||
      windowKind === null ||
      !Number.isFinite(observedAtMs) ||
      observedAtMs < fromMs ||
      observedAtMs > nowMs ||
      (filter.providerId !== undefined && providerId !== filter.providerId)
    ) {
      continue;
    }

    const key = `${providerId}\u0000${windowKind}`;
    const series = grouped.get(key) ?? { providerId, windowKind, points: [] };
    series.points.push({
      observedAt: new Date(observedAtMs).toISOString(),
      usageRatio: ratioOrNull(sample.usageRatio),
      remainingRatio: ratioOrNull(sample.remainingRatio),
    });
    grouped.set(key, series);
  }

  return [...grouped.values()]
    .map((series) => ({
      ...series,
      points: series.points
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
        .slice(-MAX_USAGE_POINTS),
    }))
    .sort((left, right) =>
      `${left.providerId}\u0000${left.windowKind}`.localeCompare(
        `${right.providerId}\u0000${right.windowKind}`,
      ),
    )
    .slice(0, MAX_USAGE_SERIES);
}

export function buildBoundedHistoryView(input: HistoryPageInput): BoundedHistoryView {
  const range = normalizeHistoryRange(input.filter?.range);
  const providerId = normalizeProviderFilter(input.filter?.providerId);
  const filter: HistoryFilter = { range, ...(providerId ? { providerId } : {}) };
  return {
    range,
    providerId: providerId ?? null,
    events: filterHistoryEvents(input.events, input.now, filter),
    series: buildUsageSeries(input.samples, input.now, filter),
  };
}

export function renderHistoryPage(input: HistoryPageInput): string {
  const view = buildBoundedHistoryView(input);
  const providers = safeProviderOptions(input.providers);
  const selectedProvider = view.providerId ?? '';
  const rangeOptions = HISTORY_RANGES.map(
    (range) =>
      `<option value="${range.value}"${range.value === view.range ? ' selected' : ''}>${range.label}</option>`,
  ).join('');
  const providerOptions = [
    '<option value="">All providers</option>',
    ...providers.map(
      (provider) =>
        `<option value="${escapeAttribute(provider.id)}"${
          provider.id === selectedProvider ? ' selected' : ''
        }>${escapeHtml(provider.label)}</option>`,
    ),
  ].join('');

  return pageDocument(
    'History',
    `<main class="history-shell">
      <header><h1>History</h1><p class="muted">Bounded persisted observations and decisions.</p></header>
      <form class="history-filter" method="get" action="/history">
        <label>Range <select name="range">${rangeOptions}</select></label>
        <label>Provider <select name="provider">${providerOptions}</select></label>
        <button type="submit">Apply</button>
      </form>
      ${renderTimeline(view.events)}
      ${renderUsageSeries(view.series)}
    </main>`,
  );
}

export function renderTimeline(
  events: readonly (HistoryTimelineItem | HistoryTimelineEvent)[],
): string {
  const safeEvents = events
    .map((event) => ('displayType' in event ? event : sanitizeEvent(event)))
    .filter((event): event is HistoryTimelineItem => event !== null);
  if (safeEvents.length === 0) {
    return '<section aria-labelledby="timeline-title"><h2 id="timeline-title">Timeline</h2><p class="unknown">unknown — no events in this range.</p></section>';
  }

  const items = safeEvents
    .slice(0, MAX_HISTORY_EVENTS)
    .map(
      (event) => `<li class="event event-${event.displaySeverity}">
        <time datetime="${escapeAttribute(event.occurredAt)}">${escapeHtml(
          formatTimestamp(event.occurredAt),
        )}</time>
        <strong>${escapeHtml(event.displayType)}</strong>
        <span class="severity">${escapeHtml(event.displaySeverity)}</span>
        <span class="reason">${escapeHtml(event.displayReason)}</span>
        <span class="provider">${escapeHtml(event.providerId ?? 'unknown')}</span>
      </li>`,
    )
    .join('');
  return `<section aria-labelledby="timeline-title"><h2 id="timeline-title">Timeline</h2><ol class="timeline">${items}</ol></section>`;
}

export function renderUsageSeries(series: readonly HistoryUsageSeries[]): string {
  if (series.length === 0) {
    return '<section aria-labelledby="usage-title"><h2 id="usage-title">Usage</h2><p class="unknown">unknown — no usage samples in this range.</p></section>';
  }

  const charts = series
    .slice(0, MAX_USAGE_SERIES)
    .map((item) => renderUsageChart(item))
    .join('');
  return `<section aria-labelledby="usage-title"><h2 id="usage-title">Usage</h2><div class="usage-grid">${charts}</div></section>`;
}

function renderUsageChart(series: HistoryUsageSeries): string {
  const points = series.points.slice(-MAX_USAGE_POINTS);
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [];
  points.forEach((point, index) => {
    if (point.usageRatio === null) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
      return;
    }
    segment.push({ x: chartX(index, points.length), y: chartY(point.usageRatio) });
  });
  if (segment.length > 0) segments.push(segment);
  const polyline = segments
    .map(
      (plotted) =>
        `<polyline class="usage-line" points="${plotted
          .map((point) => `${point.x},${point.y}`)
          .join(' ')}" />`,
    )
    .join('');
  const unknownCount = points.filter((point) => point.usageRatio === null).length;
  const latestPoint = [...points].reverse().find((point) => point.usageRatio !== null);
  const latest = latestPoint?.usageRatio;
  const latestText =
    latest === undefined || latest === null ? 'unknown' : `${Math.round(latest * 100)}%`;
  const unknownText = unknownCount > 0 ? `; ${unknownCount} unknown` : '';

  return `<article class="usage-card">
    <h3>${escapeHtml(series.providerId)} / ${escapeHtml(series.windowKind)}</h3>
    <p>Latest usage: <strong>${escapeHtml(latestText)}</strong>${escapeHtml(unknownText)}</p>
    <div class="chart-scroll"><svg viewBox="0 0 320 96" role="img" aria-label="Usage series for ${escapeAttribute(
      `${series.providerId} ${series.windowKind}`,
    )}"><line class="usage-gridline" x1="0" y1="8" x2="320" y2="8" /><line class="usage-gridline" x1="0" y1="48" x2="320" y2="48" /><line class="usage-gridline" x1="0" y1="88" x2="320" y2="88" />${polyline}</svg></div>
    <p class="chart-legend">0% to 100%; missing values remain <span class="unknown">unknown</span>.</p>
  </article>`;
}

function sanitizeEvent(event: HistoryTimelineEvent): HistoryTimelineItem | null {
  const occurredAtMs = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAtMs)) return null;
  const severity = safeSeverity(event.severity);
  const type = safeCode(event.type);
  const reason = event.reasonCode === null ? null : safeCode(event.reasonCode);
  const providerId = event.providerId === null ? null : safeProviderId(event.providerId);
  return {
    id: Number.isSafeInteger(event.id) && event.id >= 0 ? event.id : 0,
    occurredAt: new Date(occurredAtMs).toISOString(),
    providerId,
    type: type ?? 'unknown',
    severity,
    reasonCode: reason,
    displayType: (type && EVENT_TYPE_LABELS[type]) ?? humanizeCode(type),
    displaySeverity: severity,
    displayReason: reason ?? 'unknown',
  };
}

function safeProviderOptions(
  providers: readonly HistoryProviderOption[],
): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  return providers.flatMap((provider) => {
    const id = safeProviderId(provider.id);
    if (id === null || seen.has(id)) return [];
    seen.add(id);
    const label = safeDisplayText(provider.label ?? id);
    return [{ id, label: label || id }];
  });
}

function safeSeverity(value: unknown): HistorySeverity {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : 'info';
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : null;
}

function safeProviderId(value: unknown): string | null {
  return typeof value === 'string' && SAFE_PROVIDER_ID.test(value) ? value : null;
}

function safeWindowKind(value: unknown): string | null {
  return typeof value === 'string' && SAFE_WINDOW_KIND.test(value) ? value : null;
}

function safeDisplayText(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(code <= 0x1f || code === 0x7f);
    })
    .join('')
    .slice(0, 96);
}

function ratioOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function normalizeProviderFilter(value: unknown): string | undefined {
  const provider = safeProviderId(value);
  return provider ?? undefined;
}

function humanizeCode(value: string | null): string {
  if (value === null) return 'Unknown event';
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .slice(0, 96);
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : 'unknown';
}

function chartX(index: number, length: number): number {
  return length <= 1 ? 160 : Math.round((index / (length - 1)) * 320);
}

function chartY(value: number): number {
  return Math.round(88 - value * 80);
}

function isHistoryRange(value: unknown): value is HistoryRange {
  return value === '24h' || value === '7d' || value === '30d';
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function escapeHtml(value: unknown): string {
  const text =
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pageDocument(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    .history-shell { box-sizing: border-box; max-width: 72rem; margin: 0 auto; padding: 1rem; }
    .muted, .chart-legend { color: GrayText; }
    .history-filter { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .75rem; align-items: end; margin: 1rem 0 1.5rem; }
    label { display: grid; gap: .25rem; }
    select, button { min-height: 2.4rem; padding: .35rem .55rem; font: inherit; }
    button { cursor: pointer; }
    .timeline { display: grid; gap: .5rem; padding: 0; margin: 0 0 1.5rem; list-style: none; }
    .event { display: grid; grid-template-columns: minmax(9rem, auto) minmax(10rem, 1fr) auto auto auto; gap: .5rem; align-items: baseline; padding: .6rem .7rem; border-inline-start: .25rem solid GrayText; background: color-mix(in srgb, CanvasText 7%, Canvas); }
    .event-warn { border-color: darkorange; }
    .event-error { border-color: crimson; }
    .severity, .reason, .provider { font-size: .85rem; color: GrayText; }
    .usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .75rem; }
    .usage-card { min-width: 0; padding: .75rem; border: 1px solid GrayText; border-radius: .4rem; }
    .usage-card h3 { margin: 0; overflow-wrap: anywhere; font-size: 1rem; }
    .chart-scroll { overflow-x: auto; }
    svg { display: block; width: 100%; min-width: 16rem; height: 6rem; }
    .usage-gridline { stroke: GrayText; stroke-dasharray: 2 3; opacity: .45; }
    .usage-line { fill: none; stroke: Highlight; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.5; }
    .unknown { color: darkorange; }
    @media (max-width: 40rem) { .event { grid-template-columns: 1fr 1fr; } .event time, .event .reason { grid-column: 1 / -1; } }
  </style></head><body>${body}</body></html>`;
}
