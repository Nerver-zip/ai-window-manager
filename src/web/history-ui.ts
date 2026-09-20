/**
 * Pure SSR helpers for the bounded history view.
 *
 * The route integration owns database reads and must pass already-sanitized
 * provider keys, events, and window samples. This module deliberately accepts
 * no repository or provider dependencies and never renders arbitrary event
 * payloads.
 */

import { escapeHtml, renderAppShell } from './ui/layout.js';

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

  const content = `<div class="history-page">
    <form class="history-toolbar card" method="get" action="/history" aria-label="History filters">
      <div class="history-toolbar-summary">
        <span class="eyebrow">Explore</span>
        <strong>Persisted activity</strong>
        <span class="muted">Review provider usage and scheduler decisions.</span>
      </div>
      <div class="history-toolbar-fields">
        <label class="field">
          <span class="field-label">Time range</span>
          <select name="range">${rangeOptions}</select>
        </label>
        <label class="field">
          <span class="field-label">Provider</span>
          <select name="provider">${providerOptions}</select>
        </label>
        <button class="button button-primary" type="submit">Apply filters</button>
      </div>
    </form>
    <div class="history-sections">
      ${renderUsageSeries(view.series)}
      ${renderTimeline(view.events)}
    </div>
  </div>`;

  return renderAppShell({
    page: 'history',
    title: 'History',
    description: 'Bounded persisted observations and decisions.',
    content,
  });
}

export function renderTimeline(
  events: readonly (HistoryTimelineItem | HistoryTimelineEvent)[],
): string {
  const safeEvents = events
    .map((event) => ('displayType' in event ? event : sanitizeEvent(event)))
    .filter((event): event is HistoryTimelineItem => event !== null);
  if (safeEvents.length === 0) {
    return `<section class="history-section card" aria-labelledby="timeline-title">
      <div class="section-heading">
        <div><span class="eyebrow">Activity</span><h2 id="timeline-title">Timeline</h2></div>
      </div>
      <div class="empty-state" role="status">
        <strong>No events in this range</strong>
        <p class="unknown">unknown — the persisted timeline has no matching events.</p>
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
              formatTimestamp(event.occurredAt),
            )}</time>
            <span class="badge badge-${severity}">${escapeHtml(severity)}</span>
            <span class="timeline-provider">${escapeHtml(event.providerId ?? 'unknown')}</span>
          </div>
          <h3 class="timeline-event">${escapeHtml(event.displayType)}</h3>
          <p class="timeline-reason"><span class="timeline-label">Reason</span>${escapeHtml(
            event.displayReason,
          )}</p>
        </div>
      </li>`;
    })
    .join('');
  return `<section class="history-section card" aria-labelledby="timeline-title">
    <div class="section-heading">
      <div><span class="eyebrow">Activity</span><h2 id="timeline-title">Timeline</h2></div>
      <span class="section-count">${visibleEvents.length} event${visibleEvents.length === 1 ? '' : 's'}</span>
    </div>
    <ol class="timeline">${items}</ol>
  </section>`;
}

export function renderUsageSeries(series: readonly HistoryUsageSeries[]): string {
  if (series.length === 0) {
    return `<section class="history-section" aria-labelledby="usage-title">
      <div class="section-heading">
        <div><span class="eyebrow">Window samples</span><h2 id="usage-title">Usage</h2></div>
      </div>
      <div class="empty-state card" role="status">
        <strong>No usage samples in this range</strong>
        <p class="unknown">unknown — persisted window samples will appear here after observation.</p>
      </div>
    </section>`;
  }

  const visibleSeries = series.slice(0, MAX_USAGE_SERIES);
  const charts = visibleSeries.map((item) => renderUsageChart(item)).join('');
  return `<section class="history-section" aria-labelledby="usage-title">
    <div class="section-heading">
      <div><span class="eyebrow">Window samples</span><h2 id="usage-title">Usage</h2></div>
      <span class="section-count">${visibleSeries.length} series</span>
    </div>
    <div class="chart-grid">${charts}</div>
  </section>`;
}

function renderUsageChart(series: HistoryUsageSeries): string {
  const providerId = safeProviderId(series.providerId) ?? 'unknown';
  const windowKind = safeWindowKind(series.windowKind) ?? 'unknown';
  const points = series.points.slice(-MAX_USAGE_POINTS).map((point) => ({
    ...point,
    usageRatio: ratioOrNull(point.usageRatio),
    remainingRatio: ratioOrNull(point.remainingRatio),
  }));
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
        `<polyline class="chart-line" points="${plotted
          .map((point) => `${point.x},${point.y}`)
          .join(' ')}" />`,
    )
    .join('');
  const unknownCount = points.filter((point) => point.usageRatio === null).length;
  const latestPoint = [...points].reverse().find((point) => point.usageRatio !== null);
  const latest = latestPoint?.usageRatio;
  const latestText =
    latest === undefined || latest === null ? 'unknown' : `${Math.round(latest * 100)}%`;
  const latestRemainingPoint = [...points].reverse().find((point) => point.remainingRatio !== null);
  const latestRemaining = latestRemainingPoint?.remainingRatio;
  const remainingText =
    latestRemaining === undefined || latestRemaining === null
      ? 'unknown'
      : `${Math.round(latestRemaining * 100)}%`;
  const unknownText = unknownCount > 0 ? `; ${unknownCount} unknown` : '';
  const chartTitleId = `history-chart-${providerId}-${windowKind}`;

  return `<article class="card chart" aria-labelledby="${escapeAttribute(chartTitleId)}">
    <header class="card-header">
      <div class="chart-heading">
        <span class="eyebrow">Window</span>
        <h3 id="${escapeAttribute(chartTitleId)}">${escapeHtml(providerId)} <span class="chart-divider">/</span> ${escapeHtml(
          windowKind,
        )}</h3>
      </div>
      <div class="chart-summary">
        <p class="chart-stat">Latest usage: <strong>${escapeHtml(latestText)}</strong>${escapeHtml(
          unknownText,
        )}</p>
        <p class="chart-stat">Remaining: <strong>${escapeHtml(remainingText)}</strong></p>
      </div>
    </header>
    <div class="chart-scroll">
      <svg class="chart-svg" viewBox="0 0 320 96" role="img" aria-labelledby="${escapeAttribute(
        chartTitleId,
      )}" aria-label="Usage series for ${escapeAttribute(`${providerId} ${windowKind}`)}">
        <line class="chart-gridline" x1="0" y1="8" x2="320" y2="8" />
        <line class="chart-gridline" x1="0" y1="48" x2="320" y2="48" />
        <line class="chart-gridline" x1="0" y1="88" x2="320" y2="88" />
        <text class="chart-axis-label" x="4" y="7">100%</text>
        <text class="chart-axis-label" x="4" y="47">50%</text>
        <text class="chart-axis-label" x="4" y="87">0%</text>
        ${polyline}
      </svg>
    </div>
    <p class="chart-legend">Usage ratio from 0% to 100%; missing values remain <span class="unknown">unknown</span>.</p>
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
