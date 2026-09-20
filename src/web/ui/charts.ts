import { escapeHtml } from './layout.js';

export type ChartRange = '24h' | '7d' | '30d';

export interface ChartPoint {
  observedAt: string;
  value: number | null;
}

export interface ChartSeries {
  key: string;
  label: string;
  colorIndex: number;
  unit?: string;
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
  summary: readonly ChartSummaryItem[];
  series: readonly ChartSeries[];
  yAxis: {
    min: number;
    max: number;
    ticks: readonly number[];
    format: (value: number) => string;
  };
  footer: string;
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
  const tickIndices = buildTickIndices(referencePoints.length, MAX_TIME_TICKS);
  const tickMarkup = tickIndices
    .map((index) => {
      const point = referencePoints[index];
      if (!point) return '';
      const x = chartX(index, referencePoints.length);
      const anchor =
        referencePoints.length <= 1
          ? 'middle'
          : index === 0
            ? 'start'
            : index === referencePoints.length - 1
              ? 'end'
              : 'middle';
      return `<text class="chart-axis-label chart-axis-time" x="${x}" y="216" text-anchor="${anchor}">${escapeHtml(formatChartTick(point.observedAt, input.range))}</text>`;
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
      renderSeries(series, seriesIndex, referencePoints.length, input.yAxis.min, input.yAxis.max),
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
  const description = input.description
    ? `<p class="chart-description">${escapeHtml(input.description)}</p>`
    : '';

  return `<article class="card chart-card" aria-labelledby="${escapeHtml(titleId)}">
    <header class="chart-card-header">
      <div class="chart-heading">
        <span class="eyebrow">${escapeHtml(input.eyebrow ?? 'Usage window')}</span>
        <h3 id="${escapeHtml(titleId)}">${escapeHtml(input.title)}</h3>
        ${description}
      </div>
      <div class="chart-summary">${summaryMarkup}</div>
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
      <span class="chart-legend-context">${escapeHtml(input.footer)}</span>
    </div>
  </article>`;
}

export function renderChartEmptyState(message = 'No usage observations in this range'): string {
  return `<div class="chart-empty" role="status"><span class="chart-empty-mark" aria-hidden="true">—</span><strong>${escapeHtml(message)}</strong><p>Saved observations will appear here after the provider is checked.</p></div>`;
}

export function formatRatioPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatChartTick(value: string, range: ChartRange): string {
  const date = parseDate(value);
  if (!date) return 'unknown';
  if (range === '24h') {
    return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  }
  return `${date.getUTCDate()} ${monthName(date.getUTCMonth())}`;
}

export function formatChartTooltipTime(value: string): string {
  const date = parseDate(value);
  if (!date) return 'Time unavailable';
  return `${date.getUTCDate()} ${monthName(date.getUTCMonth())} ${date.getUTCFullYear()} · ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
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
  referenceLength: number,
  minimum: number,
  maximum: number,
): string {
  const colorIndex = safeColorIndex(series.colorIndex, seriesIndex);
  const segments: string[] = [];
  let segment: string[] = [];
  const points = series.points;

  points.forEach((point, index) => {
    const value = normalizedValue(point.value, minimum, maximum);
    if (value === null) {
      if (segment.length > 0) segments.push(segment.join(' '));
      segment = [];
      return;
    }
    segment.push(`${chartX(index, referenceLength)},${chartY(value, minimum, maximum)}`);
  });
  if (segment.length > 0) segments.push(segment.join(' '));

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
      const value = normalizedValue(point.value, minimum, maximum);
      if (value === null) return '';
      const x = chartX(index, referenceLength);
      const y = chartY(value, minimum, maximum);
      const valueText =
        series.unit === '%' ? formatRatioPercent(value) : `${value}${series.unit ?? ''}`;
      const tooltipTime = formatChartTooltipTime(point.observedAt);
      const label = `${series.label}, ${valueText}, ${tooltipTime}`;
      return `<g class="chart-point-hit chart-series-${colorIndex}" tabindex="0" focusable="true" role="img" aria-label="${escapeHtml(label)}" data-chart-point data-chart-series-key="${escapeHtml(series.key)}" data-chart-series-index="${colorIndex}" data-chart-series="${escapeHtml(series.label)}" data-chart-value="${escapeHtml(valueText)}" data-chart-timestamp="${escapeHtml(point.observedAt)}" data-chart-time="${escapeHtml(tooltipTime)}" data-chart-x="${x}" data-chart-y="${y}">
        <circle class="chart-hit-target" cx="${x}" cy="${y}" r="12" aria-hidden="true" />
        <circle class="chart-point-active${knownPointCount === 1 ? ' chart-point-single' : ''}" cx="${x}" cy="${y}" r="3.5" aria-hidden="true" />
        <title>${escapeHtml(label)}</title>
      </g>`;
    })
    .join('');
  return `${lineMarkup}${pointMarkup}`;
}

function normalizedValue(value: number | null, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function safeColorIndex(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 6 ? value : (fallback % 6) + 1;
}

function chartX(index: number, length: number): number {
  return length <= 1
    ? Math.round((PLOT_LEFT + PLOT_RIGHT) / 2)
    : Math.round(PLOT_LEFT + (index / (length - 1)) * (PLOT_RIGHT - PLOT_LEFT));
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

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function monthName(month: number): string {
  return (
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month] ??
    '???'
  );
}
