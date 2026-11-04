/** Schedule page: one policy form beside a "what happens next" outlook. */
export const SCHEDULE_CSS = `
.schedule-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 410px); gap: var(--space-7); align-items: start; }
.schedule-policy { display: grid; gap: var(--space-5); min-width: 0; }
.schedule-policy > * { margin: 0; }
.schedule-policy-heading h2 { margin-bottom: 4px; }
.schedule-policy-heading p { margin: 0; }
.schedule-policy form[data-policy-form] { display: grid; gap: var(--space-5); }
.schedule-provider-selection { min-width: 0; }
.policy-scope-navigation { justify-self: start; }
.managed-window-target { display: grid; gap: var(--space-2); }
.managed-window-target > * { margin: 0; }
.managed-window-summary, .managed-window-model { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--space-3); color: var(--text-soft); }
.managed-window-summary strong { color: var(--text); font-weight: 600; }
.managed-window-model code { color: var(--text-soft); }
.policy-choice-group > legend { color: var(--text); font-size: 14px; font-weight: 600; margin-bottom: var(--space-2); }
.policy-choice-grid { display: grid; border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; }
.policy-choice { position: relative; display: grid; grid-template-columns: 24px minmax(0, 1fr) 16px; align-items: center; gap: var(--space-3); min-height: 56px; border-top: 1px solid var(--line); background: transparent; padding: 10px var(--space-4); cursor: pointer; transition: background-color .12s ease, box-shadow .12s ease; }
.policy-choice:first-child { border-top: 0; }
.policy-choice:hover { background: var(--surface-raised); }
.policy-choice.is-selected { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.policy-choice:has(input:focus-visible) { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
.policy-choice input { position: absolute; width: 1px; height: 1px; min-height: 0; opacity: 0; }
.policy-choice-icon { display: grid; place-items: center; color: var(--text-muted); }
.policy-choice-icon svg { width: 18px; height: 18px; }
.policy-choice.is-selected .policy-choice-icon { color: var(--accent-strong); }
.policy-choice-copy { display: grid; gap: 1px; min-width: 0; }
.policy-choice-copy strong { color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.3; }
.policy-choice-copy > span { color: var(--text-muted); font-size: 13px; line-height: 1.4; }
.policy-choice-indicator { width: 14px; height: 14px; border: 1px solid var(--line-strong); border-radius: 50%; }
.policy-choice.is-selected .policy-choice-indicator { border: 4px solid var(--accent); background: var(--bg); }
.policy-choice:has(input:disabled) { cursor: not-allowed; opacity: .55; }
.policy-fields { min-width: 0; }
.policy-fields[aria-hidden="true"] { display: none; }
.policy-controls-grid { display: grid; gap: var(--space-4); align-items: start; }
.policy-guidance { margin: var(--space-3) 0 0; border-left: 2px solid var(--line-strong); padding: 2px 0 2px var(--space-3); color: var(--text-muted); font-size: 13px; }
.policy-controls-grid + .policy-guidance { margin-top: var(--space-4); }
.managed-window-target > .policy-guidance { margin-top: var(--space-1); }
.schedule-form-footer { display: grid; gap: var(--space-3); border-top: 1px solid var(--line); padding-top: var(--space-4); }
.schedule-form-footer > p { margin: 0; }
.schedule-form-footer .form-actions { margin-top: 0; }
.dynamic-list-field { min-width: 0; }
.dynamic-list { display: grid; gap: var(--space-2); }
.dynamic-list-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); align-items: end; }
.active-period-item { grid-template-columns: repeat(2, minmax(0, 1fr)) auto; }
.dynamic-list-item label { min-width: 0; }
.time-chip { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; border: 0; border-top: 1px solid var(--line); padding: var(--space-2) 0 0; }
.time-chip:first-of-type { border-top: 0; padding-top: 0; }
.time-chip label { display: flex; align-items: center; gap: var(--space-3); color: var(--text-muted); font-size: 13px; white-space: nowrap; }
.time-chip input { width: 132px; }
.dynamic-list-actions { display: grid; justify-items: start; gap: var(--space-3); margin-top: var(--space-2); }
.schedule-presets { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.schedule-presets .button { min-height: 32px; padding: 4px 10px; font-size: 13px; }
.schedule-presets .button span { color: var(--text-muted); font-weight: 400; font-variant-numeric: tabular-nums; }
.dynamic-list-remove, .dynamic-list-add { min-height: 32px; padding: 4px 12px; font-size: 13px; }
.dynamic-list-remove { border-color: transparent; background: transparent; color: var(--text-muted); }
.dynamic-list-remove:hover { border-color: transparent; background: var(--danger-soft); color: var(--danger); }
.time-input-group { display: flex; align-items: center; gap: var(--space-2); }
.time-input-group input[type="time"] { flex: 1; min-width: 0; }
.time-stepper { display: inline-flex; align-items: center; gap: 4px; }
.button-step { min-height: 32px; padding: 4px 10px; font-size: 13px; font-weight: 500; }

/* Outlook column */
.schedule-outlook { position: sticky; top: var(--space-5); display: grid; gap: var(--space-5); min-width: 0; }
.schedule-outlook > h2 { margin: 0; }
.schedule-outlook-section { min-width: 0; border-top: 1px solid var(--line); padding-top: var(--space-4); }
.schedule-outlook-section h3 { margin-bottom: var(--space-2); font-size: 14px; }
.schedule-outlook-section > p { font-size: 13px; }
.current-window-read { display: grid; gap: 2px; }
.current-window-read > p { margin: 0; }
.current-window-status { font-size: 26px; font-weight: 600; letter-spacing: -.02em; color: var(--text); }
.current-window-status::before { width: 9px; height: 9px; }
.schedule-explanation { margin: 0; color: var(--text-soft); }
.schedule-explanation strong { color: var(--text); font-weight: 600; }
.schedule-details .notice, .schedule-outlook .notice { margin: 0; }
.schedule-horizon { display: grid; gap: var(--space-3); min-width: 0; }
.horizon-timeline-head { display: flex; justify-content: space-between; color: var(--text-muted); font-size: 12px; }
.horizon-timeline-head strong { color: var(--accent-strong); font-weight: 600; }
.horizon-chart-wrap { min-width: 0; }
.schedule-horizon-chart { display: block; width: 100%; height: auto; overflow: visible; }
.horizon-track { stroke: var(--line-strong); stroke-width: 6; stroke-linecap: round; }
.horizon-active-hours { fill: var(--ok-soft); stroke: var(--ok); stroke-opacity: .45; stroke-width: 1; }
.horizon-current { fill: var(--accent); }
.horizon-projected { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 2; stroke-dasharray: 5 4; }
.horizon-tick { stroke: var(--line-strong); stroke-width: 1; }
.horizon-now { stroke: var(--text); stroke-width: 2; }
.horizon-marker { stroke-width: 2; stroke-dasharray: 3 3; }
.horizon-marker-start { stroke: var(--accent); }
.horizon-marker-reset { stroke: var(--ok); }
.horizon-marker-dot { fill: var(--surface); stroke-width: 3; }
.horizon-axis { display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); padding-inline: 4%; color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.horizon-axis-label { width: min-content; min-width: 0; justify-self: center; text-align: center; line-height: 1.25; white-space: normal; overflow-wrap: normal; }
.horizon-axis-label[data-hour="0"] { grid-column: 1; justify-self: start; text-align: left; }
.horizon-axis-label[data-hour="5"] { grid-column: 6; }
.horizon-axis-label[data-hour="6"] { grid-column: 7; }
.horizon-axis-label[data-hour="10"] { grid-column: 11; }
.horizon-axis-label[data-hour="12"] { grid-column: 13; }
.horizon-axis-label[data-hour="15"] { grid-column: 16; }
.horizon-axis-label[data-hour="18"] { grid-column: 19; }
.horizon-axis-label[data-hour="20"] { grid-column: 21; }
.horizon-axis-label[data-hour="24"] { grid-column: 24; justify-self: end; text-align: right; }
.horizon-legend { display: flex; flex-wrap: wrap; gap: 6px var(--space-4); color: var(--text-muted); font-size: 12px; }
.horizon-legend > span { display: inline-flex; align-items: center; gap: 6px; }
.horizon-legend i { display: inline-block; width: 12px; height: 8px; border-radius: 3px; }
.horizon-legend-current { background: var(--accent); }
.horizon-legend-hours { border: 1px solid var(--ok); background: var(--ok-soft); }
.horizon-legend-projected { border: 1px dashed var(--accent); background: var(--accent-soft); }
.horizon-legend-start { width: 2px !important; height: 13px !important; border-radius: 0 !important; background: var(--accent); }
.horizon-milestones-title { margin: var(--space-2) 0 0; font-size: 13px; }
.horizon-cycles { display: grid; gap: var(--space-2); }
.horizon-cycles .field-label { font-size: 13px; }
.horizon-cycles-grid { display: grid; }
.horizon-cycle-card { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px var(--space-3); border-top: 1px solid var(--line); padding: var(--space-2) 0; }
.horizon-cycle-card:first-child { border-top: 0; }
.horizon-cycle-badge { flex: 0 0 52px; color: var(--text-muted); font-size: 12px; font-weight: 500; }
.horizon-cycle-flow { display: flex; flex: 1 1 auto; align-items: center; flex-wrap: wrap; gap: 4px var(--space-3); font-size: 13px; }
.cycle-start, .cycle-reset { display: inline-flex; align-items: center; gap: 6px; color: var(--text-soft); white-space: nowrap; }
.cycle-start strong, .cycle-reset strong { color: var(--text); font-weight: 500; }
.cycle-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.cycle-dot-start { background: var(--accent); }
.cycle-dot-reset { background: var(--ok); }
.cycle-arrow { color: var(--text-muted); }
.horizon-milestones { display: grid; margin: 0; padding: 0; list-style: none; }
.horizon-milestones li { display: grid; gap: 2px; border-top: 1px solid var(--line); padding: var(--space-2) 0; }
.horizon-milestones li:first-child { border-top: 0; }
.horizon-milestones time { color: var(--text); font-size: 13px; font-variant-numeric: tabular-nums; }
.horizon-milestones span, .horizon-empty { margin: 0; color: var(--text-muted); font-size: 13px; }
.horizon-safety-note { margin: 0; }
.schedule-safety { margin: 0; }

/* Legacy reset-plan preview (not routed) */
.schedule-preview-body { display: grid; gap: var(--space-4); }
.preview-metric { display: grid; gap: 4px; min-width: 0; }
.preview-metric strong { overflow-wrap: anywhere; }
.preview-time { font-size: 26px; font-variant-numeric: tabular-nums; }
.schedule-page:not(.settings-page) .schedule-layout { grid-template-columns: minmax(0, 1.25fr) minmax(0, .75fr); }

@media (max-width: 1100px) {
  .schedule-layout, .schedule-page:not(.settings-page) .schedule-layout { grid-template-columns: minmax(0, 1fr); gap: var(--space-6); }
  .schedule-outlook { position: static; }
}
@media (max-width: 700px) {
  .policy-choice { padding: 10px var(--space-3); }
  .dynamic-list-item { grid-template-columns: minmax(0, 1fr); }
  .time-chip { display: flex; }
  .time-chip label { flex: 1 1 100%; }
  .time-chip input { flex: 1; width: auto; }
  .active-period-item { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .active-period-item .dynamic-list-remove { grid-column: 1 / -1; justify-self: start; }
  .time-input-group { flex-wrap: wrap; }
  .horizon-axis { font-size: 10px; }
}
`;
