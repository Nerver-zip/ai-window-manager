/**
 * Pure SSR helpers for the bounded history view.
 *
 * The route integration owns database reads and must pass already-sanitized
 * provider keys, events, and window samples. This module deliberately accepts
 * no repository or provider dependencies and never renders arbitrary event
 * payloads.
 */

import { escapeHtml, renderAppShell } from './ui/layout.js';
import {
  eventLabel,
  providerDisplayName,
  reasonLabel,
  severityLabel,
  windowDisplayName,
} from './ui/presentation.js';

export const HISTORY_RANGES = [
  { value: '24h', label: '24h', durationMs: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', durationMs: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type HistoryRange = (typeof HISTORY_RANGES)[number]['value'];
export type HistorySeverity = 'debug' | 'info' | 'warn' | 'error';

export const MAX_HISTORY_EVENTS = 100;
export const HISTORY_PAGE_SIZE = 20;
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
  pagination?: HistoryPagination;
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
  events: HistoryTimelineItem[];
  series: HistoryUsageSeries[];
}

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
  const pagination = normalizePagination(input.pagination);
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
        <strong>Activity history</strong>
        <span class="muted">Review saved provider updates and why decisions were made.</span>
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
      ${renderTimeline(view.events, pagination)}
    </div>
  </div>`;

  return renderAppShell({
    page: 'history',
    title: 'History',
    description: 'See usage changes and why the system made a decision.',
    content,
  });
}

export function renderTimeline(
  events: readonly (HistoryTimelineItem | HistoryTimelineEvent)[],
  pagination?: HistoryPagination,
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
        <strong>No activity in this range</strong>
        <p class="unknown">Saved activity will appear here after the provider is checked.</p>
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
            <span class="badge badge-${severity}">${escapeHtml(severityLabel(severity))}</span>
            <span class="timeline-provider">${escapeHtml(event.providerId ? providerDisplayName(event.providerId) : 'Provider unavailable')}</span>
          </div>
          <h3 class="timeline-event">${escapeHtml(event.displayType)}</h3>
          <p class="timeline-reason"><span class="timeline-label">Why</span>${escapeHtml(
            event.displayReason,
          )}</p>
        </div>
      </li>`;
    })
    .join('');
  return `<section class="history-section card" aria-labelledby="timeline-title">
    <div class="section-heading">
      <div><span class="eyebrow">Activity</span><h2 id="timeline-title">Timeline</h2></div>
      <span class="section-count">${visibleEvents.length} event${visibleEvents.length === 1 ? '' : 's'} · page ${normalizePagination(pagination).page}</span>
    </div>
    <ol class="timeline">${items}</ol>
    ${renderHistoryPagination(pagination, visibleEvents.length)}
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
        <p class="unknown">Saved usage samples will appear here after the provider is checked.</p>
      </div>
    </section>`;
  }

  const visibleSeries = series.slice(0, MAX_USAGE_SERIES);
  const charts = visibleSeries.map((item) => renderUsageChart(item)).join('');
  return `<section class="history-section" aria-labelledby="usage-title">
    <div class="section-heading">
      <div><span class="eyebrow">Window samples</span><h2 id="usage-title">Usage</h2></div>
      <span class="section-count">${visibleSeries.length} window${visibleSeries.length === 1 ? '' : 's'}</span>
    </div>
    <div class="chart-grid">${charts}</div>
  </section>`;
}

