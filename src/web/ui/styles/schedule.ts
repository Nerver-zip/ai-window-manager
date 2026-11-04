/** Schedule page: policy choice, start-time lists, preview and horizon. */
export const SCHEDULE_CSS = `
.policy-fields { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 20px; }
.policy-fields[aria-hidden="true"] { display: none; }
.policy-fields > .field-help { margin-top: 14px; }
.schedule-primary-fields { margin-bottom: 22px; }
.policy-choice-group { border: 0; margin: 0; padding: 0; }
.policy-choice-group > legend { margin: 0 0 6px; padding: 0; color: var(--text); font-size: 14px; font-weight: 650; }
.policy-choice-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.policy-choice { position: relative; display: grid; grid-template-columns: 34px minmax(0, 1fr) 16px; align-items: start; gap: 12px; min-height: 94px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); padding: 14px; cursor: pointer; transition: border-color .15s ease, background-color .15s ease; }
.policy-choice:hover { border-color: var(--border-strong); background: var(--surface-raised); }
.policy-choice.is-selected { border-color: var(--accent); background: #202b42; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent); }
.policy-choice:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 3px; }
.policy-choice input { position: absolute; width: 1px; height: 1px; min-height: 0; opacity: 0; }
.policy-choice-icon { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 7px; color: var(--text-muted); }
.policy-choice-icon svg { width: 19px; height: 19px; }
.policy-choice.is-selected .policy-choice-icon { border-color: var(--accent); color: var(--accent-strong); }
.policy-choice-copy { display: grid; gap: 5px; min-width: 0; }
.policy-choice-copy strong { color: var(--text); font-size: 13px; line-height: 1.3; }
.policy-choice-copy > span { color: var(--text-muted); font-size: 11px; line-height: 1.4; }
.policy-choice-indicator { width: 14px; height: 14px; border: 1px solid var(--border-strong); border-radius: 50%; margin-top: 2px; }
.policy-choice.is-selected .policy-choice-indicator { border: 4px solid var(--accent); background: var(--surface-soft); }
.policy-controls-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; align-items: start; }
.policy-guidance { margin: 18px 0 0; border-left: 2px solid var(--border-strong); padding: 6px 0 6px 12px; color: var(--text-muted); font-size: 12px; }
.upcoming-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.upcoming-list li { display: grid; grid-template-columns: minmax(110px, .35fr) minmax(0, 1fr); gap: 16px; border-bottom: 1px solid var(--border); padding: 14px 0; }
.upcoming-list li:first-child { padding-top: 0; }
.upcoming-list li:last-child { border-bottom: 0; padding-bottom: 0; }
.upcoming-list time { color: var(--accent-strong); font-variant-numeric: tabular-nums; }
.dynamic-list-field { min-width: 0; }
.dynamic-list { display: grid; gap: 10px; }
.dynamic-list-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; }
.active-period-item { grid-template-columns: repeat(2, minmax(0, 1fr)) auto; }
.dynamic-list-item label { min-width: 0; }
.time-chip { display: inline-flex; width: fit-content; max-width: 100%; align-items: center; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-soft); padding: 4px 5px 4px 12px; }
.time-chip label { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 11px; white-space: nowrap; }
.time-chip input { width: 126px; min-height: 36px; border: 0; background: transparent; padding: 5px 8px; color: var(--text); font-size: 13px; font-variant-numeric: tabular-nums; }
.time-chip input:focus { border: 1px solid var(--accent); }
.time-chip .dynamic-list-remove { min-height: 36px; border-radius: 999px; padding: 5px 10px; }
.dynamic-list-actions { display: grid; justify-items: start; gap: 10px; }
.schedule-presets { display: flex; flex-wrap: wrap; gap: 7px; }
.schedule-presets .button { min-height: 38px; padding: 6px 10px; font-size: 11px; }
.schedule-presets .button span { color: var(--text-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.dynamic-list-remove, .dynamic-list-add { min-height: 40px; padding: 8px 12px; font-size: 12px; }
.dynamic-list-add { justify-self: start; }
.schedule-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, .75fr); gap: 24px; align-items: start; }
.schedule-preview { border-top: 2px solid var(--accent); }
.schedule-preview-body { display: grid; gap: 20px; }
.preview-time { font-size: 32px; font-variant-numeric: tabular-nums; }
.preview-metric { display: grid; gap: 4px; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); padding: 16px; }
.preview-metric strong { font-size: 16px; overflow-wrap: anywhere; }
.next-start-preview { display: grid; gap: 3px; border-left: 2px solid var(--accent); padding: 6px 0 6px 16px; }
.next-start-preview .eyebrow { margin-bottom: 0; }
.next-start-preview strong { font-size: clamp(20px, 3vw, 28px); font-variant-numeric: tabular-nums; }
.schedule-explanation { margin: 0; color: var(--text-muted); }
.schedule-explanation strong { color: var(--text-soft); }
.schedule-preview--unknown { border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); padding: 18px; }
.schedule-preview--unknown p:last-child { margin-bottom: 0; }
.schedule-details { margin-top: -12px; border-top: 1px solid var(--border); padding-top: 18px; }
.schedule-details .schedule-preview-body { grid-template-columns: minmax(0, 1fr); }
.schedule-horizon-card { overflow: hidden; }
.schedule-horizon { display: grid; gap: 14px; min-width: 0; }
.horizon-timeline-head { display: flex; justify-content: space-between; color: var(--text-muted); font-size: 11px; }
.horizon-timeline-head strong { color: var(--accent-strong); font-weight: 650; }
.horizon-chart-wrap { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); padding: 10px 10px 8px; }
.schedule-horizon-chart { display: block; width: 100%; height: auto; overflow: visible; }
.horizon-track { stroke: var(--border-strong); stroke-width: 6; stroke-linecap: round; }
.horizon-active-hours { fill: color-mix(in srgb, var(--success) 10%, transparent); stroke: color-mix(in srgb, var(--success) 45%, transparent); stroke-width: 1; }
.horizon-current { fill: var(--accent); }
.horizon-projected { fill: color-mix(in srgb, var(--accent) 24%, transparent); stroke: var(--accent); stroke-width: 2; stroke-dasharray: 5 4; }
.horizon-tick { stroke: var(--border); stroke-width: 1; }
.horizon-now { stroke: var(--text); stroke-width: 2; }
.horizon-marker { stroke-width: 2; stroke-dasharray: 3 3; }
.horizon-marker-start { stroke: var(--accent); }
.horizon-marker-reset { stroke: var(--success); }
.horizon-marker-dot { fill: var(--surface); stroke-width: 3; }
.horizon-axis { display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); padding-inline: 4%; color: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.horizon-axis-label { min-width: 0; justify-self: center; white-space: nowrap; }
.horizon-axis-label[data-hour="0"] { grid-column: 1; justify-self: start; text-align: left; }
.horizon-axis-label[data-hour="5"] { grid-column: 6; }
.horizon-axis-label[data-hour="6"] { grid-column: 7; }
.horizon-axis-label[data-hour="10"] { grid-column: 11; }
.horizon-axis-label[data-hour="12"] { grid-column: 13; }
.horizon-axis-label[data-hour="15"] { grid-column: 16; }
.horizon-axis-label[data-hour="18"] { grid-column: 19; }
.horizon-axis-label[data-hour="20"] { grid-column: 21; }
.horizon-axis-label[data-hour="24"] { grid-column: 24; justify-self: end; text-align: right; }
.horizon-legend { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--text-muted); font-size: 11px; }
.horizon-legend > span { display: inline-flex; align-items: center; gap: 7px; }
.horizon-legend i { display: inline-block; width: 12px; height: 8px; border-radius: 3px; }
.horizon-legend-current { background: var(--accent); }
.horizon-legend-hours { border: 1px solid var(--success); background: color-mix(in srgb, var(--success) 18%, transparent); }
.horizon-legend-projected { border: 1px dashed var(--accent); background: color-mix(in srgb, var(--accent) 24%, transparent); }
.horizon-legend-start { width: 2px !important; height: 13px !important; border-radius: 0 !important; background: var(--accent); }
.horizon-milestones-title { margin: 4px 0 -6px; font-size: 13px; }
.horizon-cycles { display: grid; gap: 8px; margin-top: 14px; }
.horizon-cycles-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.horizon-cycle-card { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); padding: 10px 12px; }
.horizon-cycle-badge { align-self: flex-start; border-radius: 4px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent-strong); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.5px; padding: 2px 6px; }
.horizon-cycle-flow { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; }
.cycle-start, .cycle-reset { display: inline-flex; align-items: center; gap: 5px; color: var(--text-soft); }
.cycle-start strong, .cycle-reset strong { color: var(--text); font-weight: 600; }
.cycle-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.cycle-dot-start { background: var(--accent); }
.cycle-dot-reset { background: var(--success); }
.cycle-arrow { color: var(--text-muted); font-size: 13px; font-weight: bold; }
.time-input-group { display: flex; align-items: center; gap: 8px; }
.time-input-group input[type="time"] { flex: 1; min-width: 0; }
.time-stepper { display: inline-flex; align-items: center; gap: 4px; }
.button-step { min-height: 38px; padding: 6px 10px; font-size: 12px; font-weight: 600; }
.time-chip .time-stepper { margin: 0 4px; }
.horizon-milestones { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.horizon-milestones li { display: grid; grid-template-columns: minmax(140px, .8fr) minmax(0, 1.2fr); gap: 12px; border-bottom: 1px solid var(--border); padding: 10px 0; }
.horizon-milestones li:last-child { border-bottom: 0; }
.horizon-milestones time { color: var(--text-soft); font-size: 12px; font-variant-numeric: tabular-nums; }
.horizon-milestones span, .horizon-empty { margin: 0; color: var(--text-muted); font-size: 12px; }
.horizon-safety-note { margin: 0; }
.schedule-safety { margin: 24px 0 0; }

@media (max-width: 1100px) {
  .schedule-layout { grid-template-columns: 1fr; }
  .policy-choice-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (min-width: 701px) and (max-width: 820px) {
  .policy-choice-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 700px) {
  .policy-controls-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .policy-choice-grid { grid-template-columns: minmax(0, 1fr); }
  .policy-choice { min-height: 76px; }
  .dynamic-list-item { grid-template-columns: 1fr; }
  .time-chip { display: inline-flex; width: fit-content; grid-template-columns: none; }
  .time-chip .dynamic-list-remove { width: auto; }
  .active-period-item { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .active-period-item .dynamic-list-remove { grid-column: 1 / -1; width: 100%; }
  .dynamic-list-remove, .dynamic-list-add { width: 100%; }
  .dynamic-list-actions { width: 100%; }
  .schedule-presets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .schedule-presets .button { width: 100%; }
  .upcoming-list li { grid-template-columns: 1fr; gap: 4px; }
  .horizon-axis { font-size: 9px; }
  .horizon-cycles-grid { grid-template-columns: 1fr; }
  .time-input-group { flex-wrap: wrap; }
  .time-stepper { justify-content: stretch; }
  .time-stepper .button-step { flex: 1; }
  .horizon-milestones li { grid-template-columns: 1fr; gap: 3px; }
}
`;
