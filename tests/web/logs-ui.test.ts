import { describe, expect, it } from 'vitest';
import {
  HISTORY_RANGES,
  LOG_TAGS,
  MAX_HISTORY_EVENTS,
  MAX_USAGE_POINTS,
  buildBoundedHistoryView,
  buildUsageSeries,
  chartRangeKey,
  filterHistoryEvents,
  getHistoryRange,
  normalizeLogTag,
  normalizeChartRanges,
  renderLogsPage,
  renderTimeline,
  renderUsageSeries,
  type HistoryTimelineEvent,
  type HistoryRange,
  type HistoryUsageSample,
} from '../../src/web/logs-ui.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function event(overrides: Partial<HistoryTimelineEvent> = {}): HistoryTimelineEvent {
  return {
    id: 1,
    occurredAt: '2026-09-19T11:00:00.000Z',
    providerId: 'fake',
    type: 'action_succeeded',
    severity: 'info',
    reasonCode: null,
    ...overrides,
  };
}

function sample(overrides: Partial<HistoryUsageSample> = {}): HistoryUsageSample {
  return {
    providerId: 'fake',
    windowKind: 'five_hour',
    observedAt: '2026-09-19T11:00:00.000Z',
    usageRatio: 0.25,
    remainingRatio: 0.75,
    ...overrides,
  };
}

