/**
 * Pure SSR helpers for the bounded activity logs view and shared usage charts.
 *
 * The route integration owns database reads and must pass already-sanitized
 * provider keys, events, and window samples. This module deliberately accepts
 * no repository or provider dependencies and never renders arbitrary event
 * payloads.
 */

import escapeHtml from 'escape-html';
import { renderAppShell } from './ui/layout.js';
import {
  eventLabel,
  eventReasonLabel,
  providerDisplayName,
  providerLogoUrl,
  severityLabel,
  timeZoneDisplayName,
  windowDisplayName,
} from './ui/presentation.js';
import { formatRatioPercent, renderChartEmptyState, renderTimeSeriesChart } from './ui/charts.js';
import { renderProviderPicker } from './ui/provider-picker.js';

export const HISTORY_RANGES = [
  { value: '1h', label: '1h', durationMs: 1 * 60 * 60 * 1000 },
  { value: '3h', label: '3h', durationMs: 3 * 60 * 60 * 1000 },
  { value: '6h', label: '6h', durationMs: 6 * 60 * 60 * 1000 },
  { value: '12h', label: '12h', durationMs: 12 * 60 * 60 * 1000 },
  { value: '24h', label: '24h', durationMs: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', durationMs: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type HistoryRange = (typeof HISTORY_RANGES)[number]['value'];
export const DEFAULT_HISTORY_RANGE: HistoryRange = '24h';
export type HistorySeverity = 'debug' | 'info' | 'warn' | 'error';
export type LogTag = 'trigger' | 'reset' | 'sync' | 'config' | 'alert' | 'manual';

export const LOG_TAGS: readonly { value: LogTag; label: string; icon: string }[] = [
  { value: 'trigger', label: 'Triggers', icon: '⚡' },
  { value: 'reset', label: 'Resets', icon: '🔄' },
  { value: 'sync', label: 'Sync', icon: '🔍' },
  { value: 'config', label: 'Config', icon: '⚙️' },
  { value: 'alert', label: 'Alerts', icon: '⚠️' },
  { value: 'manual', label: 'Manual', icon: '👤' },
];

export const MAX_HISTORY_EVENTS = 100;
export const HISTORY_PAGE_SIZE = 20;
export const MAX_USAGE_SERIES = 16;
export const MAX_USAGE_POINTS = 384;

export interface HistoryProviderOption {
  id: string;
  label?: string;
  kind?: string;
  configured?: boolean;
  statusLabel?: string;
}

/** The only event fields consumed by the renderer. Raw event data is excluded. */
export interface HistoryTimelineEvent {
  id: number;
  occurredAt: string;
  providerId: string | null;
  type: string;
  severity: HistorySeverity;
  reasonCode: string | null;
  /** Read only for narrow tag classification; never included in rendered output. */
  data?: unknown;
}

/** A sanitized projection of a persisted window sample for the usage graph. */
export interface HistoryUsageSample {
  providerId: string;
  windowKind: string;
  observedAt: string;
  usageRatio?: number | null;
  remainingRatio?: number | null;
  gapBefore?: boolean;
  smoothingBreakBefore?: boolean;
}

export interface HistoryFilter {
  range: HistoryRange;
  providerId?: string;
  chartRanges?: Readonly<Record<string, HistoryRange>>;
  tag?: LogTag | null;
  eventType?: string | null;
}

export interface HistoryTimelineItem extends HistoryTimelineEvent {
  displayType: string;
  displaySeverity: HistorySeverity;
  displayReason: string;
  tags: readonly LogTag[];
}

export interface HistoryUsagePoint {
  observedAt: string;
  usageRatio: number | null;
  remainingRatio: number | null;
  gapBefore?: boolean;
  smoothingBreakBefore?: boolean;
}

export interface HistoryUsageSeries {
  providerId: string;
  windowKind: string;
  range?: HistoryRange;
  points: HistoryUsagePoint[];
}

export interface HistoryPageInput {
  now: Date;
  timeZone?: string;
  filter?: {
    range?: unknown;
    providerId?: unknown;
    chartRanges?: unknown;
    tag?: unknown;
    eventType?: unknown;
  };
  providers: readonly HistoryProviderOption[];
  events: readonly HistoryTimelineEvent[];
  samples: readonly HistoryUsageSample[];
  pagination?: HistoryPagination;
  usageChartsHref?: string;
  routineEventsHref?: string;
}

export interface HistoryPagination {
  page: number;
  pageSize: number;
  hasNext: boolean;
  previousHref?: string;
  nextHref?: string;
}

export interface BoundedHistoryView {
  range: HistoryRange;
  providerId: string | null;
  chartRanges: Readonly<Record<string, HistoryRange>>;
  tag: LogTag | null;
  eventType: string | null;
  events: HistoryTimelineItem[];
  series: HistoryUsageSeries[];
}

export interface UsageChartControls {
  timelineRange: HistoryRange;
  providerId: string | null;
  chartRanges: Readonly<Record<string, HistoryRange>>;
  seriesTitles?: Readonly<Record<string, string>>;
  page?: number;
  selectedDay?: string;
  selectedWindowKind?: string | null;
  timeZone?: string;
  fromAt?: string;
  toAt?: string;
}

const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_WINDOW_KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOGS_RESULTS_REGION = 'logs-results';

export function normalizeHistoryRange(value: unknown): HistoryRange {
  return isHistoryRange(value) ? value : DEFAULT_HISTORY_RANGE;
}

export function normalizeLogTag(value: unknown): LogTag | null {
  return LOG_TAGS.some((tag) => tag.value === value) ? (value as LogTag) : null;
}

export function getHistoryRange(value: HistoryRange) {
  return (
    HISTORY_RANGES.find((range) => range.value === value) ??
    HISTORY_RANGES.find((range) => range.value === DEFAULT_HISTORY_RANGE)!
  );
}

export function chartRangeKey(providerId: string, windowKind: string): string {
  return `${providerId}\u0000${windowKind}`;
}

export function serializeChartRangeSelection(
  providerId: string,
  windowKind: string,
  range: HistoryRange,
): string {
  return `${providerId}|${windowKind}|${range}`;
}

export function normalizeChartRanges(value: unknown): Readonly<Record<string, HistoryRange>> {
  const normalized: Record<string, HistoryRange> = {};
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const parts = entry.split('|');
    if (parts.length !== 3) continue;
    const [providerId, windowKind, range] = parts;
    if (!providerId || !windowKind || !isHistoryRange(range)) continue;
    if (safeProviderId(providerId) === null || safeWindowKind(windowKind) === null) continue;
    normalized[chartRangeKey(providerId, windowKind)] = range;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, range] of Object.entries(value)) {
      if (!isHistoryRange(range)) continue;
      const separator = key.indexOf('\u0000');
      if (separator <= 0 || separator === key.length - 1) continue;
      const providerId = key.slice(0, separator);
      const windowKind = key.slice(separator + 1);
      if (safeProviderId(providerId) === null || safeWindowKind(windowKind) === null) continue;
      normalized[chartRangeKey(providerId, windowKind)] = range;
    }
  }

  return normalized;
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
    .filter((event) => event.type !== 'scheduler_noop' || filter.eventType === 'scheduler_noop')
    .filter(
      (event) =>
        event.type !== 'provider_inspected' ||
        filter.tag === 'sync' ||
        filter.eventType === 'provider_inspected',
    )
    .filter((event) => filter.eventType == null || event.type === filter.eventType)
    .filter((event) => filter.tag == null || event.tags.includes(filter.tag))
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
  const nowMs = now.getTime();
  const grouped = new Map<string, HistoryUsageSeries>();

  for (const sample of samples) {
    const providerId = safeProviderId(sample.providerId);
    const windowKind = safeWindowKind(sample.windowKind);
    const observedAtMs = Date.parse(sample.observedAt);
    if (providerId === null || windowKind === null) continue;
    if (filter.providerId !== undefined && providerId !== filter.providerId) continue;

    const selectedRange = getHistoryRange(
      filter.chartRanges?.[chartRangeKey(providerId, windowKind)] ?? filter.range,
    );
    const fromMs = nowMs - selectedRange.durationMs;

    const key = `${providerId}\u0000${windowKind}`;
    const series = grouped.get(key) ?? {
      providerId,
      windowKind,
      range: selectedRange.value,
      points: [],
    };
    grouped.set(key, series);
    if (!Number.isFinite(observedAtMs) || observedAtMs < fromMs || observedAtMs > nowMs) {
      continue;
    }
    series.points.push({
      observedAt: new Date(observedAtMs).toISOString(),
      usageRatio: ratioOrNull(sample.usageRatio),
      remainingRatio: ratioOrNull(sample.remainingRatio),
      ...(sample.gapBefore ? { gapBefore: true } : {}),
      ...(sample.smoothingBreakBefore ? { smoothingBreakBefore: true } : {}),
    });
  }

  return [...grouped.values()]
    .map((series) => ({
      ...series,
      points: boundUsagePoints(
        series.points.sort(
          (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
        ),
      ),
    }))
    .sort((left, right) =>
      `${left.providerId}\u0000${left.windowKind}`.localeCompare(
        `${right.providerId}\u0000${right.windowKind}`,
      ),
    )
    .slice(0, MAX_USAGE_SERIES);
}

