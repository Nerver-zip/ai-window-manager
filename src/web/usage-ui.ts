import type { UsagePageData } from '../usage/service.js';
import { classifyWindowCadence } from '../domain/window-target.js';
import {
  DEFAULT_HISTORY_RANGE,
  chartRangeKey,
  normalizeChartRanges,
  renderUsageSeries,
  serializeChartRangeSelection,
  type HistoryUsageSeries,
  type HistoryRange,
} from './logs-ui.js';
import escapeHtml from 'escape-html';
import { renderAppShell } from './ui/layout.js';
import {
  providerDisplayName,
  timeZoneDisplayName,
  windowDisplayName,
  windowGroupDisplayName,
} from './ui/presentation.js';
import { renderProviderPickerLinks } from './ui/provider-picker.js';

export interface UsagePageInput {
  data: UsagePageData;
  series: readonly HistoryUsageSeries[];
  chartRanges?: unknown;
  notice?: string | null;
}

const ANTIGRAVITY_CHART_WINDOWS = [
  'antigravity_gemini_five_hour',
  'antigravity_gemini_weekly',
  'antigravity_claude_gpt_five_hour',
  'antigravity_claude_gpt_weekly',
] as const;

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
  const weeklyWindows = providerId
    ? data.windows.filter(
        (window) =>
          window.providerId === providerId &&
          classifyWindowCadence({ windowKind: window.windowKind }) === 'weekly',
      )
    : [];
  const selectedWeeklyWindow = weeklyWindows.find(
    (window) => window.windowKind === data.selectedWindowKind,
  );
  const selectedDay = selectedWeeklyWindow ? data.selectedDay : null;
  const selectedDayIndex = selectedWeeklyWindow
    ? data.days.findIndex((day) => day.localDate === selectedDay?.localDate)
    : -1;
  const focusDayIndex =
    selectedDayIndex >= 0
      ? selectedDayIndex
      : data.days.findIndex((day) => day.localDate === data.today);
  const providerPicker = renderProviderPickerLinks({
    legend: 'Provider',
    options: data.providers.map((provider) => ({
      value: provider.id,
      label: provider.label || providerDisplayName(provider.id, provider.kind),
      ...(provider.kind ? { kind: provider.kind } : {}),
      ...(provider.configured !== undefined ? { configured: provider.configured } : {}),
      ...(provider.statusLabel !== undefined ? { statusLabel: provider.statusLabel } : {}),
    })),
    selectedValue: providerId,
    getHref: (provider) => usageProviderHref(provider.value, chartRanges, selectedDay?.localDate),
    emptyText: 'No providers available.',
  });
  const dataStatus = data.aggregationPending
    ? '<p class="usage-notice" role="status">Preparing saved usage history. The heatmap will fill in as existing samples are processed.</p>'
    : '';
  const notice = input.notice
    ? `<p class="usage-notice" role="status">${escapeHtml(input.notice)}</p>`
    : '';
  const hasWeeklyData = Boolean(providerId && selectedWeeklyWindow);
  const calendar =
    providerId && weeklyWindows.length > 0
      ? renderCalendar(
          data,
          providerId,
          selectedWeeklyWindow?.windowKind ?? null,
          weeklyWindows,
          selectedDayIndex,
          focusDayIndex,
          chartRanges,
          chartSeries,
        )
      : '<div class="usage-empty" role="status"><h3>Weekly usage is not available yet</h3><p>Saved weekly usage observations will appear here. Usage charts remain available below.</p></div>';
  const detail = hasWeeklyData
    ? renderSelectedDay(
        selectedDay,
        data.today,
        data.timezone,
        providerLabel!,
        heatmapWindowLabel(providerId!, selectedWeeklyWindow!.windowKind),
      )
    : '';
  const seriesTitles = Object.fromEntries(
    chartSeries.map((item) => {
      const windowTitle = windowDisplayName(item.providerId, item.windowKind);
      const family = windowGroupDisplayName(item.windowKind);
      const title = family
        ? `${family} · ${windowTitle}`
        : `${providerDisplayName(item.providerId)} / ${windowTitle}`;
      return [chartRangeKey(item.providerId, item.windowKind), title];
    }),
  );
  const chartMarkup = renderUsageSeries(chartSeries, {
    timelineRange: DEFAULT_HISTORY_RANGE,
    providerId,
    chartRanges,
    seriesTitles,
    selectedWindowKind: data.selectedWindowKind,
    ...(selectedDay ? { selectedDay: selectedDay.localDate } : {}),
    timeZone: data.timezone,
    toAt: new Date(data.generatedAtMs).toISOString(),
  });

  const content = `<div class="usage-page">
    ${notice}${dataStatus}
    <section class="usage-controls" aria-label="Usage filters">
      <div class="usage-controls-copy"><span class="eyebrow">Your activity</span><h2>Usage by day</h2><p>Weekly allowance used, based on saved provider updates.</p><p class="usage-timezone">Calendar dates use ${escapeHtml(timeZoneDisplayName(data.timezone))} · <a href="/settings">Change in Settings</a></p></div>
      <div class="usage-filter-panel">${providerPicker}</div>
    </section>
    ${chartMarkup}
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

function usageProviderHref(
  providerId: string,
  chartRanges: Readonly<Record<string, HistoryRange>>,
  selectedDay?: string,
): string {
  const query = new URLSearchParams({ provider: providerId });
  if (selectedDay) query.set('day', selectedDay);
  for (const [key, range] of Object.entries(chartRanges)) {
    const separator = key.indexOf('\u0000');
    if (separator <= 0 || separator === key.length - 1) continue;
    query.append(
      'chartRange',
      serializeChartRangeSelection(key.slice(0, separator), key.slice(separator + 1), range),
    );
  }
  return `/usage?${query.toString()}`;
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
  if (selectedProviderId === 'antigravity') {
    for (const windowKind of ANTIGRAVITY_CHART_WINDOWS) {
      if (existing.has(windowKind)) continue;
      result.push({
        providerId: selectedProviderId,
        windowKind,
        range: chartRanges[chartRangeKey(selectedProviderId, windowKind)] ?? DEFAULT_HISTORY_RANGE,
        points: [],
      });
      existing.add(windowKind);
    }
    const order = new Map(
      ANTIGRAVITY_CHART_WINDOWS.map((windowKind, index) => [windowKind, index]),
    );
    result.sort(
      (left, right) =>
        (order.get(left.windowKind as (typeof ANTIGRAVITY_CHART_WINDOWS)[number]) ?? 99) -
        (order.get(right.windowKind as (typeof ANTIGRAVITY_CHART_WINDOWS)[number]) ?? 99),
    );
  }
  return result;
}

function heatmapWindowLabel(providerId: string, windowKind: string): string {
  const family = windowGroupDisplayName(windowKind);
  const cadence = windowDisplayName(providerId, windowKind);
  return family ? `${family} · ${cadence}` : cadence;
}

function renderCalendar(
  data: UsagePageData,
  providerId: string,
  windowKind: string | null,
  weeklyWindows: UsagePageData['windows'],
  selectedIndex: number,
  focusIndex: number,
  ranges: Readonly<Record<string, HistoryRange>>,
  series: readonly HistoryUsageSeries[],
): string {
  const sourceSelector = renderDailyUsageFamilySelector(
    data,
    providerId,
    windowKind,
    weeklyWindows,
    ranges,
    series,
  );
  const selectedFamilyLabel = windowKind ? heatmapWindowLabel(providerId, windowKind) : null;
  if (!windowKind) {
    const prompt =
      weeklyWindows.length > 1
        ? 'Choose a weekly family to display daily usage.'
        : 'Choose the weekly usage source to display daily usage.';
    const recoveryLink =
      weeklyWindows.length === 1
        ? `<a class="button button-secondary" href="${escapeHtml(weeklyWindowHref(providerId, weeklyWindows[0]!.windowKind, data.selectedDay?.localDate, ranges, series))}">Show weekly usage</a>`
        : '';
    return `<section class="usage-calendar-section" aria-labelledby="daily-usage-heading">
      <div class="section-heading"><div><span class="eyebrow">Daily usage</span><h2 id="daily-usage-heading">Weekly allowance</h2><p class="muted">Approximate percentage points of the weekly allowance used per day.</p></div><div class="usage-filter-panel">${sourceSelector}</div></div>
      <div class="usage-empty" role="status"><h3>Weekly view not selected</h3><p>${escapeHtml(prompt)}</p>${recoveryLink}</div>
    </section>`;
  }
  const firstDate = data.days[0]?.localDate;
  if (!firstDate || data.days.length === 0) {
    return `<section class="usage-calendar-section" aria-labelledby="daily-usage-heading">
      <div class="section-heading"><div><span class="eyebrow">Daily usage</span><h2 id="daily-usage-heading">${escapeHtml(selectedFamilyLabel)}</h2><p class="muted">Approximate percentage points of the weekly allowance used per day.</p></div><div class="usage-filter-panel">${sourceSelector}</div></div>
      <div class="usage-empty" role="status"><h3>No saved usage yet</h3><p>New observations will be shown here after the provider is checked.</p></div>
    </section>`;
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
  return `<section class="usage-calendar-section" aria-labelledby="daily-usage-heading">
    <div class="section-heading"><div><span class="eyebrow">Daily usage</span><h2 id="daily-usage-heading">${escapeHtml(selectedFamilyLabel)}</h2><p class="muted">Approximate percentage points of the weekly allowance used per day.</p></div><div class="usage-filter-panel"><span class="section-count">${escapeHtml(data.fromDate)} – ${escapeHtml(data.today)}</span>${sourceSelector}</div></div>
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
    </div>
  </section>`;
}

function renderDailyUsageFamilySelector(
  data: UsagePageData,
  providerId: string,
  selectedWindowKind: string | null,
  weeklyWindows: UsagePageData['windows'],
  ranges: Readonly<Record<string, HistoryRange>>,
  series: readonly HistoryUsageSeries[],
): string {
  const families = new Map<string, UsagePageData['windows'][number]>();
  for (const window of weeklyWindows) {
    const family = windowGroupDisplayName(window.windowKind);
    if (family) families.set(family, families.get(family) ?? window);
  }
  const options = [...families.entries()];
  if (options.length <= 1) return '';

  const chartRanges = series
    .map((item) => {
      const range =
        item.range ??
        ranges[chartRangeKey(item.providerId, item.windowKind)] ??
        DEFAULT_HISTORY_RANGE;
      return `<input type="hidden" name="chartRange" value="${escapeHtml(serializeChartRangeSelection(item.providerId, item.windowKind, range))}">`;
    })
    .join('');
  const selectedDay = data.selectedDay
    ? `<input type="hidden" name="day" value="${escapeHtml(data.selectedDay.localDate)}">`
    : '';
  const familyOptions = options
    .map(
      ([label, window]) =>
        `<option value="${escapeHtml(window.windowKind)}"${window.windowKind === selectedWindowKind ? ' selected' : ''}>${escapeHtml(label)}</option>`,
    )
    .join('');
  const needsChoice = !options.some(([, window]) => window.windowKind === selectedWindowKind);
  const placeholder = needsChoice
    ? '<option value="" selected disabled>Choose a family</option>'
    : '';
  return `<form method="get" action="/usage" class="usage-filter-form" aria-label="Daily usage family" data-usage-filter-auto-submit><input type="hidden" name="provider" value="${escapeHtml(providerId)}">${chartRanges}${selectedDay}<label class="field"><span class="field-label">Daily usage family</span><select name="window">${placeholder}${familyOptions}</select></label><noscript><button class="button button-secondary" type="submit">Update view</button></noscript></form>`;
}

function weeklyWindowHref(
  providerId: string,
  windowKind: string,
  selectedDay: string | undefined,
  ranges: Readonly<Record<string, HistoryRange>>,
  series: readonly HistoryUsageSeries[],
): string {
  const query = new URLSearchParams({ provider: providerId, window: windowKind });
  if (selectedDay) query.set('day', selectedDay);
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