function renderUsageChart(series: HistoryUsageSeries): string {
  const providerId = safeProviderId(series.providerId) ?? 'unknown';
  const windowKind = safeWindowKind(series.windowKind) ?? 'unknown';
  const providerLabel = providerDisplayName(providerId);
  const windowLabel = windowDisplayName(providerId, windowKind);
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
    latest === undefined || latest === null ? 'Not available yet' : `${Math.round(latest * 100)}%`;
  const latestRemainingPoint = [...points].reverse().find((point) => point.remainingRatio !== null);
  const latestRemaining = latestRemainingPoint?.remainingRatio;
  const remainingText =
    latestRemaining === undefined || latestRemaining === null
      ? 'Not available yet'
      : `${Math.round(latestRemaining * 100)}%`;
  const unknownText = unknownCount > 0 ? `; ${unknownCount} unavailable` : '';
  const chartTitleId = `history-chart-${displaySlug(providerLabel)}-${displaySlug(windowLabel)}`;
  const firstPoint = points[0];
  const lastPoint = points.at(-1);
  const latestIndex = findLastKnownUsageIndex(points);
  const latestMarker =
    latestIndex === -1
      ? ''
      : `<circle class="chart-point" cx="${chartX(latestIndex, points.length)}" cy="${chartY(
          points[latestIndex]?.usageRatio ?? 0,
        )}" r="3.5" />`;
  const sampleText = `${points.length} sample${points.length === 1 ? '' : 's'}`;

  return `<article class="card chart" aria-labelledby="${escapeAttribute(chartTitleId)}">
    <header class="card-header">
      <div class="chart-heading">
        <span class="eyebrow">Usage window</span>
        <h3 id="${escapeAttribute(chartTitleId)}">${escapeHtml(providerLabel)} <span class="chart-divider">/</span> ${escapeHtml(
          windowLabel,
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
      <svg class="chart-svg" viewBox="0 0 360 146" role="img" aria-labelledby="${escapeAttribute(
        chartTitleId,
      )}" aria-label="Usage over time for ${escapeAttribute(`${providerLabel} ${windowLabel}`)}">
        <line class="chart-gridline" x1="34" y1="14" x2="352" y2="14" />
        <line class="chart-gridline" x1="34" y1="62" x2="352" y2="62" />
        <line class="chart-gridline" x1="34" y1="110" x2="352" y2="110" />
        <line class="chart-axis" x1="34" y1="110" x2="352" y2="110" />
        <text class="chart-axis-label" x="4" y="17">100%</text>
        <text class="chart-axis-label" x="10" y="65">50%</text>
        <text class="chart-axis-label" x="15" y="113">0%</text>
        <text class="chart-axis-label chart-axis-time" x="34" y="133">${escapeHtml(
          formatChartTime(firstPoint?.observedAt),
        )}</text>
        <text class="chart-axis-label chart-axis-time" x="352" y="133" text-anchor="end">${escapeHtml(
          formatChartTime(lastPoint?.observedAt),
        )}</text>
        ${polyline}
        ${latestMarker}
      </svg>
    </div>
    <p class="chart-legend"><strong>Used %</strong> · older → newer · ${sampleText}${unknownText ? escapeHtml(unknownText) : ''}. Some observations are unavailable.</p>
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
    displayType: eventLabel(type ?? ''),
    displaySeverity: severity,
    displayReason: reasonLabel(reason),
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
    const label = safeDisplayText(provider.label ?? providerDisplayName(id));
    return [{ id, label: label || providerDisplayName(id) }];
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

function displaySlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'unknown';
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

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : 'unknown';
}

function chartX(index: number, length: number): number {
  return length <= 1 ? 193 : 34 + Math.round((index / (length - 1)) * 318);
}

function chartY(value: number): number {
  return Math.round(110 - value * 96);
}

function findLastKnownUsageIndex(points: readonly HistoryUsagePoint[]): number {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index]?.usageRatio !== null && points[index]?.usageRatio !== undefined) return index;
  }
  return -1;
}

function formatChartTime(value: string | undefined): string {
  if (!value) return 'unknown';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'unknown';
  return new Date(timestamp).toISOString().slice(11, 16) + ' UTC';
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
  const first = (pagination.page - 1) * pagination.pageSize + (visibleCount > 0 ? 1 : 0);
  const last = first > 0 ? first + visibleCount - 1 : 0;
  const range = visibleCount > 0 ? `Showing ${first}–${last}` : 'No events shown';
  const previous = pagination.previousHref
    ? `<a class="button button-secondary" href="${escapeAttribute(pagination.previousHref)}" rel="prev">Previous</a>`
    : `<span class="button button-secondary is-disabled" aria-disabled="true">Previous</span>`;
  const next = pagination.nextHref
    ? `<a class="button button-secondary" href="${escapeAttribute(pagination.nextHref)}" rel="next">Next</a>`
    : `<span class="button button-secondary is-disabled" aria-disabled="true">Next</span>`;
  return `<nav class="history-pagination" aria-label="History pages">
    <p class="history-pagination-summary">${range} · page ${pagination.page}${pagination.hasNext ? ' · more available' : ''}</p>
    <div class="history-pagination-actions">${previous}${next}</div>
  </nav>`;
}

function isHistoryRange(value: unknown): value is HistoryRange {
  return value === '24h' || value === '7d' || value === '30d';
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