/** The repository normally supplies <=384 rows; retain both time ends for direct callers too. */
function boundUsagePoints(points: HistoryUsagePoint[]): HistoryUsagePoint[] {
  if (points.length <= MAX_USAGE_POINTS) return points;
  const selected: HistoryUsagePoint[] = [];
  let previousIndex = -1;
  for (let slot = 0; slot < MAX_USAGE_POINTS; slot += 1) {
    const index = Math.round((slot * (points.length - 1)) / (MAX_USAGE_POINTS - 1));
    const point = points[index]!;
    const skipped = points.slice(previousIndex + 1, index);
    selected.push({
      ...point,
      ...(point.gapBefore || skipped.some((item) => item.gapBefore || item.usageRatio === null)
        ? { gapBefore: true }
        : {}),
      ...(point.smoothingBreakBefore || skipped.some((item) => item.smoothingBreakBefore)
        ? { smoothingBreakBefore: true }
        : {}),
    });
    previousIndex = index;
  }
  return selected;
}

export function buildBoundedHistoryView(input: HistoryPageInput): BoundedHistoryView {
  const range = normalizeHistoryRange(input.filter?.range);
  const providerId = normalizeProviderFilter(input.filter?.providerId);
  const chartRanges = normalizeChartRanges(input.filter?.chartRanges);
  const tag = normalizeLogTag(input.filter?.tag);
  const eventType = safeCode(input.filter?.eventType);
  const filter: HistoryFilter = {
    range,
    ...(providerId ? { providerId } : {}),
    chartRanges,
    tag,
    eventType,
  };
  return {
    range,
    providerId: providerId ?? null,
    chartRanges,
    tag,
    eventType,
    events: filterHistoryEvents(input.events, input.now, filter),
    series: buildUsageSeries(input.samples, input.now, filter),
  };
}

