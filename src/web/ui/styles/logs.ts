/** Logs page: filters, timeline and pagination. */
export const LOGS_CSS = `
.logs-page, .history-page { display: grid; gap: 24px; }
.history-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(480px, 1.35fr); gap: 24px; align-items: start; margin-bottom: 0; }
.history-toolbar-summary { display: grid; gap: 4px; }
.history-toolbar-summary strong { font-size: 18px; }
.history-toolbar-summary .eyebrow { margin-bottom: 0; }
.history-toolbar-fields { display: grid; grid-template-columns: minmax(130px, 1fr) auto; gap: 12px; align-items: end; min-width: 0; }
.history-toolbar-fields > .field { grid-column: 1 / -1; }
.log-tag-filters { display: flex; flex-wrap: wrap; gap: 8px; }
.log-tag-filter { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 8px 13px; color: var(--text-muted); font-size: 12px; font-weight: 600; text-decoration: none; }
.log-tag-filter:hover { border-color: var(--accent); color: var(--text); }
.log-tag-filter.is-active { border-color: var(--accent); background: var(--surface-raised); color: var(--accent-strong); }
.log-routine-toggle { margin: -12px 0 0; color: var(--text-muted); font-size: 12px; }
.log-routine-toggle a { color: var(--accent); }
.log-event-tags { display: inline-flex; flex-wrap: wrap; gap: 5px; }
.badge-tag { min-height: 22px; border-radius: 5px; padding: 2px 6px; font-size: 9px; letter-spacing: .3px; }
.badge-tag-trigger { color: var(--accent-strong); }
.badge-tag-reset { color: var(--success); }
.badge-tag-sync { color: var(--text-muted); }
.badge-tag-config { color: var(--accent); }
.badge-tag-alert { color: var(--warning); }
.badge-tag-manual { color: var(--text-soft); }
.history-sections { display: grid; gap: 36px; }
.history-section { min-width: 0; }
.timeline { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.timeline-item { display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 14px; border-bottom: 1px solid var(--border); padding: 16px 0; }
.timeline-item:first-child { padding-top: 0; }
.timeline-marker { width: 10px; height: 10px; margin-top: 5px; border: 2px solid var(--accent); border-radius: 50%; background: var(--surface); }
.event-warn .timeline-marker { border-color: var(--warning); }
.event-error .timeline-marker { border-color: var(--danger); }
.timeline-content { min-width: 0; }
.timeline-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
.timeline-time, .timeline-provider { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.timeline-event { margin-bottom: 6px; }
.timeline-reason { margin: 0; color: var(--text-muted); font-size: 13px; overflow-wrap: anywhere; }
.timeline-label { margin-right: 8px; color: var(--text); font-weight: 650; }
.history-pagination { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 18px; }
.history-pagination-summary { margin: 0; color: var(--text-muted); font-size: 12px; }
.history-pagination-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.event time, .event .reason, .event .provider, .event .severity { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.event-warn { border-left-color: var(--warning); }
.event-error { border-left-color: var(--danger); }

@media (max-width: 1100px) {
  .history-toolbar { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
  .history-toolbar-fields { grid-template-columns: 1fr; }
  .history-toolbar-fields button { width: 100%; }
  .history-section .section-heading { align-items: flex-start; flex-direction: column; gap: 6px; }
  .history-pagination { align-items: flex-start; flex-direction: column; }
  .history-pagination-actions, .history-pagination-actions .button { width: 100%; }
  .history-pagination-actions .button { flex: 1; }
}
`;
