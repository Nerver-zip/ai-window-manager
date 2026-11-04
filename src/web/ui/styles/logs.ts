/** Logs page: filter toolbar, day-grouped timeline and pagination. */
export const LOGS_CSS = `
.logs-page, .history-page { display: grid; gap: var(--space-5); }
.history-toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3) var(--space-4); min-width: 0; }
.history-toolbar .provider-picker { min-width: 0; max-width: 100%; }
.history-range { display: grid; gap: 4px; margin: 0; }
.history-range select { min-width: 96px; }
.history-filter-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4); min-width: 0; }
.log-tag-filters { min-width: 0; }
.log-tag-filter.is-active { color: var(--text); }
.log-routine-toggle { margin: 0; color: var(--text-muted); font-size: 13px; }
.log-routine-toggle a { color: var(--accent-strong); }
.history-sections { display: grid; gap: var(--space-6); }
.history-section { min-width: 0; }
.timeline-day { margin-top: var(--space-5); }
.timeline-day-title { margin: 0 0 var(--space-2); color: var(--text-soft); font-size: 13px; font-weight: 600; }
.timeline { position: relative; display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.timeline::before { content: ''; position: absolute; top: 14px; bottom: 14px; left: 64px; width: 1px; background: var(--line); }
.timeline-item { display: grid; grid-template-columns: 48px 10px minmax(0, 1fr); gap: 0 var(--space-3); padding: 10px 0; }
.timeline-time { padding-top: 1px; color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; line-height: 20px; }
.timeline-marker { position: relative; z-index: 1; width: 9px; height: 9px; margin: 6px 0 0 0.5px; border-radius: 50%; background: var(--text-faint); box-shadow: 0 0 0 3px var(--bg); }
.event-warn .timeline-marker { background: var(--warn); }
.event-error .timeline-marker { background: var(--danger); }
.event-info .timeline-marker { background: var(--accent); }
.timeline-content { min-width: 0; }
.timeline-event { margin: 0; color: var(--text); font-size: 14px; font-weight: 500; line-height: 20px; overflow-wrap: anywhere; }
.timeline-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--space-3); margin: 2px 0 0; color: var(--text-muted); font-size: 12px; }
.timeline-provider { display: inline-flex; align-items: center; overflow-wrap: anywhere; }
.timeline-provider .provider-logo-xs { margin-right: 6px; vertical-align: 0; }
.log-event-tags { display: inline-flex; flex-wrap: wrap; gap: 0 var(--space-2); }
.log-event-tag::before { content: '·'; margin-right: var(--space-2); }
.timeline-reason { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; overflow-wrap: anywhere; }
.timeline-label { margin-right: 6px; color: var(--text-soft); font-weight: 500; }
.timeline-label::after { content: ':'; }
.history-pagination { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); border-top: 1px solid var(--line); margin-top: var(--space-5); padding-top: var(--space-4); }
.history-pagination-summary { margin: 0; color: var(--text-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.history-pagination-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }

@media (max-width: 700px) {
  .history-toolbar { align-items: stretch; flex-direction: column; }
  .history-range select { width: 100%; }
  .history-filter-row { align-items: flex-start; flex-direction: column; }
  .log-tag-filters { max-width: 100%; }
  .timeline::before { left: 52px; }
  .timeline-item { grid-template-columns: 40px 10px minmax(0, 1fr); gap: 0 var(--space-2); }
  .history-pagination { align-items: stretch; flex-direction: column; }
  .history-pagination-actions .button { flex: 1; }
}
`;