export function renderLogsPage(input: HistoryPageInput): string {
  const view = buildBoundedHistoryView(input);
  const pagination = normalizePagination(input.pagination);
  const providers = safeProviderOptions(input.providers);
  const selectedProvider = view.providerId ?? '';
  const rangeOptions = HISTORY_RANGES.map(
    (range) =>
      `<option value="${range.value}"${range.value === view.range ? ' selected' : ''}>${range.label}</option>`,
  ).join('');
  const providerPicker = renderProviderPicker({
    name: 'provider',
    legend: 'Provider',
    options: [
      { value: '', label: 'All providers', configured: null, statusLabel: null },
      ...providers.map((provider) => ({
        value: provider.id,
        label: provider.label,
        ...(provider.kind ? { kind: provider.kind } : {}),
        ...(provider.configured !== undefined ? { configured: provider.configured } : {}),
        ...(provider.statusLabel !== undefined ? { statusLabel: provider.statusLabel } : {}),
      })),
    ],
    selectedValue: selectedProvider,
  });
  const usageNotice = input.usageChartsHref
    ? `<p class="usage-notice" role="status">Usage charts have moved to <a href="${escapeAttribute(input.usageChartsHref)}">Usage</a>. Your selected chart periods are preserved.</p>`
    : '';
  const selectedTag = view.tag ?? 'all';
  const tagFilters = [
    `<a class="log-tag-filter${selectedTag === 'all' ? ' is-active' : ''}" href="${escapeAttribute(logTagHref('all', view.range, view.providerId))}" data-awm-soft-nav data-awm-target="${LOGS_RESULTS_REGION}" data-awm-focus-key="logs-tag-all"${selectedTag === 'all' ? ' aria-current="page"' : ''}>All</a>`,
    ...LOG_TAGS.map(
      (tag) =>
        `<a class="log-tag-filter${selectedTag === tag.value ? ' is-active' : ''}" href="${escapeAttribute(logTagHref(tag.value, view.range, view.providerId))}" data-awm-soft-nav data-awm-target="${LOGS_RESULTS_REGION}" data-awm-focus-key="logs-tag-${tag.value}"${selectedTag === tag.value ? ' aria-current="page"' : ''}><span aria-hidden="true">${tag.icon}</span> ${tag.label}</a>`,
    ),
  ].join('');
  const hiddenTag = view.tag
    ? `<input type="hidden" name="tag" value="${escapeAttribute(view.tag)}">`
    : '';
  const hiddenType = view.eventType
    ? `<input type="hidden" name="type" value="${escapeAttribute(view.eventType)}">`
    : '';
  const routineToggle = input.routineEventsHref
    ? `<p class="log-routine-toggle">${view.eventType === 'scheduler_noop' ? 'Routine scheduler checks are included.' : 'Routine scheduler checks are hidden.'} <a href="${escapeAttribute(input.routineEventsHref)}" data-awm-soft-nav data-awm-target="${LOGS_RESULTS_REGION}" data-awm-focus-key="logs-routine-toggle">${view.eventType === 'scheduler_noop' ? 'Hide routine checks' : 'Show routine checks'}</a></p>`
    : '';
  const timeZone = input.timeZone ?? 'UTC';
  const content = `<div class="logs-page" data-awm-region="${LOGS_RESULTS_REGION}">
    ${usageNotice}
    <form class="history-toolbar card" method="get" action="/logs" aria-label="Log filters" data-awm-enhance="navigation" data-awm-target="${LOGS_RESULTS_REGION}">
      ${hiddenTag}${hiddenType}
      <div class="history-toolbar-summary">
        <span class="eyebrow">Explore</span>
        <strong>Activity logs</strong>
        <span class="muted">Review saved provider updates and why decisions were made.</span>
      </div>
      <div class="history-toolbar-fields">
        ${providerPicker}
        <label class="field">
          <span class="field-label">Timeline range</span>
          <select name="range" data-awm-focus-key="logs-range">${rangeOptions}</select>
        </label>
        <button class="button button-primary" type="submit" data-awm-focus-key="logs-apply-filters">Apply filters</button>
      </div>
    </form>
    <nav class="log-tag-filters" aria-label="Filter logs by category">${tagFilters}</nav>
    ${routineToggle}
    <div class="history-sections">
      ${renderTimeline(view.events, pagination, timeZone, view.eventType, view.tag)}
    </div>
  </div>`;

  return renderAppShell({
    page: 'logs',
    title: 'Logs',
    heading: 'Activity Logs',
    description: 'Review important usage changes and automatic starts.',
    content,
  });
}