describe('history UI helpers', () => {
  it('exposes bounded range labels and filters events by range and provider', () => {
    expect(HISTORY_RANGES.map((range) => range.label)).toEqual([
      '1h',
      '3h',
      '6h',
      '12h',
      '24h',
      '7d',
      '30d',
    ]);
    expect(getHistoryRange('1h').durationMs).toBe(60 * 60 * 1000);
    expect(getHistoryRange('3h').durationMs).toBe(3 * 60 * 60 * 1000);
    expect(getHistoryRange('6h').durationMs).toBe(6 * 60 * 60 * 1000);
    expect(getHistoryRange('12h').durationMs).toBe(12 * 60 * 60 * 1000);
    expect(getHistoryRange('24h').durationMs).toBe(24 * 60 * 60 * 1000);
    expect(getHistoryRange('invalid' as HistoryRange).value).toBe('24h');

    const events = filterHistoryEvents(
      [
        event({ id: 1, occurredAt: '2026-09-19T11:00:00.000Z', providerId: 'fake' }),
        event({ id: 2, occurredAt: '2026-09-18T11:00:00.000Z', providerId: 'codex' }),
        event({ id: 3, occurredAt: '2026-09-01T11:00:00.000Z', providerId: 'fake' }),
        event({ id: 4, occurredAt: '2026-09-19T13:00:00.000Z', providerId: 'fake' }),
      ],
      NOW,
      { range: '7d', providerId: 'fake' },
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(1);
  });

  it('keeps routine inspection and scheduler heartbeats out of the activity timeline', () => {
    const events = [
      event({ id: 1, type: 'provider_inspected' }),
      event({ id: 2, type: 'scheduler_noop' }),
      event({ id: 3, type: 'action_succeeded' }),
    ];
    const visible = filterHistoryEvents(events, NOW, { range: '24h' });
    expect(visible.map((item) => item.type)).toEqual(['action_succeeded']);
    const html = renderTimeline(events);
    expect(html).not.toContain('Provider checked');
    expect(html).not.toContain('Scheduling update');
    expect(html).toContain('Automatic action completed');
    expect(
      filterHistoryEvents(events, NOW, { range: '24h', tag: 'sync' }).map((item) => item.type),
    ).toContain('provider_inspected');
    expect(
      filterHistoryEvents(events, NOW, { range: '24h', eventType: 'scheduler_noop' }),
    ).toHaveLength(1);
    expect(
      filterHistoryEvents(events, NOW, { range: '24h', tag: 'sync' }).map((item) => item.type),
    ).not.toContain('scheduler_noop');
  });

  it('assigns stable multi-category tags without exposing event payloads', () => {
    const cases = [
      { type: 'action_uncertain', severity: 'warn' as const, tags: ['trigger', 'alert'] },
      { type: 'unexpected_reset_detected', severity: 'info' as const, tags: ['reset'] },
      { type: 'provider_inspection_failed', severity: 'warn' as const, tags: ['sync', 'alert'] },
      {
        type: 'provider_auth_started',
        severity: 'info' as const,
        tags: ['sync', 'config', 'manual'],
      },
      {
        type: 'provider_auth_awaiting_user',
        severity: 'info' as const,
        tags: ['sync', 'config', 'manual'],
      },
      {
        type: 'provider_auth_succeeded',
        severity: 'info' as const,
        tags: ['sync', 'config'],
      },
      {
        type: 'provider_auth_timed_out',
        severity: 'warn' as const,
        tags: ['sync', 'config', 'alert'],
      },
      { type: 'schedule_policy_updated', severity: 'info' as const, tags: ['config'] },
      {
        type: 'manual_trigger_rejected',
        severity: 'warn' as const,
        tags: ['trigger', 'alert', 'manual'],
      },
      { type: 'inspect_requested', severity: 'info' as const, tags: ['sync', 'manual'] },
    ];
    for (const [index, testCase] of cases.entries()) {
      const [result] = filterHistoryEvents(
        [
          event({
            id: index + 1,
            type: testCase.type,
            severity: testCase.severity,
            data: { token: 'never-render-this' },
          }),
        ],
        NOW,
        { range: '24h' },
      );
      expect(result?.tags).toEqual(testCase.tags);
    }

    expect(LOG_TAGS.map((tag) => tag.value)).toEqual([
      'trigger',
      'reset',
      'sync',
      'config',
      'alert',
      'manual',
    ]);
    expect(normalizeLogTag('unexpected')).toBeNull();
  });

  it('filters by category in addition to provider and range', () => {
    const visible = filterHistoryEvents(
      [
        event({ id: 1, type: 'action_succeeded', providerId: 'codex' }),
        event({ id: 2, type: 'unexpected_reset_detected', providerId: 'codex' }),
        event({ id: 3, type: 'action_succeeded', providerId: 'fake' }),
      ],
      NOW,
      { range: '24h', providerId: 'codex', tag: 'trigger' },
    );
    expect(visible.map((item) => item.id)).toEqual([1]);
  });

  it('explains known provider failures instead of showing an empty technical fallback', () => {
    const html = renderTimeline([
      event({ type: 'provider_inspection_failed', reasonCode: null, severity: 'warn' }),
    ]);

    expect(html).toContain('Provider check failed');
    expect(html).toContain('The last saved reading is kept');
    expect(html).not.toContain('No additional explanation');
    expect(html).not.toContain('provider_inspection_failed');
  });

  it('filters each usage series using its own selected period', () => {
    const series = buildUsageSeries(
      [
        sample({ observedAt: '2026-09-19T11:30:00.000Z', usageRatio: 0.2 }),
        sample({ observedAt: '2026-09-19T10:00:00.000Z', usageRatio: 0.3 }),
        sample({
          providerId: 'codex',
          windowKind: 'weekly',
          observedAt: '2026-09-18T12:00:00.000Z',
        }),
      ],
      NOW,
      {
        range: '24h',
        chartRanges: normalizeChartRanges(['fake|five_hour|1h', 'codex|weekly|7d']),
      },
    );

    expect(series).toMatchObject([
      {
        providerId: 'codex',
        windowKind: 'weekly',
        range: '7d',
        points: [{ observedAt: '2026-09-18T12:00:00.000Z' }],
      },
      {
        providerId: 'fake',
        windowKind: 'five_hour',
        range: '1h',
        points: [{ observedAt: '2026-09-19T11:30:00.000Z' }],
      },
    ]);
    expect(normalizeChartRanges('fake|five_hour|6h')).toEqual({
      [chartRangeKey('fake', 'five_hour')]: '6h',
    });
  });

  it('targets a period change at the chart being edited, not the heatmap window', () => {
    const html = renderUsageSeries(
      [
        {
          providerId: 'codex',
          windowKind: 'weekly',
          range: '7d',
          points: [],
        },
        {
          providerId: 'codex',
          windowKind: 'five_hour',
          range: '3h',
          points: [],
        },
      ],
      {
        timelineRange: '24h',
        providerId: 'codex',
        selectedWindowKind: 'weekly',
        chartRanges: normalizeChartRanges(['codex|weekly|7d', 'codex|five_hour|3h']),
      },
    );

    expect(html).toContain('name="window" value="weekly"');
    expect(html).toContain('name="window" value="five_hour"');
    expect(html).toContain('<select name="chartRange"');
    expect(html).toContain('<option value="codex|five_hour|3h" selected>3h</option>');
    expect(html).toContain('<option value="codex|weekly|7d" selected>7d</option>');
    expect(html).not.toContain('name="chartRangeChoice"');
  });

  it('keeps a chart visible with an explicit empty state when its period has no samples', () => {
    const series = buildUsageSeries([sample({ observedAt: '2026-09-19T08:00:00.000Z' })], NOW, {
      range: '24h',
      chartRanges: normalizeChartRanges('fake|five_hour|1h'),
    });

    expect(series).toMatchObject([
      { providerId: 'fake', windowKind: 'five_hour', range: '1h', points: [] },
    ]);
    expect(renderUsageSeries(series, '24h')).toContain('Waiting for a valid observation');
  });

  it('orders and bounds usage series without loading unbounded data into markup', () => {
    const samples = Array.from({ length: MAX_USAGE_POINTS + 4 }, (_, index) =>
      sample({
        observedAt: new Date(Date.parse('2026-09-19T00:00:00.000Z') + index * 60_000).toISOString(),
        usageRatio: index / (MAX_USAGE_POINTS + 4),
      }),
    );
    samples.push(sample({ providerId: 'codex', usageRatio: 0.8 }));

    const series = buildUsageSeries(samples, NOW, { range: '24h' });
    expect(series).toHaveLength(2);
    const fakeSeries = series.find((item) => item.providerId === 'fake');
    expect(fakeSeries?.points).toHaveLength(MAX_USAGE_POINTS);
    expect(fakeSeries?.points[0]?.observedAt).toBe('2026-09-19T00:04:00.000Z');
    expect(fakeSeries?.points.at(-1)?.usageRatio).toBeCloseTo(
      (MAX_USAGE_POINTS + 3) / (MAX_USAGE_POINTS + 4),
    );
  });

  it('keeps missing usage explicit instead of turning it into zero', () => {
    const html = renderUsageSeries([
      {
        providerId: 'fake',
        windowKind: 'five_hour',
        points: [{ observedAt: '2026-09-19T11:00:00.000Z', usageRatio: null, remainingRatio: 1 }],
      },
    ]);

    expect(html).toContain('<span>Latest used</span><strong>Not available yet</strong>');
    expect(html).toContain('Usage trend');
    expect(html).not.toContain('Missing values remain unknown');
    expect(html).not.toContain('observations');
    expect(html).not.toContain('5 nearby readings');
    expect(html).not.toContain('<span>Latest used</span><strong>0%');
  });

  it('fails closed for unsafe chart identity and unknown remaining data', () => {
    const html = renderUsageSeries([
      {
        providerId: '<provider>',
        windowKind: 'five hour',
        points: [
          { observedAt: '2026-09-19T10:00:00.000Z', usageRatio: 0.2, remainingRatio: null },
          { observedAt: '2026-09-19T11:00:00.000Z', usageRatio: 2, remainingRatio: null },
        ],
      },
    ]);

    expect(html).toContain('<h3 id="chart-unknown-usage-window-title">Unknown');
    expect(html).toContain('<span>Remaining</span><strong>Not available yet</strong>');
    expect(html).not.toContain('1 missing');
    expect(html).not.toContain('<provider>');
    expect(html).toContain('class="chart-line chart-series-1"');
  });

  it('escapes reason text and never renders raw event payloads', () => {
    const html = renderTimeline([
      event({
        reasonCode: '<script>alert(1)</script>',
        type: '<img src=x onerror=alert(1)>',
      }),
    ]);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('Activity update');
    expect(html).toContain('More details are not available for this update.');
  });

  it('renders provider logos in timeline items when available', () => {
    const html = renderTimeline([event({ providerId: 'codex' }), event({ providerId: 'fake' })]);
    expect(html).toContain('/assets/images/providers/codex.png');
  });

  it('normalizes unknown event metadata to safe explicit values', () => {
    const html = renderTimeline([
      event({
        id: -1,
        providerId: null,
        type: 'custom_event',
        severity: 'trace' as HistoryTimelineEvent['severity'],
        reasonCode: null,
      }),
    ]);

    expect(html).toContain('Activity update');
    expect(html).toContain('>Info<');
    expect(html).toContain('More details are not available for this update.');
  });

  it('renders already projected items with an unknown timestamp without throwing', () => {
    const html = renderTimeline([
      {
        id: 1,
        occurredAt: 'not-a-date',
        providerId: null,
        type: 'custom_event',
        severity: 'info',
        reasonCode: null,
        displayType: 'Custom event',
        displaySeverity: 'info',
        displayReason: 'unknown',
      },
    ]);

    expect(html).toContain('datetime="not-a-date"');
    expect(html).toContain('>unknown<');
  });

  it('renders the shared-shell history page with responsive semantic sections', () => {
    const html = renderLogsPage({
      now: NOW,
      filter: { range: '30d', providerId: 'fake' },
      providers: [
        { id: 'fake', label: 'Fake provider' },
        { id: 'codex', label: 'Codex' },
      ],
      events: [
        event({ reasonCode: 'WINDOW_NOT_INACTIVE' }),
        event({ id: 2, reasonCode: 'TARGET_NOT_DUE' }),
      ],
      samples: [sample()],
    });

    expect(html).toContain('value="30d" selected');
    expect(html).toContain('value="fake" selected');
    expect(html).toContain('viewport');
    expect(html).toContain('logs-page');
    expect(html).toContain('class="timeline"');
    expect(html).not.toContain('data-chart-root');
    expect(html).not.toContain('class="card chart-card"');
    expect(html).toContain('2 events');
    expect(html).toContain('<title>Logs · AI Window Manager</title>');
    expect(html).toContain('<h1>Activity Logs</h1>');
    expect(html).toContain('Timeline');
    expect(html).toContain('aria-label="Filter logs by category"');
    expect(html).toContain('class="log-tag-filter is-active"');
    expect(html).toContain('badge-tag-trigger');
    expect(html).toContain('Usage');
    expect(html).not.toContain('<style');
    expect(html).not.toContain(' style=');
    expect(html).not.toContain('{"');
    expect(html).not.toContain('accountId');
  });

  it('shows event times in the saved timezone without milliseconds or ISO jargon', () => {
    const html = renderLogsPage({
      now: NOW,
      timeZone: 'America/Sao_Paulo',
      providers: [{ id: 'codex' }],
      events: [event({ providerId: 'codex' })],
      samples: [],
    });

    expect(html).toContain('Times shown in São Paulo.');
    expect(html).toContain('>Sep 19, 2026, 8:00 AM GMT-3</time>');
    expect(html).not.toContain('2026-09-19 11:00:00.000Z');
    expect(html).not.toContain('aria-label="Log pages"');
    expect(html).not.toContain('event · page 1');
  });

  it('renders activity chronology and accessible history pagination only', () => {
    const html = renderLogsPage({
      now: NOW,
      providers: [{ id: 'fake' }],
      events: [event({ id: 21 }), event({ id: 22 })],
      samples: [
        sample({ observedAt: '2026-09-19T08:00:00.000Z', usageRatio: 0.1 }),
        sample({ observedAt: '2026-09-19T11:00:00.000Z', usageRatio: 0.4 }),
      ],
      pagination: {
        page: 2,
        pageSize: 20,
        hasNext: true,
        previousHref: '/logs?range=24h&page=1',
        nextHref: '/logs?range=24h&page=3',
      },
    });

    expect(html).not.toContain('data-chart-root');
    expect(html).toContain('aria-label="Log pages"');
    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
    expect(html).toContain('page 2');
  });

  it('fails closed to an empty bounded view for invalid range and invalid samples', () => {
    const view = buildBoundedHistoryView({
      now: NOW,
      filter: { range: 'not-a-range', providerId: '<account>' },
      providers: [],
      events: [event({ occurredAt: 'not-a-date' })],
      samples: [sample({ providerId: '<account>', windowKind: 'five hour', observedAt: 'nope' })],
    });

    expect(view.range).toBe('24h');
    expect(view.providerId).toBeNull();
    expect(view.events).toEqual([]);
    expect(view.series).toEqual([]);
    const html = renderLogsPage({ now: NOW, providers: [], events: [], samples: [] });
    expect(html).toContain('empty-state');
    expect(html).not.toContain('data-chart-root');
    expect(html).not.toContain('<style');
  });

  it('deduplicates provider options and rejects unsafe provider keys', () => {
    const html = renderLogsPage({
      now: NOW,
      providers: [
        { id: 'fake', label: '\u0000' },
        { id: 'fake', label: 'duplicate' },
        { id: 'codex' },
        { id: 'bad/id', label: 'unsafe' },
      ],
      events: [],
      samples: [],
    });

    expect(html).toContain('value="fake">Test provider</option>');
    expect(html).toContain('value="codex">Codex</option>');
    expect(html).not.toContain('duplicate');
    expect(html).not.toContain('bad/id');
  });

  it('caps the timeline even when the route accidentally supplies too many sanitized events', () => {
    const events = Array.from({ length: MAX_HISTORY_EVENTS + 10 }, (_, id) =>
      event({ id, occurredAt: new Date(NOW.getTime() - id * 1_000).toISOString() }),
    );
    expect(filterHistoryEvents(events, NOW, { range: '24h' })).toHaveLength(MAX_HISTORY_EVENTS);
  });
});
