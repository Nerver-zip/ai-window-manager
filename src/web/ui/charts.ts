import { escapeHtml } from './layout.js';

export type ChartRange = '1h' | '3h' | '6h' | '12h' | '24h' | '7d' | '30d';

export interface ChartPoint {
  observedAt: string;
  value: number | null;
  gapBefore?: boolean;
  /** Split the moving average here while retaining the observed line edge. */
  smoothingBreakBefore?: boolean;
}

export interface ChartSeries {
  key: string;
  label: string;
  colorIndex: number;
  unit?: string;
  /** Centered moving average over nearby readings; missing points and gaps split the average. */
  averageWindow?: number;
  points: readonly ChartPoint[];
}

export interface ChartSummaryItem {
  label: string;
  value: string;
}

export interface TimeSeriesChartInput {
  id: string;
  title: string;
  eyebrow?: string;
  description?: string;
  range: ChartRange;
  controls?: string;
  summary: readonly ChartSummaryItem[];
  series: readonly ChartSeries[];
  yAxis: {
    min: number;
    max: number;
    ticks: readonly number[];
    format: (value: number) => string;
  };
  footer: string;
  timeDomain?: { fromAt: string; toAt: string; timeZone?: string };
}

const VIEWBOX_WIDTH = 640;
const VIEWBOX_HEIGHT = 230;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 624;
const PLOT_TOP = 18;
const PLOT_BOTTOM = 188;
const MAX_TIME_TICKS = 4;

export function renderTimeSeriesChart(input: TimeSeriesChartInput): string {
  const chartId = `chart-${displaySlug(input.id)}`;
  const titleId = `${chartId}-title`;
  const referencePoints = input.series[0]?.points ?? [];
  const domain = resolveTimeDomain(input.timeDomain, referencePoints);
  const ticks = buildTimeTicks(domain.fromMs, domain.toMs, MAX_TIME_TICKS);
  const tickMarkup = ticks
    .map((instantMs, index) => {
      const x = chartXAt(instantMs, domain.fromMs, domain.toMs);
      const anchor = index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle';
      return `<text class="chart-axis-label chart-axis-time" x="${x}" y="216" text-anchor="${anchor}">${escapeHtml(formatChartTick(new Date(instantMs).toISOString(), input.range, domain.timeZone))}</text>`;
    })
    .join('');
  const gridMarkup = input.yAxis.ticks
    .map((tick) => {
      const y = chartY(tick, input.yAxis.min, input.yAxis.max);
      return `<line class="chart-gridline" x1="${PLOT_LEFT}" y1="${y}" x2="${PLOT_RIGHT}" y2="${y}" />`;
    })
    .join('');
  const axisLabels = input.yAxis.ticks
    .map((tick) => {
      const y = chartY(tick, input.yAxis.min, input.yAxis.max);
      return `<text class="chart-axis-label chart-axis-value" x="0" y="${y + 3}">${escapeHtml(input.yAxis.format(tick))}</text>`;
    })
    .join('');
  const seriesMarkup = input.series
    .map((series, seriesIndex) =>
      renderSeries(series, seriesIndex, domain, input.yAxis.min, input.yAxis.max),
    )
    .join('');
  const hasKnownValue = input.series.some((series) =>
    series.points.some(
      (point) => normalizedValue(point.value, input.yAxis.min, input.yAxis.max) !== null,
    ),
  );
  const plotEmptyMarkup = hasKnownValue
    ? ''
    : '<div class="chart-plot-empty" role="status">Waiting for a valid observation</div>';
  const summaryMarkup = input.summary
    .map(
      (item) =>
        `<p class="chart-stat"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></p>`,
    )
    .join('');
  const legendMarkup = input.series
    .map(
      (series, index) =>
        `<span class="chart-legend-item"><span class="chart-legend-swatch chart-series-${safeColorIndex(series.colorIndex, index)}" aria-hidden="true"></span><span>${escapeHtml(series.label)}</span></span>`,
    )
    .join('');
  const footerMarkup = input.footer.trim()
    ? `<span class="chart-legend-context">${escapeHtml(input.footer)}</span>`
    : '';
  const description = input.description
    ? `<p class="chart-description">${escapeHtml(input.description)}</p>`
    : '';
  const headerAside = [
    input.controls,
    summaryMarkup ? `<div class="chart-summary">${summaryMarkup}</div>` : '',
  ]
    .filter(Boolean)
    .join('');

  return `<article class="card chart-card" aria-labelledby="${escapeHtml(titleId)}">
    <header class="chart-card-header">
      <div class="chart-heading">
        <span class="eyebrow">${escapeHtml(input.eyebrow ?? 'Usage window')}</span>
        <h3 id="${escapeHtml(titleId)}">${escapeHtml(input.title)}</h3>
        ${description}
      </div>
      ${headerAside ? `<div class="chart-card-controls">${headerAside}</div>` : ''}
    </header>
    <div class="chart-plot" data-chart-root data-chart-range="${escapeHtml(input.range)}">
      <svg class="chart-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}" role="img" aria-labelledby="${escapeHtml(titleId)}" aria-label="${escapeHtml(`${input.title} over time`)}">
        ${gridMarkup}
        ${axisLabels}
        ${tickMarkup}
        ${seriesMarkup}
      </svg>
      ${plotEmptyMarkup}
      <div class="chart-tooltip" data-chart-tooltip role="tooltip" aria-hidden="true">
        <time class="chart-tooltip-time" data-chart-tooltip-time></time>
        <div class="chart-tooltip-values" data-chart-tooltip-values></div>
      </div>
    </div>
    <div class="chart-legend" aria-label="Chart legend">
      ${legendMarkup}
      ${footerMarkup}
    </div>
  </article>`;
}