/** @deprecated Use renderLogsPage. Kept for callers migrating from the old page name. */
export const renderHistoryPage = renderLogsPage;

function logTagHref(tag: 'all' | LogTag, range: HistoryRange, providerId: string | null): string {
  const params = new URLSearchParams({ range, tag });
  if (providerId) params.set('provider', providerId);
  return `/logs?${params.toString()}`;
}

export function renderTimeline(
  events: readonly (HistoryTimelineItem | HistoryTimelineEvent)[],
  pagination?: HistoryPagination,
  timeZone = 'UTC',
  eventType?: string | null,
  selectedTag?: LogTag | null,
): string {
  const safeEvents = events
    .map((event) => ('displayType' in event ? event : sanitizeEvent(event)))
    .filter((event): event is HistoryTimelineItem => event !== null)
    .filter((event) => event.type !== 'scheduler_noop' || eventType === 'scheduler_noop')
    .filter(
      (event) =>
        event.type !== 'provider_inspected' ||
        selectedTag === 'sync' ||
        eventType === 'provider_inspected',
    );
  if (safeEvents.length === 0) {
    return `<section class="history-section card" aria-labelledby="timeline-title">
      <div class="section-heading">
        <div><span class="eyebrow">Activity</span><h2 id="timeline-title">Timeline</h2><p class="muted">Times shown in ${escapeHtml(timeZoneDisplayName(timeZone))}.</p></div>
      </div>
      <div class="empty-state" role="status">
        <strong>No notable activity in this range</strong>
        <p class="unknown">Important usage and schedule changes will appear here.</p>
      </div>
    </section>`;
  }

  const visibleEvents = safeEvents.slice(0, MAX_HISTORY_EVENTS);
  const items = visibleEvents
    .map((event) => {
      const severity = safeSeverity(event.displaySeverity);
      return `<li class="timeline-item event event-${severity}">
        <span class="timeline-marker" aria-hidden="true"></span>
        <div class="timeline-content">
          <div class="timeline-meta">
            <time class="timeline-time" datetime="${escapeAttribute(event.occurredAt)}">${escapeHtml(
              formatTimestamp(event.occurredAt, timeZone),
            )}</time>
            <span class="badge badge-${severity}">${escapeHtml(severityLabel(severity))}</span>
            <span class="log-event-tags" aria-label="Event categories">${renderLogTagBadges(event.tags ?? classifyLogEvent(event.type, event.severity, event.data))}</span>
            <span class="timeline-provider">${event.providerId && providerLogoUrl(event.providerId) ? `<img class="provider-logo-xs" src="${providerLogoUrl(event.providerId)}" alt="" width="14" height="14">` : ''}${escapeHtml(event.providerId ? providerDisplayName(event.providerId) : 'Provider unavailable')}</span>
          </div>
          <h3 class="timeline-event">${escapeHtml(event.displayType)}</h3>
          <p class="timeline-reason"><span class="timeline-label">Why</span>${escapeHtml(
            event.displayReason,
          )}</p>
        </div>
      </li>`;
    })
    .join('');
  const pageInfo = normalizePagination(pagination);
  const pageLabel = pageInfo.page > 1 || pageInfo.hasNext ? ` · page ${pageInfo.page}` : '';
  return `<section class="history-section card" aria-labelledby="timeline-title">
    <div class="section-heading">
      <div><span class="eyebrow">Activity</span><h2 id="timeline-title">Timeline</h2><p class="muted">Times shown in ${escapeHtml(timeZoneDisplayName(timeZone))}.</p></div>
      <span class="section-count">${visibleEvents.length} event${visibleEvents.length === 1 ? '' : 's'}${pageLabel}</span>
    </div>
    <ol class="timeline">${items}</ol>
    ${renderHistoryPagination(pagination, visibleEvents.length)}
  </section>`;
}

