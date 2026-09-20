import { describe, expect, it } from 'vitest';
import {
  HISTORY_RANGES,
  MAX_HISTORY_EVENTS,
  MAX_USAGE_POINTS,
  buildBoundedHistoryView,
  buildUsageSeries,
  filterHistoryEvents,
  renderHistoryPage,
  renderTimeline,
  renderUsageSeries,
  type HistoryTimelineEvent,
  type HistoryUsageSample,
} from '../../src/web/history-ui.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function event(overrides: Partial<HistoryTimelineEvent> = {}): HistoryTimelineEvent {
  return {
    id: 1,
    occurredAt: '2026-09-19T11:00:00.000Z',
    providerId: 'fake',
    type: 'scheduler_noop',
    severity: 'info',
    reasonCode: 'TARGET_NOT_DUE',
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
    expect(HISTORY_RANGES.map((range) => range.label)).toEqual(['24h', '7d', '30d']);

    const events = filterHistoryEvents(
      [
        event({ id: 1, occurredAt: '2026-09-19T11:00:00.000Z', providerId: 'fake' }),
        event({ id: 2, occurredAt: '2026-09-18T11:00:00.000Z', providerId: 'codex' }),
        event({ id: 3, occurredAt: '2026-09-01T11:00:00.000Z', providerId: 'fake' }),
      ],
      NOW,
      { range: '7d', providerId: 'fake' },
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(1);
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
    expect(fakeSeries?.points.at(-1)?.usageRatio).toBeCloseTo(99 / (MAX_USAGE_POINTS + 4));
  });

  it('keeps missing usage explicit instead of turning it into zero', () => {
    const html = renderUsageSeries([
      {
        providerId: 'fake',
        windowKind: 'five_hour',
        points: [{ observedAt: '2026-09-19T11:00:00.000Z', usageRatio: null, remainingRatio: 1 }],
      },
    ]);

    expect(html).toContain('Latest usage: <strong>unknown</strong>');
    expect(html).toContain('missing values remain');
    expect(html).not.toContain('Latest usage: <strong>0%');
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
    expect(html).toContain('Unknown event');
    expect(html).toContain('unknown');
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

    expect(html).toContain('Custom Event');
    expect(html).toContain('>info<');
    expect(html).toContain('>unknown<');
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

  it('renders a compact mobile-safe page with provider filtering and no JSON dump', () => {
    const html = renderHistoryPage({
      now: NOW,
      filter: { range: '30d', providerId: 'fake' },
      providers: [
        { id: 'fake', label: 'Fake provider' },
        { id: 'codex', label: 'Codex' },
      ],
      events: [event({ reasonCode: 'WINDOW_NOT_INACTIVE' })],
      samples: [sample()],
    });

    expect(html).toContain('value="30d" selected');
    expect(html).toContain('value="fake" selected');
    expect(html).toContain('viewBox="0 0 320 96"');
    expect(html).toContain('viewport');
    expect(html).toContain('Timeline');
    expect(html).toContain('Usage');
    expect(html).not.toContain('{"');
    expect(html).not.toContain('accountId');
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
    expect(renderHistoryPage({ now: NOW, providers: [], events: [], samples: [] })).toContain(
      'unknown',
    );
  });

  it('deduplicates provider options and rejects unsafe provider keys', () => {
    const html = renderHistoryPage({
      now: NOW,
      providers: [
        { id: 'fake', label: '\u0000' },
        { id: 'fake', label: 'duplicate' },
        { id: 'bad/id', label: 'unsafe' },
      ],
      events: [],
      samples: [],
    });

    expect(html).toContain('value="fake">fake</option>');
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
