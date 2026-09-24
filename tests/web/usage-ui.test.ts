import { describe, expect, it } from 'vitest';
import { shiftLocalDate } from '../../src/scheduler/time.js';
import type { DailyUsageCell } from '../../src/usage/aggregation.js';
import type { UsagePageData } from '../../src/usage/service.js';
import { renderUsagePage } from '../../src/web/usage-ui.js';
import type { HistoryUsageSeries } from '../../src/web/logs-ui.js';

const today = '2026-09-23';
const nowMs = Date.parse('2026-09-23T12:00:00.000Z');

function pageData(overrides: Partial<UsagePageData> = {}): UsagePageData {
  const fromDate = shiftLocalDate(today, -364);
  const days: DailyUsageCell[] = Array.from({ length: 365 }, (_, index) => {
    const localDate = shiftLocalDate(fromDate, index);
    return {
      localDate,
      usagePercentagePoints: null as number | null,
      status: 'no_data',
      coverageSeconds: 0,
      daySeconds: 86_400,
      reasons: [] as string[],
    };
  });
  days[362] = {
    ...days[362]!,
    usagePercentagePoints: 0,
    status: 'observed',
    coverageSeconds: 80_000,
  };
  days[363] = {
    ...days[363]!,
    usagePercentagePoints: 12.5,
    status: 'partial',
    coverageSeconds: 24_000,
    reasons: ['OBSERVATION_GAP'],
  };
  days[364] = {
    ...days[364]!,
    usagePercentagePoints: 3.2,
    status: 'partial',
    coverageSeconds: 8_000,
  };
  return {
    timezone: 'America/Sao_Paulo',
    today,
    fromDate,
    days,
    selectedDay: days[363],
    providers: [{ id: 'codex', label: 'Codex' }],
    selectedProviderId: 'codex',
    windows: [{ providerId: 'codex', windowKind: 'weekly' }],
    selectedWindowKind: 'weekly',
    aggregationPending: false,
    generatedAtMs: nowMs,
    ...overrides,
  };
}

function charts(): HistoryUsageSeries[] {
  return [
    {
      providerId: 'codex',
      windowKind: 'weekly',
      range: '6h',
      points: [
        { observedAt: '2026-09-23T06:00:00.000Z', usageRatio: 0.2, remainingRatio: 0.8 },
        { observedAt: '2026-09-23T12:00:00.000Z', usageRatio: 0.3, remainingRatio: 0.7 },
      ],
    },
  ];
}