export function renderUsageSeries(
  series: readonly HistoryUsageSeries[],
  controls: UsageChartControls | HistoryRange = '24h',
): string {
  const resolvedControls: UsageChartControls =
    typeof controls === 'string'
      ? { timelineRange: controls, providerId: null, chartRanges: {} }
      : controls;
  if (series.length === 0) {
    return `<section class="history-section" aria-labelledby="usage-title">
      <div class="section-heading">
        <div><span class="eyebrow">Usage over time</span><h2 id="usage-title">Usage</h2></div>
      </div>
      ${renderChartEmptyState()}
    </section>`;
  }

  const visibleSeries = series.slice(0, MAX_USAGE_SERIES);
  const regionCounts = new Map<string, number>();
  for (const item of visibleSeries) {
    const regionKey = usageChartRegionKey(item.providerId, item.windowKind);
    if (regionKey) regionCounts.set(regionKey, (regionCounts.get(regionKey) ?? 0) + 1);
  }
  const charts = visibleSeries
    .map((item) => {
      const regionKey = usageChartRegionKey(item.providerId, item.windowKind);
      return renderUsageChart(
        item,
        resolvedControls,
        visibleSeries,
        regionKey && regionCounts.get(regionKey) === 1 ? regionKey : null,
      );
    })
    .join('');
  return `<section class="history-section" aria-labelledby="usage-title">
    <div class="section-heading">
      <div><span class="eyebrow">Usage over time</span><h2 id="usage-title">Usage</h2></div>
      <span class="section-count">${visibleSeries.length} window${visibleSeries.length === 1 ? '' : 's'}</span>
    </div>
    <div class="chart-grid">${charts}</div>
  </section>`;
}

