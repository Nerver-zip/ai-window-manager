import { DEFAULT_RETENTION_POLICY } from '../storage/retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Render a read-only, operator-facing summary of the active retention defaults. */
export function renderRetentionSummary(): string {
  const policy = DEFAULT_RETENTION_POLICY;
  return `<section class="card retention-card" aria-labelledby="data-retention-title">
    <header class="card-header">
      <div class="heading-copy">
        <p class="eyebrow">Storage</p>
        <h2 id="data-retention-title">Data retention</h2>
        <p class="muted">Older records are removed automatically in small batches.</p>
      </div>
    </header>
    <dl class="retention-list">
      <div><dt>Detailed usage updates</dt><dd>${retentionDays(policy.windowSamplesMs)}</dd></div>
      <div><dt>Daily usage history</dt><dd>${retentionDays(policy.usageIntervalsMs)}</dd></div>
      <div><dt>Routine activity</dt><dd>${retentionDays(policy.ordinaryEventsMs)}</dd></div>
      <div><dt>Important activity</dt><dd>${retentionDays(policy.lifecycleEventsMs)} <span>Provider and schedule changes, start attempts, and security events.</span></dd></div>
      <div><dt>Completed or closed starts</dt><dd>${retentionDays(policy.terminalActionIntentsMs)}</dd></div>
      <div><dt>Starts still under review</dt><dd>Kept until the system can safely confirm or stop them.</dd></div>
    </dl>
  </section>`;
}

function retentionDays(durationMs: number): string {
  const days = Math.round(durationMs / DAY_MS);
  return `About ${days} days`;
}
