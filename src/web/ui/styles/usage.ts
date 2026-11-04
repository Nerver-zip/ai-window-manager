/** Usage page: provider header, line charts and the daily-usage heatmap. */
export const USAGE_CSS = `
.usage-page { display: grid; gap: var(--space-6); min-width: 0; }
.usage-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); min-width: 0; }
.usage-timezone { margin: 0; color: var(--text-muted); font-size: 13px; }
.usage-notice { margin: 0; }
.usage-filter-form { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.usage-filter-form .field { display: flex; align-items: center; gap: var(--space-2); }
.usage-filter-form .field-label { color: var(--text-muted); font-size: 13px; font-weight: 400; white-space: nowrap; }
.usage-filter-form select { width: auto; min-width: 0; max-width: 100%; min-height: 32px; padding: 4px 28px 4px 10px; font-size: 13px; }
.usage-calendar-section { min-width: 0; border-top: 1px solid var(--line); padding-top: var(--space-5); }
.usage-calendar-section .section-heading { align-items: flex-start; margin-bottom: var(--space-4); }
.usage-calendar-section .section-heading p { margin: 4px 0 0; font-size: 13px; }
.usage-calendar-layout { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: var(--space-2); min-width: 0; }
.usage-calendar-scroll { min-width: 0; overflow-x: auto; overscroll-behavior-inline: contain; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; padding: 3px 3px 10px; }
.usage-calendar-track { width: max-content; }
.usage-calendar-months { display: flex; gap: 3px; min-height: 20px; margin-bottom: 4px; }
.usage-month { flex: 0 0 14px; min-height: 20px; color: var(--text-muted); font-size: 12px; line-height: 20px; white-space: nowrap; }
.usage-calendar { display: grid; width: max-content; gap: 3px; }
.usage-calendar-row { display: flex; gap: 3px; height: 14px; }
.usage-cell, .usage-cell-spacer { flex: 0 0 14px; width: 14px; height: 14px; }
.usage-cell { position: relative; display: block; border: 1px solid transparent; border-radius: 3px; background: var(--surface-raised); }
.usage-cell:hover { border-color: var(--text-soft); }
.usage-cell.is-today { outline: 1.5px solid var(--accent); outline-offset: 1px; }
.usage-cell:focus-visible, .usage-cell.is-selected { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
.usage-swatch { position: relative; width: 14px; height: 14px; flex: 0 0 14px; border: 1px solid transparent; border-radius: 3px; }
.usage-level-0 { background: var(--surface-raised); }
.usage-level-1 { background: rgba(92, 200, 228, .24); }
.usage-level-2 { background: rgba(92, 200, 228, .44); }
.usage-level-3 { background: rgba(92, 200, 228, .70); }
.usage-level-4 { background: var(--accent-strong); }
.usage-no_data { border-color: var(--line-strong); background: transparent; }
.usage-partial { background-image: radial-gradient(circle at calc(100% - 3px) 3px, var(--warn) 0 2px, transparent 2.5px); }
.usage-weekdays { display: grid; grid-template-rows: repeat(7, 17px); margin-top: 27px; color: var(--text-muted); font-size: 12px; line-height: 17px; }
.usage-legend { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin-top: var(--space-3); color: var(--text-muted); font-size: 12px; }
.usage-legend-item, .usage-legend-scale { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.usage-legend-scale { gap: 4px; margin-left: auto; }
.usage-legend-scale > span:first-child { margin-right: 2px; }
.usage-legend-scale > span:last-child { margin-left: 2px; }
.usage-day-detail { margin-top: var(--space-5); border-top: 1px solid var(--line); padding-top: var(--space-4); }
.usage-day-detail h3 { margin: 0 0 4px; }
.usage-day-summary { margin: 0 0 4px; color: var(--text-soft); }
.usage-day-detail .muted, .usage-quality-note { margin: 0; font-size: 13px; }
.usage-quality-note { margin-top: var(--space-2); color: var(--warn); }
.usage-empty { max-width: 56ch; padding: var(--space-4) 0; }
.usage-empty h3 { margin: 0 0 4px; font-size: 14px; }
.usage-empty p { margin: 0 0 var(--space-3); }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: var(--space-4); }
.chart-card { min-width: 0; margin-bottom: 0; padding: var(--space-5); }
.chart-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); min-width: 0; }
.chart-heading { min-width: 0; }
.chart-heading h3 { margin: 0; font-size: 15px; }
.chart-description { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; }
.chart-card-controls { flex: 0 0 auto; min-width: 0; }
.chart-range-form { display: block; }
.chart-range-control { display: block; }
.chart-range-control > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.chart-range-control select { width: auto; min-width: 64px; min-height: 30px; padding: 3px 26px 3px 10px; font-size: 13px; }
.chart-range-submit { min-height: 30px; margin-top: var(--space-2); padding: 3px 10px; font-size: 12px; }
.chart-summary { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-5); margin: var(--space-2) 0 0; }
.chart-stat { display: flex; align-items: baseline; gap: 6px; margin: 0; color: var(--text-muted); font-size: 13px; }
.chart-stat strong { color: var(--text); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.chart-plot { position: relative; margin: var(--space-4) 0 0; }
.chart-svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart-gridline { stroke: var(--line-strong); stroke-dasharray: 1 6; stroke-linecap: round; stroke-width: 1; }
.chart-area { fill-opacity: .14; pointer-events: none; }
.chart-area.chart-series-1 { fill: var(--chart-1); stroke: none; }
.chart-area.chart-series-2 { fill: var(--chart-2); stroke: none; }
.chart-area.chart-series-3 { fill: var(--chart-3); stroke: none; }
.chart-area.chart-series-4 { fill: var(--chart-4); stroke: none; }
.chart-area.chart-series-5 { fill: var(--chart-5); stroke: none; }
.chart-area.chart-series-6 { fill: var(--chart-6); stroke: none; }
.chart-line { fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; vector-effect: non-scaling-stroke; }
.chart-series-1 { stroke: var(--chart-1); }
.chart-series-2 { stroke: var(--chart-2); }
.chart-series-3 { stroke: var(--chart-3); }
.chart-series-4 { stroke: var(--chart-4); }
.chart-series-5 { stroke: var(--chart-5); }
.chart-series-6 { stroke: var(--chart-6); }
.chart-axis-label { fill: var(--text-muted); font-size: 15px; font-variant-numeric: tabular-nums; }
.chart-axis-value { text-anchor: end; }
.chart-axis-time { font-size: 15px; }
.chart-point-hit { cursor: crosshair; outline: none; }
.chart-hit-target { fill: transparent; stroke: transparent; }
.chart-point-active { fill: var(--surface); stroke: currentColor; stroke-width: 2; opacity: 0; vector-effect: non-scaling-stroke; }
.chart-point-single { opacity: .85; }
.chart-point-hit:hover .chart-point-active, .chart-point-hit:focus-visible .chart-point-active { opacity: 1; }
.chart-point-hit:focus-visible .chart-hit-target { stroke: var(--accent-strong); stroke-width: 1; stroke-dasharray: 2 2; }
.chart-tooltip { position: absolute; z-index: 2; top: 8px; right: 8px; display: none; min-width: 154px; max-width: min(220px, calc(100% - 16px)); border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface-raised); padding: 8px 9px; pointer-events: none; }
.chart-tooltip[data-visible="true"] { display: block; }
.chart-tooltip[data-position="left"] { right: auto; left: 8px; }
.chart-tooltip[data-position="center"] { right: auto; left: 50%; transform: translateX(-50%); }
.chart-tooltip-time { display: block; margin-bottom: 6px; color: var(--text-soft); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.chart-tooltip-values { display: grid; gap: 4px; }
.chart-tooltip-row { display: grid; grid-template-columns: 7px minmax(0, 1fr) auto; align-items: center; gap: 6px; font-size: 12px; }
.chart-tooltip-indicator { width: 7px; height: 7px; border-radius: 50%; background: var(--chart-1); }
.chart-tooltip-indicator.chart-series-2 { background: var(--chart-2); }
.chart-tooltip-indicator.chart-series-3 { background: var(--chart-3); }
.chart-tooltip-indicator.chart-series-4 { background: var(--chart-4); }
.chart-tooltip-indicator.chart-series-5 { background: var(--chart-5); }
.chart-tooltip-indicator.chart-series-6 { background: var(--chart-6); }
.chart-tooltip-label { min-width: 0; overflow: hidden; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; }
.chart-tooltip-value { color: var(--text); font-variant-numeric: tabular-nums; }
.chart-legend { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: var(--space-2) 0 0; color: var(--text-muted); font-size: 12px; }
.chart-legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); }
.chart-legend-swatch { width: 12px; height: 2px; border-radius: 1px; background: var(--chart-1); }
.chart-legend-swatch.chart-series-2 { background: var(--chart-2); }
.chart-legend-swatch.chart-series-3 { background: var(--chart-3); }
.chart-legend-swatch.chart-series-4 { background: var(--chart-4); }
.chart-legend-swatch.chart-series-5 { background: var(--chart-5); }
.chart-legend-swatch.chart-series-6 { background: var(--chart-6); }
.chart-legend-context { color: var(--text-muted); }
.chart-empty { display: grid; place-items: center; min-height: 160px; border-top: 1px solid var(--line); color: var(--text-muted); padding: var(--space-5); text-align: center; }
.chart-empty strong { color: var(--text-soft); }
.chart-empty p { margin: 4px 0 0; font-size: 13px; }
.chart-empty-mark { color: var(--text-faint); font-size: 26px; line-height: 1; }
.chart-plot-empty { position: absolute; inset: 6% 0 16% 10%; display: grid; place-items: center; color: var(--text-muted); font-size: 13px; text-align: center; }

@media (max-width: 700px) {
  .usage-page { gap: var(--space-5); }
  .chart-card { padding: var(--space-4); }
  .chart-plot { margin-top: var(--space-3); }
  .chart-axis-label, .chart-axis-time { font-size: 23px; }
  .chart-axis-time-mid .chart-axis-zone { display: none; }
  .usage-filter-form .field { flex-wrap: wrap; }
  .usage-legend-scale { margin-left: 0; }
  .usage-calendar-layout { grid-template-columns: 30px minmax(0, 1fr); gap: 6px; }
}
`;