function renderUsageChart(
  series: HistoryUsageSeries,
  controls: UsageChartControls,
  allSeries: readonly HistoryUsageSeries[],
  regionKey: string | null,
): string {
  const providerId = safeProviderId(series.providerId) ?? 'unknown';
  const windowKind = safeWindowKind(series.windowKind) ?? 'unknown';
  const providerLabel = providerDisplayName(providerId);
  const windowLabel = windowDisplayName(providerId, windowKind);
  const chartTitle =
    controls.seriesTitles?.[chartRangeKey(providerId, windowKind)] ??
    `${providerLabel} / ${windowLabel}`;
  const points = series.points.map((point) => ({
    ...point,
    usageRatio: ratioOrNull(point.usageRatio),
    remainingRatio: ratioOrNull(point.remainingRatio),
  }));
  const latestPoint = [...points].reverse().find((point) => point.usageRatio !== null);
  const latest = latestPoint?.usageRatio;
  const latestText =
    latest === undefined || latest === null ? 'Not available yet' : `${Math.round(latest * 100)}%`;
  const latestRemainingPoint = [...points].reverse().find((point) => point.remainingRatio !== null);
  const latestRemaining = latestRemainingPoint?.remainingRatio;
  const remainingText =
    latestRemaining === undefined || latestRemaining === null
      ? 'Not available yet'
      : `${Math.round(latestRemaining * 100)}%`;
  const range =
    series.range ??
    controls.chartRanges[chartRangeKey(providerId, windowKind)] ??
    controls.timelineRange;

  const chartMarkup = renderTimeSeriesChart({
    id: chartTitle,
    title: chartTitle,
    range,
    controls: renderChartRangeControl(series, range, controls, allSeries, chartTitle, regionKey),
    summary: [
      { label: 'Latest used', value: latestText },
      { label: 'Remaining', value: remainingText },
    ],
    series: [
      {
        key: 'used',
        label: 'Usage trend',
        colorIndex: 1,
        unit: '%',
        averageWindow: 5,
        points: points.map((point) => ({
          observedAt: point.observedAt,
          value: point.usageRatio,
          ...(point.gapBefore ? { gapBefore: true } : {}),
          ...(point.smoothingBreakBefore ? { smoothingBreakBefore: true } : {}),
        })),
      },
    ],
    yAxis: {
      min: 0,
      max: 1,
      ticks: [1, 0.75, 0.5, 0.25, 0],
      format: formatRatioPercent,
    },
    footer: '',
    ...(controls.toAt
      ? {
          timeDomain: {
            fromAt: new Date(
              Date.parse(controls.toAt) - getHistoryRange(range).durationMs,
            ).toISOString(),
            toAt: controls.toAt,
            timeZone: controls.timeZone ?? 'UTC',
          },
        }
      : {}),
  });
  return regionKey ? addUsageChartRegion(chartMarkup, regionKey) : chartMarkup;
}

function renderChartRangeControl(
  series: HistoryUsageSeries,
  range: HistoryRange,
  controls: UsageChartControls,
  allSeries: readonly HistoryUsageSeries[],
  label: string,
  regionKey: string | null,
): string {
  const providerId = safeProviderId(series.providerId) ?? 'unknown';
  const windowKind = safeWindowKind(series.windowKind) ?? 'unknown';
  const preservedSelections = allSeries
    .filter((item) => item !== series)
    .map((item) => {
      const itemRange =
        item.range ??
        controls.chartRanges[chartRangeKey(item.providerId, item.windowKind)] ??
        controls.timelineRange;
      return `<input type="hidden" name="chartRange" value="${escapeAttribute(serializeChartRangeSelection(item.providerId, item.windowKind, itemRange))}">`;
    })
    .join('');
  const provider = `<input type="hidden" name="provider" value="${escapeAttribute(providerId)}">`;
  const selectedWindowKind =
    controls.selectedWindowKind === undefined ? windowKind : controls.selectedWindowKind;
  const selectedWindow = selectedWindowKind
    ? `<input type="hidden" name="window" value="${escapeAttribute(selectedWindowKind)}">`
    : '';
  const selectedDay = controls.selectedDay
    ? `<input type="hidden" name="day" value="${escapeAttribute(controls.selectedDay)}">`
    : '';
  const options = HISTORY_RANGES.map(
    (option) =>
      `<option value="${escapeAttribute(serializeChartRangeSelection(providerId, windowKind, option.value))}"${option.value === range ? ' selected' : ''}>${option.label}</option>`,
  ).join('');

  const enhancement = regionKey
    ? ` data-awm-enhance="navigation" data-awm-target="${escapeAttribute(regionKey)}"`
    : '';
  const focusKey = regionKey
    ? ` data-awm-focus-key="${escapeAttribute(`${regionKey}:period`)}"`
    : '';
  return `<form class="chart-range-form" method="get" action="/usage" aria-label="Time range for ${escapeAttribute(label)}"${enhancement}>${provider}${selectedWindow}${selectedDay}${preservedSelections}<label class="chart-range-control"><span>Period</span><select name="chartRange" data-chart-range-select aria-label="Period for ${escapeAttribute(label)}"${focusKey}>${options}</select></label><noscript><button class="button button-secondary chart-range-submit" type="submit">Apply</button></noscript></form>`;
}

