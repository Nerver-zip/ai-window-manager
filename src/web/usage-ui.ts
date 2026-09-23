import type { UsagePageData } from '../usage/service.js';
import {
  DEFAULT_HISTORY_RANGE,
  chartRangeKey,
  normalizeChartRanges,
  renderUsageSeries,
  serializeChartRangeSelection,
  type HistoryUsageSeries,
  type HistoryRange,
} from './logs-ui.js';
import { escapeHtml, renderAppShell } from './ui/layout.js';
import { providerDisplayName, timeZoneDisplayName, windowDisplayName } from './ui/presentation.js';

export interface UsagePageInput {
  data: UsagePageData;
  series: readonly HistoryUsageSeries[];
  chartRanges?: unknown;
  notice?: string | null;
}

export function renderUsagePage(input: UsagePageInput): string {
  const { data } = input;
  const chartRanges = normalizeChartRanges(input.chartRanges);
  const chartSeries = ensureWindowCharts(
    input.series,
    data.windows,
    data.selectedProviderId,
    chartRanges,
  );
  const providerId = data.selectedProviderId;
  const providerLabel = providerId ? providerDisplayName(providerId) : null;
  const selectedWindow = data.selectedWindowKind;
  const windowLabel =
    providerId && selectedWindow ? windowDisplayName(providerId, selectedWindow) : null;
  const selectedDay = data.selectedDay;
  const selectedDayIndex = data.days.findIndex((day) => day.localDate === selectedDay?.localDate);
  const focusDayIndex =
    selectedDayIndex >= 0
      ? selectedDayIndex
      : data.days.findIndex((day) => day.localDate === data.today);
  const providerFields =
    providerId && data.providers.length === 1
      ? `<input type="hidden" name="provider" value="${escapeHtml(providerId)}">`
      : '';
  const selectedDayField = selectedDay
    ? `<input type="hidden" name="day" value="${escapeHtml(selectedDay.localDate)}">`
    : '';
  const windowOptions = data.windows
    .map((window) => {
      const label = windowDisplayName(window.providerId, window.windowKind);
      return `<option value="${escapeHtml(window.windowKind)}"${window.windowKind === selectedWindow ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');
  const providerOptions = data.providers
    .map(
      (provider) =>
        `<option value="${escapeHtml(provider.id)}"${provider.id === providerId ? ' selected' : ''}>${escapeHtml(providerDisplayName(provider.id))}</option>`,
    )
    .join('');
  const preservedRanges = chartSeries
    .map((series) => {
      const range =
        series.range ??
        chartRanges[chartRangeKey(series.providerId, series.windowKind)] ??
        DEFAULT_HISTORY_RANGE;
      return `<input type="hidden" name="chartRange" value="${escapeHtml(serializeChartRangeSelection(series.providerId, series.windowKind, range))}">`;
    })
    .join('');
  const dataStatus = data.aggregationPending
    ? '<p class="usage-notice" role="status">Preparing saved usage history. The heatmap will fill in as existing samples are processed.</p>'
    : '';
  const notice = input.notice
    ? `<p class="usage-notice" role="status">${escapeHtml(input.notice)}</p>`
    : '';
  const hasWeeklyData = Boolean(providerId && selectedWindow);
  const calendar = hasWeeklyData
    ? renderCalendar(
        data,
        providerId!,
        selectedWindow!,
        selectedDayIndex,
        focusDayIndex,
        chartRanges,
        chartSeries,
      )
    : '<div class="usage-empty" role="status"><h3>Weekly usage is not available yet</h3><p>Saved weekly usage observations will appear here. Usage charts remain available below.</p></div>';
  const detail = hasWeeklyData
    ? renderSelectedDay(selectedDay, data.today, data.timezone, providerLabel!, windowLabel!)
    : '';
  const chartSection = renderUsageSeries(chartSeries, {
    timelineRange: DEFAULT_HISTORY_RANGE,
    providerId,
    chartRanges,
    ...(selectedDay ? { selectedDay: selectedDay.localDate } : {}),
    selectedWindowKind: selectedWindow,
    timeZone: data.timezone,
    toAt: new Date(data.generatedAtMs).toISOString(),
  });

  const content = `<div class="usage-page">
    ${notice}${dataStatus}
    <section class="usage-controls" aria-label="Usage filters">
      <div class="usage-controls-copy"><span class="eyebrow">Your activity</span><h2>Usage by day</h2><p>Weekly allowance used, based on saved provider updates.</p><p class="usage-timezone">Calendar dates use ${escapeHtml(timeZoneDisplayName(data.timezone))} · <a href="/settings">Change in Settings</a></p></div>
      <form method="get" action="/usage" class="usage-filter-form" aria-label="Usage filters">
        ${preservedRanges}${selectedDayField}${providerFields}
        <label class="field"><span class="field-label">Provider</span><select name="provider"${data.providers.length <= 1 ? ' disabled' : ''}>${providerOptions}</select></label>
        ${data.windows.length > 1 ? `<label class="field"><span class="field-label">Usage window</span><select name="window">${windowOptions}</select></label>` : selectedWindow ? `<input type="hidden" name="window" value="${escapeHtml(selectedWindow)}">` : ''}
        <button class="button button-secondary" type="submit">Update view</button>
      </form>
    </section>
    ${chartSection}
    ${calendar}
    ${detail}
  </div>`;

  return renderAppShell({
    page: 'usage',
    title: 'Usage',
    description: 'See how your weekly allowance changes over time.',
    content,
  });
}

function ensureWindowCharts(
  series: readonly HistoryUsageSeries[],
  windows: UsagePageData['windows'],
  selectedProviderId: string | null,
  chartRanges: Readonly<Record<string, HistoryRange>>,
): HistoryUsageSeries[] {
  if (!selectedProviderId) return [...series];
  const result = [...series];
  const existing = new Set(
    result.filter((item) => item.providerId === selectedProviderId).map((item) => item.windowKind),
  );
  for (const window of windows) {
    if (window.providerId !== selectedProviderId || existing.has(window.windowKind)) continue;
    result.push({
      providerId: selectedProviderId,
      windowKind: window.windowKind,
      range:
        chartRanges[chartRangeKey(selectedProviderId, window.windowKind)] ?? DEFAULT_HISTORY_RANGE,
      points: [],
    });
    existing.add(window.windowKind);
  }
  return result;
}

function renderCalendar(
  data: UsagePageData,
  providerId: string,
  windowKind: string,
  selectedIndex: number,
  focusIndex: number,
  ranges: Readonly<Record<string, HistoryRange>>,
  series: readonly HistoryUsageSeries[],
): string {
  const firstDate = data.days[0]?.localDate;
  if (!firstDate || data.days.length === 0) {
    return '<div class="usage-empty" role="status"><h3>No saved usage yet</h3><p>New observations will be shown here after the provider is checked.</p></div>';
  }
  const firstOffset = weekday(firstDate);
  const cells: Array<string | null> = [
    ...Array<string | null>(firstOffset).fill(null),
    ...data.days.map((day) => day.localDate),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  const monthSeen = new Set<string>();
  const monthMarkup = weeks
    .map((week) => {
      const firstReal = week.find((date): date is string => date !== null);
      const month = firstReal ? firstReal.slice(0, 7) : '';
      const monthLabel =
        firstReal && !monthSeen.has(month)
          ? (monthSeen.add(month),
            new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(
              new Date(`${firstReal}T12:00:00Z`),
            ))
          : '';
      return `<span class="usage-month">${escapeHtml(monthLabel)}</span>`;
    })
    .join('');
  const rowsMarkup = Array.from({ length: 7 }, (_, rowIndex) => {
    const cellsMarkup = weeks
      .map((week, columnIndex) => {
        const date = week[rowIndex] ?? null;
        if (!date) return '<span class="usage-cell-spacer" aria-hidden="true"></span>';
        const dayIndex = data.days.findIndex((day) => day.localDate === date);
        const day = data.days[dayIndex]!;
        const selected = dayIndex === selectedIndex;
        const tabbable = dayIndex === focusIndex;
        return `<a class="usage-cell usage-level-${intensity(day.usagePercentagePoints)} usage-${day.status}${selected ? ' is-selected' : ''}${date === data.today ? ' is-today' : ''}" href="${escapeHtml(dayHref(date, providerId, windowKind, ranges, series))}" role="gridcell" aria-rowindex="${rowIndex + 1}" aria-colindex="${columnIndex + 1}" aria-selected="${selected}" aria-label="${escapeHtml(cellLabel(day, data.today))}" data-usage-cell data-usage-index="${dayIndex}" tabindex="${tabbable ? '0' : '-1'}"></a>`;
      })
      .join('');
    return `<div class="usage-calendar-row" role="row">${cellsMarkup}</div>`;
  }).join('');
  const list = [...data.days]
    .reverse()
    .map(
      (day) =>
        `<li><a href="${escapeHtml(dayHref(day.localDate, providerId, windowKind, ranges, series))}"><time datetime="${escapeHtml(day.localDate)}">${escapeHtml(formatLocalDate(day.localDate))}</time><span>${escapeHtml(cellSummary(day))}</span></a></li>`,
    )
    .join('');
  return `<section class="usage-calendar-section" aria-labelledby="daily-usage-heading">
    <div class="section-heading"><div><span class="eyebrow">Daily usage</span><h2 id="daily-usage-heading">${escapeHtml(windowDisplayName(providerId, windowKind))}</h2><p class="muted">Approximate percentage points of the weekly allowance used per day.</p></div><span class="section-count">${escapeHtml(data.fromDate)} – ${escapeHtml(data.today)}</span></div>
    <div class="usage-calendar-layout">
      <div class="usage-weekdays" aria-hidden="true"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
      <div class="usage-calendar-scroll" tabindex="0" aria-label="Scrollable usage calendar">
        <div class="usage-calendar-track">
          <div class="usage-calendar-months" aria-hidden="true">${monthMarkup}</div>
          <div class="usage-calendar" role="grid" aria-label="Daily weekly allowance usage from ${escapeHtml(data.fromDate)} through ${escapeHtml(data.today)}" aria-rowcount="7" aria-colcount="${weeks.length}" data-usage-grid>${rowsMarkup}</div>
        </div>
      </div>
    </div>
    <div class="usage-legend" aria-label="Usage intensity legend">
      <span class="usage-legend-item"><span class="usage-swatch usage-no_data" aria-hidden="true"></span>No data</span>
      <span class="usage-legend-item"><span class="usage-swatch usage-level-0" aria-hidden="true"></span>0 observed</span>
      <span class="usage-legend-item"><span class="usage-swatch usage-level-1" aria-hidden="true"></span>&gt;0–5 points</span>
      <span class="usage-legend-item"><span class="usage-swatch usage-level-2" aria-hidden="true"></span>&gt;5–15</span>
      <span class="usage-legend-item"><span class="usage-swatch usage-level-3" aria-hidden="true"></span>&gt;15–30</span>
      <span class="usage-legend-item"><span class="usage-swatch usage-level-4" aria-hidden="true"></span>&gt;30</span>
      <span class="usage-legend-item"><span class="usage-swatch usage-level-2 usage-partial" aria-hidden="true"></span>Partial data</span>
      <span class="usage-legend-note">A recorded zero does not rule out unobserved use.</span>
    </div>
    <details class="usage-day-list"><summary>Browse days as a list</summary><ol>${list}</ol></details>
  </section>`;
}

function renderSelectedDay(
  day: UsagePageData['selectedDay'],
  today: string,
  timeZone: string,
  providerLabel: string,
  windowLabel: string,
): string {
  if (!day) {
    return '<section class="usage-day-detail" aria-live="polite"><h3>Selected date is outside the available range</h3><p>Choose a date within the displayed year.</p></section>';
  }
  const dateLabel = new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${day.localDate}T12:00:00Z`));
  let summary: string;
  if (day.status === 'no_data') summary = 'No saved observations for this day.';
  else if (day.usagePercentagePoints === null)
    summary = 'Some usage could not be assigned to this date.';
  else if (day.usagePercentagePoints === 0)
    summary = 'No increase was observed in the available data.';
  else
    summary = `Approximately ${formatPoints(day.usagePercentagePoints)}% of the weekly allowance was used in the observed intervals.`;
  const quality =
    day.status === 'observed'
      ? 'Good observation coverage'
      : day.status === 'partial'
        ? 'Partial data'
        : 'No data';
  const reasons =
    day.reasons.length > 0
      ? '<p class="usage-quality-note">Daily total may be incomplete.</p>'
      : '';
  return `<section class="usage-day-detail" aria-live="polite" aria-labelledby="usage-day-title"><div><span class="eyebrow">Selected day</span><h3 id="usage-day-title">${escapeHtml(dateLabel)}</h3><p class="usage-day-summary">${escapeHtml(summary)}</p><p class="muted">${escapeHtml(providerLabel)} · ${escapeHtml(windowLabel)} · ${escapeHtml(quality)} · ${formatHours(day.coverageSeconds)} observed${day.localDate === today ? ' · Today · in progress' : ''} · ${escapeHtml(timeZoneDisplayName(timeZone))}</p>${reasons}</div></section>`;
}

