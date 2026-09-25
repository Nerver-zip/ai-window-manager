import { describe, expect, it } from 'vitest';
import { shiftLocalDate } from '../../src/scheduler/time.js';
import type { DailyUsageCell } from '../../src/usage/aggregation.js';
import type { UsagePageData } from '../../src/usage/service.js';
import { renderUsagePage } from '../../src/web/usage-ui.js';
import type { HistoryUsageSeries } from '../../src/web/logs-ui.js';

const today = '2026-09-23';
const nowMs = Date.parse('2026-09-23T12:00:00.000Z');
const antigravityWindows = [
  'antigravity_gemini_five_hour',
  'antigravity_gemini_weekly',
  'antigravity_claude_gpt_five_hour',
  'antigravity_claude_gpt_weekly',
] as const;

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

function antigravityData(overrides: Partial<UsagePageData> = {}): UsagePageData {
  return pageData({
    providers: [{ id: 'antigravity', label: 'Antigravity' }],
    selectedProviderId: 'antigravity',
    windows: antigravityWindows.map((windowKind) => ({
      providerId: 'antigravity',
      windowKind,
    })),
    selectedWindowKind: 'antigravity_gemini_weekly',
    ...overrides,
  });
}

function chartCards(html: string): string[] {
  return [...html.matchAll(/<article class="card chart-card"[\s\S]*?<\/article>/g)].map(
    ([card]) => card,
  );
}