describe('Usage page', () => {
  it('renders an accessible annual heatmap, selected-day detail and independent chart control', () => {
    const html = renderUsagePage({
      data: pageData(),
      series: charts(),
      chartRanges: ['codex|weekly|6h'],
    });
    expect(html).toContain('<h1>Usage</h1>');
    expect(html).toContain('aria-label="Daily weekly allowance usage');
    expect(html).toContain('aria-rowcount="7"');
    expect(html.match(/class="usage-calendar-row" role="row"/g)).toHaveLength(7);
    expect(html.match(/class="usage-cell usage-level-/g)).toHaveLength(365);
    expect(html).not.toMatch(/class="usage-calendar-track"[^>]*style=/);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('usage-level-2 usage-partial');
    expect(html).toContain('Daily total may be incomplete.');
    expect(html).not.toContain('Some activity could not be assigned confidently');
    expect(html).toContain('Browse days as a list');
    expect(html).toContain('Calendar dates use São Paulo');
    expect(html).not.toContain('America/Sao_Paulo');
    expect(html).toContain('data-chart-root');
    expect(html.indexOf('id="usage-title"')).toBeLessThan(html.indexOf('id="daily-usage-heading"'));
    expect(html).toContain('aria-label="Period for Codex / Weekly window"');
    expect(html).toContain('<option value="codex|weekly|6h" selected>6h</option>');
    expect(html).toContain('action="/usage"');
    expect(html).toContain('Approximately 12.5%');
    expect(html).toContain('&gt;0–5 points');
    expect(html).toContain('no increase observed');
    expect(html).not.toContain('official_supported');
    expect(html).not.toContain('codex_weekly');
  });

  it('renders missing weekly information and preparation as explicit states', () => {
    const data = pageData({ windows: [], selectedWindowKind: null, aggregationPending: true });
    const html = renderUsagePage({ data, series: [] });
    expect(html).toContain('Preparing saved usage history');
    expect(html).toContain('Weekly usage is not available yet');
    expect(html).toContain('Usage over time');
    expect(html).not.toContain('data-usage-grid');
  });

  it('does not fabricate a zero in the detail for days without samples', () => {
    const data = pageData({ selectedDay: pageData().days[100]! });
    const html = renderUsagePage({ data, series: [] });
    expect(html).toContain('No saved observations for this day.');
    expect(html).not.toContain('0% of the weekly allowance was used');
  });

  it('keeps each known window chart and its period when that interval has no samples', () => {
    const html = renderUsagePage({
      data: pageData(),
      series: [],
      chartRanges: ['codex|weekly|3h'],
    });

    expect(html).toContain('aria-label="Time range for Codex / Weekly window"');
    expect(html).toContain('<option value="codex|weekly|3h" selected>3h</option>');
    expect(html).toContain('Waiting for a valid observation');
    expect(html.indexOf('id="usage-title"')).toBeLessThan(html.indexOf('id="daily-usage-heading"'));
  });

  it('renders all intensity bands, multi-provider/window controls and a keyboard entry on an invalid day', () => {
    const data = pageData({
      selectedDay: null,
      providers: [
        { id: 'codex', label: 'Codex' },
        { id: 'antigravity', label: 'Antigravity' },
      ],
      windows: [
        { providerId: 'codex', windowKind: 'weekly' },
        { providerId: 'codex', windowKind: 'five_hour' },
      ],
    });
    const values = [0, 0.1, 5, 5.1, 15, 15.1, 30, 30.1];
    values.forEach((value, index) => {
      data.days[index] = {
        ...data.days[index]!,
        usagePercentagePoints: value,
        status: 'observed',
      };
    });
    const noRangeSeries: HistoryUsageSeries[] = charts().map((series) => ({
      providerId: series.providerId,
      windowKind: series.windowKind,
      points: series.points,
    }));
    noRangeSeries.push({
      providerId: 'codex',
      windowKind: 'five_hour',
      points: [],
    });
    const html = renderUsagePage({
      data,
      series: noRangeSeries,
      chartRanges: ['codex|weekly|6h', 'codex|five_hour|3h'],
      notice: '<refreshing>',
    });

    for (let level = 0; level <= 4; level += 1) expect(html).toContain(`usage-level-${level}`);
    expect(html).toContain('&lt;refreshing&gt;');
    expect(html).toContain('outside the available range');
    expect(html).toContain('name="window"><option value="weekly" selected>');
    expect(html).toContain('option value="five_hour"');
    expect(html).toContain(
      'href="/usage?provider=codex&amp;chartRange=codex%7Cweekly%7C6h&amp;chartRange=codex%7Cfive_hour%7C3h" data-configured="unknown" aria-current="page"',
    );
    expect(html).toMatch(/href="\/usage\?provider=antigravity(?:&amp;chartRange=[^"]+)+"/);
    expect(html).not.toContain('class="provider-picker-input"');
    expect(html).toContain('class="provider-picker provider-picker-navigation"');
    expect(html).toContain(
      'class="usage-filter-form" aria-label="Usage window" data-usage-filter-auto-submit',
    );
    expect(html).toContain(
      '<noscript><button class="button button-secondary" type="submit">Update view</button></noscript>',
    );
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('<option value="codex|five_hour|3h" selected>3h</option>');
  });

  it('handles an empty weekly history without rendering an empty calendar grid', () => {
    const html = renderUsagePage({
      data: pageData({ days: [], selectedDay: null }),
      series: [],
    });
    expect(html).toContain('No saved usage yet');
    expect(html).toContain('outside the available range');
    expect(html).not.toContain('data-usage-grid');
  });
});