function cellLabel(day: UsagePageData['days'][number], today: string): string {
  const readableDate = formatLocalDate(day.localDate);
  const current = day.localDate === today ? 'Today · in progress; ' : '';
  if (day.status === 'no_data') return `${readableDate}; ${current}no saved observations`;
  if (day.usagePercentagePoints === null)
    return `${readableDate}; ${current}partial data, amount unavailable`;
  if (day.usagePercentagePoints === 0)
    return `${readableDate}; ${current}no increase observed in saved data`;
  if (day.status === 'partial')
    return `${readableDate}; ${current}approximately ${formatPoints(day.usagePercentagePoints)} percentage points used; partial data`;
  return `${readableDate}; ${current}${formatPoints(day.usagePercentagePoints)} percentage points used`;
}

function cellSummary(day: UsagePageData['days'][number]): string {
  if (day.status === 'no_data') return 'No data';
  if (day.usagePercentagePoints === null) return 'Partial · amount unknown';
  const amount = `${formatPoints(day.usagePercentagePoints)}% used`;
  return day.status === 'partial' ? `${amount} · partial` : amount;
}

function intensity(value: number | null): number {
  if (value === null || value <= 0) return 0;
  if (value <= 5) return 1;
  if (value <= 15) return 2;
  if (value <= 30) return 3;
  return 4;
}

function formatPoints(value: number): string {
  return new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value);
}

function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(hours)}h`;
}

function formatLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return 'Date unavailable';
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
}

function weekday(value: string): number {
  const day = new Date(`${value}T12:00:00Z`).getUTCDay();
  return (day + 6) % 7;
}

function dayHref(
  day: string,
  providerId: string,
  windowKind: string,
  ranges: Readonly<Record<string, HistoryRange>>,
  series: readonly HistoryUsageSeries[],
): string {
  const query = new URLSearchParams({ provider: providerId, window: windowKind, day });
  for (const item of series) {
    const range =
      item.range ??
      ranges[chartRangeKey(item.providerId, item.windowKind)] ??
      DEFAULT_HISTORY_RANGE;
    query.append(
      'chartRange',
      serializeChartRangeSelection(item.providerId, item.windowKind, range),
    );
  }
  return `/usage?${query.toString()}`;
}
