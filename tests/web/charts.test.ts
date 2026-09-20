import { describe, expect, it } from 'vitest';
import {
  buildTickIndices,
  formatChartTick,
  formatChartTooltipTime,
  formatRatioPercent,
  renderChartEmptyState,
  renderTimeSeriesChart,
} from '../../src/web/ui/charts.js';

describe('shared chart primitives', () => {
  it('formats short and long ranges in UTC and fails closed for bad timestamps', () => {
    const timestamp = '2026-09-19T14:05:00.000Z';
    expect(formatChartTick(timestamp, '24h')).toBe('14:05 UTC');
    expect(formatChartTick(timestamp, '7d')).toBe('19 Sep');
    expect(formatChartTick(timestamp, '30d')).toBe('19 Sep');
    expect(formatChartTick('not-a-date', '24h')).toBe('unknown');
    expect(formatChartTooltipTime(timestamp)).toBe('19 Sep 2026 · 14:05 UTC');
    expect(formatChartTooltipTime('not-a-date')).toBe('Time unavailable');
    expect(formatRatioPercent(0.255)).toBe('26%');
  });

  it('keeps time ticks bounded and evenly distributed', () => {
    expect(buildTickIndices(0)).toEqual([]);
    expect(buildTickIndices(1)).toEqual([0]);
    expect(buildTickIndices(8, 1)).toEqual([0]);
    expect(buildTickIndices(8, 4)).toEqual([0, 2, 5, 7]);
    expect(buildTickIndices(3, 8)).toEqual([0, 1, 2]);
  });

  it('renders shared line structure, accessible points, null gaps and safe labels', () => {
    const html = renderTimeSeriesChart({
      id: '!!!',
      title: '<Usage>',
      eyebrow: 'Trend',
      description: '<not raw html>',
      range: '7d',
      summary: [{ label: 'Latest', value: '42%' }],
      series: [
        {
          key: 'used',
          label: 'Used <now>',
          colorIndex: 0,
          unit: '%',
          points: [
            { observedAt: '2026-09-18T10:00:00.000Z', value: 0.1 },
            { observedAt: '2026-09-18T11:00:00.000Z', value: null },
            { observedAt: '2026-09-18T12:00:00.000Z', value: 0.42 },
            { observedAt: '2026-09-18T13:00:00.000Z', value: Number.NaN },
          ],
        },
        {
          key: 'latency',
          label: 'Latency',
          colorIndex: 7,
          unit: 'ms',
          points: [
            { observedAt: '2026-09-18T10:00:00.000Z', value: 0.2 },
            { observedAt: '2026-09-18T11:00:00.000Z', value: 0.3 },
            { observedAt: '2026-09-18T12:00:00.000Z', value: 0.4 },
            { observedAt: '2026-09-18T13:00:00.000Z', value: 2 },
          ],
        },
      ],
      yAxis: {
        min: 0,
        max: 1,
        ticks: [1, 0.5, 0],
        format: formatRatioPercent,
      },
      footer: '4 observations',
    });

    expect(html).toContain('id="chart-unknown-title"');
    expect(html).toContain('&lt;Usage&gt;');
    expect(html).toContain('&lt;not raw html&gt;');
    expect(html).toContain('viewBox="0 0 640 230"');
    expect(html).toContain('class="chart-line chart-series-1"');
    expect(html).toContain('class="chart-line chart-series-2"');
    expect(html).toContain('data-chart-point');
    expect(html).toContain('data-chart-value="42%"');
    expect(html).toContain('data-chart-value="0.2ms"');
    expect(html).toContain('18 Sep 2026 · 12:00 UTC');
    expect(html).toContain('chart-tooltip-values');
    expect(html).not.toContain('class="chart-axis"');
    expect(html).not.toContain('<Usage>');
  });

  it('supports a degenerate domain and a stable empty state', () => {
    const html = renderTimeSeriesChart({
      id: 'single',
      title: 'Single value',
      range: '24h',
      summary: [],
      series: [
        { key: 'value', label: 'Value', colorIndex: 1, points: [{ observedAt: 'bad', value: 0 }] },
      ],
      yAxis: { min: 0, max: 0, ticks: [0], format: () => '0' },
      footer: 'one observation',
    });
    expect(html).toContain('data-chart-value="0"');
    expect(html).toContain('Time unavailable');
    expect(renderChartEmptyState()).toContain('No usage observations in this range');
    expect(renderChartEmptyState('Nothing here')).toContain('Nothing here');
  });

  it('keeps the plot stable when every value is missing', () => {
    const html = renderTimeSeriesChart({
      id: 'missing',
      title: 'Missing values',
      range: '24h',
      summary: [],
      series: [
        {
          key: 'value',
          label: 'Value',
          colorIndex: 1,
          points: [{ observedAt: 'bad', value: null }],
        },
      ],
      yAxis: { min: 0, max: 1, ticks: [1, 0], format: formatRatioPercent },
      footer: 'missing',
    });
    expect(html).toContain('Waiting for a valid observation');
    expect(html).not.toContain('data-chart-point');
  });
});