describe('Usage page', () => {
  it('renders an accessible annual heatmap without a global window selector or alternate day list', () => {
    const html = renderUsagePage({
      data: pageData(),
      series: charts(),
      chartRanges: ['codex|weekly|6h'],
    });
    expect(html).toContain('<h1>Usage</h1>');
    expect(html).toContain('aria-label="Daily weekly allowance usage');
    expect(html).toContain('aria-rowcount="7"');
    expect(html.match(/class="usage-calendar-row" role="row"/g)).toHaveLength(7);
    const gridCells = [...html.matchAll(/<a class="usage-cell[^>]*role="gridcell"[^>]*>/g)];
    expect(gridCells).toHaveLength(365);
    expect(gridCells.every(([cell]) => /aria-label="[^"]+"/.test(cell))).toBe(true);
    expect(gridCells.every(([cell]) => /aria-rowindex="\d+"/.test(cell))).toBe(true);
    expect(gridCells.every(([cell]) => /aria-colindex="\d+"/.test(cell))).toBe(true);
    expect(gridCells.filter(([cell]) => /tabindex="0"/.test(cell))).toHaveLength(1);
    expect(gridCells.filter(([cell]) => /tabindex="-1"/.test(cell))).toHaveLength(364);
    expect(html).not.toMatch(/class="usage-calendar-track"[^>]*style=/);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('usage-level-2 usage-partial');
    expect(html).toContain('Daily total may be incomplete.');
    expect(html).not.toContain('Some activity could not be assigned confidently');
    expect(html).not.toContain('Browse days as a list');
    expect(html).not.toContain('usage-day-list');
    expect(html).not.toContain('A recorded zero does not rule out unobserved use.');
    expect(html).not.toMatch(/<select name="window"/);
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

  it('shows all four Antigravity family/cadence charts with independent periods and no machine-key headings', () => {
    const ranges = [
      'antigravity|antigravity_gemini_five_hour|1h',
      'antigravity|antigravity_gemini_weekly|6h',
      'antigravity|antigravity_claude_gpt_five_hour|12h',
      'antigravity|antigravity_claude_gpt_weekly|30d',
    ];
    const html = renderUsagePage({
      data: antigravityData(),
      series: [],
      chartRanges: ranges,
    });
    const cards = chartCards(html);
    const expected: Array<readonly [string, string]> = [
      ['Gemini Models · 5-hour window', ranges[0]!],
      ['Gemini Models · Weekly window', ranges[1]!],
      ['Claude and GPT Models · 5-hour window', ranges[2]!],
      ['Claude and GPT Models · Weekly window', ranges[3]!],
    ];

    expect(cards).toHaveLength(4);
    for (const [index, [title, selectedRange]] of expected.entries()) {
      const card = cards[index]!;
      expect(card).toContain(
        `<h3 id="chart-${title
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}-title">${title}</h3>`,
      );
      expect(card).toContain(`aria-label="${title} over time"`);
      expect(card).toContain(`aria-label="Period for ${title}"`);
      expect(card).toContain(`<option value="${selectedRange}" selected>`);
      expect(card.match(/<option value="[^"]+" selected>/g)).toHaveLength(1);
      expect(card).toContain('name="window" value="antigravity_gemini_weekly"');
    }
    const titleIds = [
      ...html.matchAll(
        /<h3 id="([^"]+)">(?:Gemini Models|Claude and GPT Models) · (?:5-hour|Weekly) window<\/h3>/g,
      ),
    ].map(([, id]) => id);
    expect(new Set(titleIds).size).toBe(4);
    const topControls = html.match(/<section class="usage-controls"[^>]*>[\s\S]*?<\/section>/)?.[0];
    expect(topControls).toBeDefined();
    expect(topControls).not.toContain('<select name="window"');
  });

  it('places a family selector inside the heatmap and limits it to weekly sources', () => {
    const ranges = [
      'antigravity|antigravity_gemini_five_hour|1h',
      'antigravity|antigravity_gemini_weekly|6h',
      'antigravity|antigravity_claude_gpt_five_hour|12h',
      'antigravity|antigravity_claude_gpt_weekly|30d',
    ];
    const html = renderUsagePage({ data: antigravityData(), series: [], chartRanges: ranges });
    const section = html.match(/<section class="usage-calendar-section"[\s\S]*?<\/section>/)?.[0];

    expect(section).toBeDefined();
    expect(section).toContain('aria-label="Daily usage family"');
    expect(section).toContain('<span class="field-label">Daily usage family</span>');
    expect(section).toContain(
      '<option value="antigravity_gemini_weekly" selected>Gemini Models</option>',
    );
    expect(section).toContain(
      '<option value="antigravity_claude_gpt_weekly">Claude and GPT Models</option>',
    );
    expect(section).not.toMatch(/<option value="[^"]*five_hour/);
    expect(section).not.toContain('field-label">Usage window');
    expect(section).toContain(`name="chartRange" value="${ranges[0]}"`);
    expect(section).toContain(`name="chartRange" value="${ranges[3]}"`);
    expect(section).toContain('data-usage-grid');
    expect(html.slice(0, html.indexOf(section!))).not.toContain('<select name="window"');

    const claudeHtml = renderUsagePage({
      data: antigravityData({ selectedWindowKind: 'antigravity_claude_gpt_weekly' }),
      series: [],
      chartRanges: ranges,
    });
    const claudeSection = claudeHtml.match(
      /<section class="usage-calendar-section"[\s\S]*?<\/section>/,
    )?.[0];
    expect(claudeSection).toContain(
      '<h2 id="daily-usage-heading">Claude and GPT Models · Weekly window</h2>',
    );
    expect(claudeSection).toContain(
      '<option value="antigravity_claude_gpt_weekly" selected>Claude and GPT Models</option>',
    );
  });

  it('does not render non-weekly observations as heatmap data', () => {
    const html = renderUsagePage({
      data: antigravityData({ selectedWindowKind: 'antigravity_gemini_five_hour' }),
      series: [],
    });
    const section = html.match(/<section class="usage-calendar-section"[\s\S]*?<\/section>/)?.[0];

    expect(section).toContain('Weekly view not selected');
    expect(section).toContain('<option value="" selected disabled>Choose a family</option>');
    expect(section).not.toContain('data-usage-grid');
  });

  it('uses Codex’s sole weekly heatmap source without a redundant family selector', () => {
    const data = pageData({
      windows: [
        { providerId: 'codex', windowKind: 'weekly' },
        { providerId: 'codex', windowKind: 'five_hour' },
      ],
    });
    const html = renderUsagePage({ data, series: charts() });
    const section = html.match(/<section class="usage-calendar-section"[\s\S]*?<\/section>/)?.[0];

    expect(section).toContain('<h2 id="daily-usage-heading">Weekly window</h2>');
    expect(section).not.toContain('Daily usage family');
    expect(html).not.toMatch(/<select name="window"/);
  });

  it('renders all intensity bands, provider navigation and a keyboard entry on an invalid day', () => {
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
    expect(html).not.toMatch(/<select name="window"/);
    expect(html).toContain(
      'href="/usage?provider=codex&amp;chartRange=codex%7Cweekly%7C6h&amp;chartRange=codex%7Cfive_hour%7C3h" data-configured="unknown" aria-current="page"',
    );
    expect(html).toMatch(/href="\/usage\?provider=antigravity(?:&amp;chartRange=[^"]+)+"/);
    expect(html).not.toContain('class="provider-picker-input"');
    expect(html).toContain('class="provider-picker provider-picker-navigation"');
    expect(html).not.toContain('Daily usage family');
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
