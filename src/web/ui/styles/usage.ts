/** Usage page: filters, heatmap calendar and line charts. */
export const USAGE_CSS = `
.usage-page { display: grid; gap: 24px; }
.usage-controls, .usage-calendar-section, .usage-day-detail { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); padding: 22px; }
.usage-controls { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(280px, 1.2fr); align-items: end; gap: 24px; }
.usage-controls-copy h2 { margin: 2px 0 6px; }
.usage-controls-copy p { margin: 0 0 6px; color: var(--text-muted); }
.usage-controls-copy .usage-timezone { margin-top: 10px; font-size: 12px; }
.usage-filter-form { display: grid; grid-template-columns: minmax(140px, 1fr) auto; align-items: end; gap: 12px; min-width: 0; }
.usage-filter-panel { display: grid; gap: 12px; min-width: 0; }
.usage-filter-panel > .provider-picker { min-width: 0; }
.usage-filter-form select { min-width: 0; }
.usage-calendar-section .section-heading { align-items: flex-start; }
.usage-calendar-section .section-heading p { margin: 6px 0 0; font-size: 12px; }
.usage-calendar-layout { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 8px; min-width: 0; }
.usage-calendar-scroll { min-width: 0; overflow-x: auto; overscroll-behavior-inline: contain; scrollbar-color: var(--border-strong) transparent; padding: 3px 0 8px; }
.usage-calendar-track { width: max-content; }
.usage-calendar-months { display: flex; gap: 3px; min-height: 18px; margin-bottom: 3px; }
.usage-month { flex: 0 0 13px; min-height: 18px; color: var(--text-muted); font-size: 10px; line-height: 18px; white-space: nowrap; }
.usage-calendar { display: grid; width: max-content; gap: 3px; }
.usage-calendar-row { display: flex; gap: 3px; height: 13px; }
.usage-cell, .usage-cell-spacer { flex: 0 0 13px; width: 13px; height: 13px; }
.usage-cell { display: block; border: 1px solid transparent; border-radius: 3px; background: var(--surface-raised); }
.usage-cell:hover { border-color: var(--accent-strong); }
.usage-cell:focus-visible, .usage-cell.is-selected { outline: 2px solid var(--focus); outline-offset: 2px; }
.usage-cell.is-today { border-color: var(--accent); }
.usage-level-0 { background: #283344; }
.usage-level-1 { background: #425b88; }
.usage-level-2 { background: #5577b8; }
.usage-level-3 { background: #7596de; }
.usage-level-4 { background: #a9bcff; }
.usage-no_data { background: #151c27; border-color: #344154; }
.usage-partial { background-image: repeating-linear-gradient(135deg, transparent 0 3px, rgb(238 242 248 / 32%) 3px 4px); }
.usage-weekdays { display: grid; grid-template-rows: repeat(7, 16px); gap: 0; margin-top: 21px; color: var(--text-muted); font-size: 10px; line-height: 16px; }
.usage-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 7px 12px; margin-top: 13px; color: var(--text-muted); font-size: 11px; }
.usage-legend-item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.usage-swatch { width: 13px; height: 13px; border: 1px solid var(--border); border-radius: 3px; }
.usage-legend-note { flex-basis: 100%; }
.usage-day-list { margin-top: 14px; color: var(--text-muted); font-size: 12px; }
.usage-day-list summary { display: inline-flex; min-height: 44px; align-items: center; cursor: pointer; color: var(--accent); }
.usage-day-list ol { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 4px 18px; max-height: 320px; overflow: auto; margin: 0; padding: 12px 0 0 20px; }
.usage-day-list li a { display: flex; min-height: 40px; justify-content: space-between; gap: 8px; align-items: center; }
.usage-day-list li a span { text-align: right; }
.usage-day-detail { padding: 18px 22px; }
.usage-day-detail h3 { margin: 3px 0 5px; }
.usage-day-summary { margin: 0 0 5px; color: var(--text-soft); }
.usage-day-detail .muted, .usage-quality-note { margin: 0; font-size: 12px; }
.usage-quality-note { margin-top: 8px; color: var(--warning); }
.usage-empty { border: 1px dashed var(--border-strong); border-radius: var(--radius-md); background: var(--surface-soft); padding: 24px; }
.usage-empty h3 { margin: 0 0 5px; }
.usage-empty p { margin: 0; color: var(--text-muted); }
.usage-notice { border-left: 2px solid var(--warning); background: var(--surface-raised); padding: 12px 16px; color: var(--text-soft); }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 16px; }
.chart-card { margin-bottom: 0; padding: 20px 20px 16px; }
.chart-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; min-width: 0; }
.chart-heading { min-width: 0; }
.chart-heading h3 { margin: 4px 0 0; font-size: 16px; }
.chart-description { margin: 6px 0 0; color: var(--text-muted); font-size: 12px; }
.chart-card-controls { display: flex; align-items: flex-start; justify-content: flex-end; gap: 14px; flex: 0 0 auto; min-width: 0; }
.chart-range-form { display: grid; gap: 3px; min-width: 92px; }
.chart-range-control { display: grid; gap: 3px; color: var(--text-muted); font-size: 11px; }
.chart-range-control select { min-height: 34px; min-width: 92px; padding: 5px 26px 5px 9px; font-size: 12px; }
.chart-range-submit { min-height: 32px; padding: 5px 9px; font-size: 11px; }
.chart-summary { display: grid; gap: 6px; flex: 0 0 auto; min-width: 112px; text-align: right; }
.chart-stat { display: grid; gap: 1px; margin: 0; color: var(--text-muted); font-size: 11px; }
.chart-stat strong { color: var(--text); font-size: 13px; font-variant-numeric: tabular-nums; }
.chart-plot { position: relative; min-height: 230px; margin: 12px -4px 0 -8px; }
.chart-svg { display: block; width: 100%; height: 230px; overflow: visible; }
.chart-gridline { stroke: var(--chart-grid); stroke-dasharray: 2 5; stroke-width: 1; }
.chart-area { fill-opacity: .3; pointer-events: none; }
.chart-area.chart-series-1 { fill: var(--chart-1); stroke: none; }
.chart-area.chart-series-2 { fill: var(--chart-2); stroke: none; }
.chart-area.chart-series-3 { fill: var(--chart-3); stroke: none; }
.chart-area.chart-series-4 { fill: var(--chart-4); stroke: none; }
.chart-area.chart-series-5 { fill: var(--chart-5); stroke: none; }
.chart-area.chart-series-6 { fill: var(--chart-6); stroke: none; }
.chart-line { fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.chart-series-1 { stroke: var(--chart-1); }
.chart-series-2 { stroke: var(--chart-2); }
.chart-series-3 { stroke: var(--chart-3); }
.chart-series-4 { stroke: var(--chart-4); }
.chart-series-5 { stroke: var(--chart-5); }
.chart-series-6 { stroke: var(--chart-6); }
.chart-axis-label { fill: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.chart-axis-value { text-anchor: start; }
.chart-axis-time { font-size: 10px; }
.chart-point-hit { cursor: crosshair; outline: none; }
.chart-hit-target { fill: transparent; stroke: transparent; }
.chart-point-active { fill: var(--surface); stroke: currentColor; stroke-width: 2; opacity: 0; vector-effect: non-scaling-stroke; }
.chart-point-single { opacity: .85; }
.chart-point-hit:hover .chart-point-active, .chart-point-hit:focus-visible .chart-point-active { opacity: 1; }
.chart-point-hit:focus-visible .chart-hit-target { stroke: var(--focus); stroke-width: 1; stroke-dasharray: 2 2; }
.chart-tooltip { position: absolute; z-index: 2; top: 8px; right: 8px; display: none; min-width: 154px; max-width: min(220px, calc(100% - 16px)); border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface-raised); padding: 8px 9px; box-shadow: 0 8px 24px rgb(0 0 0 / 24%); pointer-events: none; }
.chart-tooltip[data-visible="true"] { display: block; }
.chart-tooltip[data-position="left"] { right: auto; left: 8px; }
.chart-tooltip[data-position="center"] { right: auto; left: 50%; transform: translateX(-50%); }
.chart-tooltip-time { display: block; margin-bottom: 6px; color: var(--text-soft); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.chart-tooltip-values { display: grid; gap: 4px; }
.chart-tooltip-row { display: grid; grid-template-columns: 7px minmax(0, 1fr) auto; align-items: center; gap: 6px; font-size: 11px; }
.chart-tooltip-indicator { width: 7px; height: 7px; border-radius: 50%; background: var(--chart-1); }
.chart-tooltip-indicator.chart-series-2 { background: var(--chart-2); }
.chart-tooltip-indicator.chart-series-3 { background: var(--chart-3); }
.chart-tooltip-indicator.chart-series-4 { background: var(--chart-4); }
.chart-tooltip-indicator.chart-series-5 { background: var(--chart-5); }
.chart-tooltip-indicator.chart-series-6 { background: var(--chart-6); }
.chart-tooltip-label { min-width: 0; overflow: hidden; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; }
.chart-tooltip-value { color: var(--text); font-variant-numeric: tabular-nums; }
.chart-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; margin: 2px 0 0; color: var(--text-muted); font-size: 11px; }
.chart-legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--text-soft); }
.chart-legend-swatch { width: 7px; height: 7px; border-radius: 50%; background: var(--chart-1); }
.chart-legend-swatch.chart-series-2 { background: var(--chart-2); }
.chart-legend-swatch.chart-series-3 { background: var(--chart-3); }
.chart-legend-swatch.chart-series-4 { background: var(--chart-4); }
.chart-legend-swatch.chart-series-5 { background: var(--chart-5); }
.chart-legend-swatch.chart-series-6 { background: var(--chart-6); }
.chart-legend-context { color: var(--text-muted); }
.chart-empty { display: grid; place-items: center; min-height: 230px; border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); color: var(--text-muted); padding: 24px; text-align: center; }
.chart-empty strong { color: var(--text-soft); }
.chart-empty p { margin: 4px 0 0; font-size: 12px; }
.chart-empty-mark { color: var(--accent); font-size: 26px; line-height: 1; }
.chart-plot-empty { position: absolute; inset: 76px 44px 54px; display: grid; place-items: center; color: var(--text-muted); font-size: 12px; text-align: center; }

@media (max-width: 1100px) {
  .usage-controls { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
  .usage-filter-form { grid-template-columns: 1fr; }
  .chart-card { padding: 16px; }
  .chart-card-header { display: block; }
  .chart-card-controls { display: grid; grid-template-columns: minmax(0, 1fr); justify-content: stretch; gap: 12px; margin-top: 12px; }
  .chart-range-form, .chart-range-control, .chart-range-control select { width: 100%; }
  .chart-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 12px; text-align: left; }
  .chart-plot { min-height: 205px; margin: 10px -4px 0 -8px; }
  .chart-svg { height: 205px; }
  .chart-axis-label, .chart-axis-time { font-size: 18px; }
  .usage-controls, .usage-calendar-section, .usage-day-detail { padding: 16px; }
  .usage-calendar-section .section-heading { align-items: flex-start; }
  .usage-calendar-section .section-heading > :last-child { text-align: left; }
  .usage-calendar-layout { grid-template-columns: 32px minmax(0, 1fr); gap: 6px; }
  .usage-calendar { gap: 4px; }
  .usage-calendar-row { gap: 4px; }
  .usage-calendar-months { gap: 4px; }
  .usage-cell, .usage-cell-spacer { width: 13px; height: 13px; }
  .usage-day-list ol { grid-template-columns: 1fr; }
}
`;