function usageChartRegionKey(providerId: unknown, windowKind: unknown): string | null {
  const safeProvider = safeProviderId(providerId);
  const safeWindow = safeWindowKind(windowKind);
  if (!safeProvider || !safeWindow) return null;
  return `usage-chart:${safeProvider}:${safeWindow}`;
}

function addUsageChartRegion(markup: string, regionKey: string): string {
  // The chart renderer owns its semantic root; attach the stable key at that root.
  return markup.replace(
    '<article class="card chart-card"',
    `<article class="card chart-card" data-awm-region="${escapeAttribute(regionKey)}"`,
  );
}

function sanitizeEvent(event: HistoryTimelineEvent): HistoryTimelineItem | null {
  const occurredAtMs = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAtMs)) return null;
  const severity = safeSeverity(event.severity);
  const type = safeCode(event.type);
  const reason = event.reasonCode === null ? null : safeCode(event.reasonCode);
  const providerId = event.providerId === null ? null : safeProviderId(event.providerId);
  const eventType = type ?? 'unknown';
  return {
    id: Number.isSafeInteger(event.id) && event.id >= 0 ? event.id : 0,
    occurredAt: new Date(occurredAtMs).toISOString(),
    providerId,
    type: eventType,
    severity,
    reasonCode: reason,
    displayType: eventLabel(eventType),
    displaySeverity: severity,
    displayReason: eventReasonLabel(eventType, reason),
    tags: classifyLogEvent(eventType, severity, event.data),
  };
}

function classifyLogEvent(
  type: string,
  severity: HistorySeverity,
  data: unknown,
): readonly LogTag[] {
  const tags = new Set<LogTag>();
  const manualTrigger = type.startsWith('manual_trigger_');
  const alertEvent =
    type === 'action_uncertain' ||
    type.startsWith('action_failed_') ||
    type === 'provider_auth_required' ||
    type === 'provider_auth_failed' ||
    type === 'provider_auth_timed_out';

  if (type.startsWith('action_') || manualTrigger) tags.add('trigger');
  if (type === 'unexpected_reset_detected' || type === 'external_window_started') tags.add('reset');
  if (
    type === 'provider_inspected' ||
    type === 'inspect_requested' ||
    type === 'provider_inspection_failed' ||
    type === 'provider_auth_required' ||
    type.startsWith('provider_auth_') ||
    type === 'scheduler_noop'
  )
    tags.add('sync');
  if (
    type.startsWith('provider_auth_') ||
    type === 'schedule_policy_updated' ||
    type === 'provider_settings_updated' ||
    type === 'timezone_updated' ||
    type === 'schedule_policy_invalid' ||
    type === 'settings_changed' ||
    type === 'schedule_changed'
  )
    tags.add('config');
  if (severity === 'warn' || severity === 'error' || alertEvent) tags.add('alert');
  if (
    manualTrigger ||
    type === 'inspect_requested' ||
    type === 'provider_auth_started' ||
    type === 'provider_auth_awaiting_user' ||
    type === 'provider_auth_canceled' ||
    hasManualOrigin(data)
  )
    tags.add('manual');

  // Unknown informational events still receive a neutral operational category;
  // their human-facing copy remains sanitized by eventLabel().
  if (tags.size === 0) tags.add('sync');
  return LOG_TAGS.filter((tag) => tags.has(tag.value)).map((tag) => tag.value);
}