export function renderChartEmptyState(message = 'No usage observations in this range'): string {
  return `<div class="chart-empty" role="status"><span class="chart-empty-mark" aria-hidden="true">—</span><strong>${escapeHtml(message)}</strong><p>Saved observations will appear here after the provider is checked.</p></div>`;
}

export function formatRatioPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatChartTick(value: string, range: ChartRange, timeZone = 'UTC'): string {
  const date = parseDate(value);
  if (!date) return 'unknown';
  const options: Intl.DateTimeFormatOptions =
    range === '1h' || range === '3h' || range === '6h' || range === '12h' || range === '24h'
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }
      : { day: 'numeric', month: 'short' };
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    if (options.day) return `${part('day')} ${shortMonth(part('month'))}`;
    return `${part('hour')}:${part('minute')} ${part('timeZoneName')}`;
  } catch {
    return 'unknown';
  }
}

export function formatChartTooltipTime(value: string, timeZone = 'UTC'): string {
  const date = parseDate(value);
  if (!date) return 'Time unavailable';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('day')} ${shortMonth(part('month'))} ${part('year')} · ${part('hour')}:${part('minute')} ${part('timeZoneName')}`;
  } catch {
    return 'Time unavailable';
  }
}

function shortMonth(value: string): string {
  return value === 'Sept' ? 'Sep' : value;
}

export function buildTickIndices(length: number, maximum = MAX_TIME_TICKS): number[] {
  if (length <= 0) return [];
  if (length === 1 || maximum <= 1) return [0];
  const count = Math.min(length, Math.max(2, maximum));
  const indices = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    indices.add(Math.round((index * (length - 1)) / (count - 1)));
  }
  return [...indices].sort((left, right) => left - right);
}

function renderSeries(
  series: ChartSeries,
  seriesIndex: number,
  domain: { fromMs: number; toMs: number; timeZone: string },
  minimum: number,
  maximum: number,
): string {
  const colorIndex = safeColorIndex(series.colorIndex, seriesIndex);
  const segments: string[] = [];
  const areas: string[] = [];
  let segment: string[] = [];
  const areaPoints: Array<{ x: number; y: number }> = [];
  const points = averageChartPoints(series.points, series.averageWindow ?? 1, minimum, maximum);

  const finishSegment = () => {
    if (segment.length > 0) segments.push(segment.join(' '));
    if (areaPoints.length > 1) {
      const baseline = chartY(minimum, minimum, maximum);
      const first = areaPoints[0]!;
      const last = areaPoints.at(-1)!;
      const curve = areaPoints.map((point) => `L ${point.x},${point.y}`).join(' ');
      areas.push(
        `<path class="chart-area chart-series-${colorIndex}" d="M ${first.x},${baseline} ${curve} L ${last.x},${baseline} Z" />`,
      );
    }
    segment = [];
    areaPoints.length = 0;
  };

  points.forEach((point) => {
    const value = normalizedValue(point.value, minimum, maximum);
    if (value === null || point.gapBefore) {
      finishSegment();
      if (value === null) return;
    }
    const x = chartXAt(Date.parse(point.observedAt), domain.fromMs, domain.toMs);
    const y = chartY(value, minimum, maximum);
    segment.push(`${x},${y}`);
    areaPoints.push({ x, y });
  });
  finishSegment();

  const areaMarkup = areas.join('');
  const lineMarkup = segments
    .map(
      (pointsMarkup) =>
        `<polyline class="chart-line chart-series-${colorIndex}" points="${pointsMarkup}" />`,
    )
    .join('');
  const knownPointCount = points.filter(
    (point) => normalizedValue(point.value, minimum, maximum) !== null,
  ).length;
  const pointMarkup = points
    .map((point, index) => {
      const value = normalizedValue(series.points[index]?.value ?? null, minimum, maximum);
      if (value === null) return '';
      const x = chartXAt(Date.parse(point.observedAt), domain.fromMs, domain.toMs);
      const y = chartY(normalizedValue(point.value, minimum, maximum) ?? value, minimum, maximum);
      const valueText =
        series.unit === '%' ? formatRatioPercent(value) : `${value}${series.unit ?? ''}`;
      const tooltipTime = formatChartTooltipTime(point.observedAt, domain.timeZone);
      const label = `${series.label}, ${valueText}, ${tooltipTime}`;
      return `<g class="chart-point-hit chart-series-${colorIndex}" tabindex="0" focusable="true" role="img" aria-label="${escapeHtml(label)}" data-chart-point data-chart-series-key="${escapeHtml(series.key)}" data-chart-series-index="${colorIndex}" data-chart-series="${escapeHtml(series.label)}" data-chart-value="${escapeHtml(valueText)}" data-chart-timestamp="${escapeHtml(point.observedAt)}" data-chart-time="${escapeHtml(tooltipTime)}" data-chart-x="${x}" data-chart-y="${y}">
        <circle class="chart-hit-target" cx="${x}" cy="${y}" r="12" aria-hidden="true" />
        <circle class="chart-point-active${knownPointCount === 1 ? ' chart-point-single' : ''}" cx="${x}" cy="${y}" r="3.5" aria-hidden="true" />
        <title>${escapeHtml(label)}</title>
      </g>`;
    })
    .join('');
  return `${areaMarkup}${lineMarkup}${pointMarkup}`;
}

export function averageChartPoints(
  points: readonly ChartPoint[],
  requestedWindow: number,
  minimum: number,
  maximum: number,
): ChartPoint[] {
  const windowSize =
    Number.isSafeInteger(requestedWindow) && requestedWindow > 0
      ? Math.min(requestedWindow, ninePointAverageLimit)
      : 1;
  const leftRadius = Math.floor((windowSize - 1) / 2);
  const rightRadius = windowSize - leftRadius - 1;
  const averaged: ChartPoint[] = [];
  let run: ChartPoint[] = [];

  const finishRun = () => {
    run.forEach((point, index) => {
      const start = Math.max(0, index - leftRadius);
      const end = Math.min(run.length, index + rightRadius + 1);
      const values = run
        .slice(start, end)
        .map((item) => normalizedValue(item.value, minimum, maximum))
        .filter((value): value is number => value !== null);
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      const resetBoundary = point.smoothingBreakBefore || run[index + 1]?.smoothingBreakBefore;
      averaged.push({ ...point, value: resetBoundary ? point.value : average });
    });
    run = [];
  };

  for (const point of points) {
    const value = normalizedValue(point.value, minimum, maximum);
    if (value === null) {
      finishRun();
      averaged.push({ ...point, value: null });
      continue;
    }
    if ((point.gapBefore || point.smoothingBreakBefore) && run.length > 0) finishRun();
    run.push({ ...point, value });
  }
  finishRun();
  return averaged;
}

const ninePointAverageLimit = 9;

function normalizedValue(value: number | null, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function safeColorIndex(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 6 ? value : (fallback % 6) + 1;
}

function chartXAt(instantMs: number, fromMs: number, toMs: number): number {
  const span = toMs - fromMs;
  const ratio = span > 0 ? (instantMs - fromMs) / span : 0.5;
  return Math.round(PLOT_LEFT + Math.min(1, Math.max(0, ratio)) * (PLOT_RIGHT - PLOT_LEFT));
}

function resolveTimeDomain(
  requested: TimeSeriesChartInput['timeDomain'],
  points: readonly ChartPoint[],
): { fromMs: number; toMs: number; timeZone: string } {
  const requestedFrom = requested ? Date.parse(requested.fromAt) : Number.NaN;
  const requestedTo = requested ? Date.parse(requested.toAt) : Number.NaN;
  const validRequested =
    Number.isFinite(requestedFrom) && Number.isFinite(requestedTo) && requestedTo > requestedFrom;
  const validTimes = points.map((point) => Date.parse(point.observedAt)).filter(Number.isFinite);
  const fromMs = validRequested ? requestedFrom : (validTimes[0] ?? 0);
  const toMs = validRequested
    ? requestedTo
    : (validTimes.at(-1) ?? fromMs + 1) > fromMs
      ? (validTimes.at(-1) ?? fromMs + 1)
      : fromMs + 1;
  return { fromMs, toMs, timeZone: requested?.timeZone ?? 'UTC' };
}

function buildTimeTicks(fromMs: number, toMs: number, maximum: number): number[] {
  const count = Math.max(2, maximum);
  return Array.from(
    { length: count },
    (_, index) => fromMs + Math.round(((toMs - fromMs) * index) / (count - 1)),
  );
}

function chartY(value: number, minimum: number, maximum: number): number {
  const span = maximum - minimum;
  const normalized = span > 0 ? (value - minimum) / span : 0.5;
  return Math.round(PLOT_BOTTOM - normalized * (PLOT_BOTTOM - PLOT_TOP));
}

function displaySlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'unknown';
}

function parseDate(value: string): Date | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}
