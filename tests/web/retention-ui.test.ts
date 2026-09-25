import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_POLICY } from '../../src/storage/retention.js';
import { renderRetentionSummary } from '../../src/web/retention-ui.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('retention summary UI', () => {
  it('shows the real retention periods in plain language', () => {
    const html = renderRetentionSummary();

    expect(html).toContain(
      `<dt>Detailed usage updates</dt><dd>${days(DEFAULT_RETENTION_POLICY.windowSamplesMs)}</dd>`,
    );
    expect(html).toContain(
      `<dt>Daily usage history</dt><dd>${days(DEFAULT_RETENTION_POLICY.usageIntervalsMs)}</dd>`,
    );
    expect(html).toContain(
      `<dt>Routine activity</dt><dd>${days(DEFAULT_RETENTION_POLICY.ordinaryEventsMs)}</dd>`,
    );
    expect(html).toContain(
      `<dt>Important activity</dt><dd>${days(DEFAULT_RETENTION_POLICY.lifecycleEventsMs)}`,
    );
    expect(html).toContain(
      `<dt>Completed or closed starts</dt><dd>${days(DEFAULT_RETENTION_POLICY.terminalActionIntentsMs)}</dd>`,
    );
  });

  it('makes clear that unresolved starts are kept for safety without internal status jargon', () => {
    const html = renderRetentionSummary();

    expect(html).toContain(
      '<dt>Starts still under review</dt><dd>Kept until the system can safely confirm or stop them.</dd>',
    );
    expect(html).toContain(
      '<dt>Temporary start chats</dt><dd>Cleaned up separately after a start; retrying cleanup never repeats the start.</dd>',
    );
    expect(html).not.toContain('uncertain');
  });

  it('uses an accessible named section and definition list', () => {
    const html = renderRetentionSummary();

    expect(html).toContain(
      '<section class="card retention-card" aria-labelledby="data-retention-title">',
    );
    expect(html).toContain('<h2 id="data-retention-title">Data retention</h2>');
    expect(html).toContain('<dl class="retention-list">');
    expect(html.match(/<dt>/g)).toHaveLength(7);
    expect(html.match(/<dd>/g)).toHaveLength(7);
  });

  it('does not expose storage jargon or imply that cleanup retries provider starts', () => {
    const html = renderRetentionSummary();

    expect(html).not.toMatch(/window_samples|usage_intervals|action_intents/i);
    expect(html).toContain('removed automatically in small batches');
    expect(html).toMatch(/retrying cleanup never repeats the start/);
  });
});

function days(durationMs: number): string {
  return `About ${Math.round(durationMs / DAY_MS)} days`;
}