function hasManualOrigin(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return ['source', 'origin', 'initiator'].some((key) => record[key] === 'manual');
}

function renderLogTagBadges(tags: readonly LogTag[]): string {
  return tags
    .map((tag) => {
      const descriptor = LOG_TAGS.find((candidate) => candidate.value === tag);
      if (!descriptor) return '';
      return `<span class="badge badge-tag badge-tag-${tag}">${descriptor.label}</span>`;
    })
    .join('');
}

function safeProviderOptions(providers: readonly HistoryProviderOption[]): Array<{
  id: string;
  label: string;
  kind?: string;
  configured?: boolean;
  statusLabel?: string;
}> {
  const seen = new Set<string>();
  return providers.flatMap((provider) => {
    const id = safeProviderId(provider.id);
    if (id === null || seen.has(id)) return [];
    seen.add(id);
    const label = safeDisplayText(provider.label ?? providerDisplayName(id));
    const statusLabel = provider.statusLabel ? safeDisplayText(provider.statusLabel) : undefined;
    return [
      {
        id,
        label: label || providerDisplayName(id),
        ...(provider.kind ? { kind: provider.kind } : {}),
        ...(provider.configured !== undefined ? { configured: provider.configured } : {}),
        ...(statusLabel ? { statusLabel } : {}),
      },
    ];
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

function formatTimestamp(value: string, timeZone: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'unknown';
  try {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    }).format(new Date(timestamp));
  } catch {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    }).format(new Date(timestamp));
  }
}

function normalizePagination(value: HistoryPagination | undefined): HistoryPagination {
  if (!value) return { page: 1, pageSize: HISTORY_PAGE_SIZE, hasNext: false };
  return {
    page: Number.isSafeInteger(value.page) && value.page > 0 ? value.page : 1,
    pageSize:
      Number.isSafeInteger(value.pageSize) && value.pageSize > 0
        ? Math.min(value.pageSize, MAX_HISTORY_EVENTS)
        : HISTORY_PAGE_SIZE,
    hasNext: value.hasNext === true,
    ...(typeof value.previousHref === 'string' ? { previousHref: value.previousHref } : {}),
    ...(typeof value.nextHref === 'string' ? { nextHref: value.nextHref } : {}),
  };
}

function renderHistoryPagination(
  input: HistoryPagination | undefined,
  visibleCount: number,
): string {
  const pagination = normalizePagination(input);
  if (pagination.page === 1 && !pagination.hasNext && !pagination.previousHref) return '';
  const first = (pagination.page - 1) * pagination.pageSize + (visibleCount > 0 ? 1 : 0);
  const last = first > 0 ? first + visibleCount - 1 : 0;
  const range = visibleCount > 0 ? `Showing ${first}–${last}` : 'No events shown';
  const previous = pagination.previousHref
    ? `<a class="button button-secondary" href="${escapeAttribute(pagination.previousHref)}" rel="prev" data-awm-soft-nav data-awm-target="${LOGS_RESULTS_REGION}" data-awm-focus-key="logs-page-previous">Previous</a>`
    : `<span class="button button-secondary is-disabled" aria-disabled="true">Previous</span>`;
  const next = pagination.nextHref
    ? `<a class="button button-secondary" href="${escapeAttribute(pagination.nextHref)}" rel="next" data-awm-soft-nav data-awm-target="${LOGS_RESULTS_REGION}" data-awm-focus-key="logs-page-next">Next</a>`
    : `<span class="button button-secondary is-disabled" aria-disabled="true">Next</span>`;
  return `<nav class="history-pagination" aria-label="Log pages">
    <p class="history-pagination-summary">${range} · page ${pagination.page}${pagination.hasNext ? ' · more available' : ''}</p>
    <div class="history-pagination-actions">${previous}${next}</div>
  </nav>`;
}

function isHistoryRange(value: unknown): value is HistoryRange {
  return (
    value === '1h' ||
    value === '3h' ||
    value === '6h' ||
    value === '12h' ||
    value === '24h' ||
    value === '7d' ||
    value === '30d'
  );
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
