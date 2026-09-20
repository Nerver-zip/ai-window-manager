// Served as a same-origin stylesheet; no inline styles or external assets.
export const APP_CSS = `
:root {
  color-scheme: dark;
  --bg: #0d1118;
  --sidebar: #111722;
  --surface: #161d29;
  --surface-raised: #1b2432;
  --surface-soft: #121923;
  --input: #0f151f;
  --border: #2b3748;
  --border-strong: #43526a;
  --text: #eef2f8;
  --text-soft: #c7d0df;
  --text-muted: #96a5ba;
  --accent: #9db2ff;
  --accent-strong: #bdcaff;
  --success: #83ddb0;
  --warning: #efc878;
  --danger: #ff9fa8;
  --unknown: #b2bbca;
  --focus: #d6ddff;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;
  --radius-sm: 7px;
  --radius-md: 10px;
  --content-width: 1320px;
  --sidebar-width: 236px;
  --font-sm: 12px;
  --font-base: 14px;
  --line-height: 1.55;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: var(--font-base);
  line-height: var(--line-height);
}

* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
button, input, select { font: inherit; }
button, a, input, select, summary { touch-action: manipulation; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 4px; }
h1, h2, h3, h4, p { margin-top: 0; }
h1 { margin-bottom: 12px; font-size: clamp(28px, 3vw, 38px); letter-spacing: -1.3px; line-height: 1.15; }
h2 { margin-bottom: 8px; font-size: 20px; letter-spacing: -.4px; line-height: 1.25; }
h3 { font-size: 16px; line-height: 1.3; }
h4 { font-size: 14px; }
p { margin-bottom: 16px; }
small, .muted, .page-description, .chart-legend { color: var(--text-muted); }
.unknown { color: var(--unknown); }
.warning { color: var(--warning); }

.app-shell { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; padding: 30px 18px 20px; border-right: 1px solid var(--border); background: var(--sidebar); }
.brand { display: flex; align-items: center; gap: 12px; padding: 0 12px; color: var(--text); font-weight: 650; line-height: 1.35; }
.brand:hover { text-decoration: none; }
.brand-symbol { color: var(--accent); font-size: 29px; line-height: 1; }
.brand-subtitle { display: block; margin-top: 4px; color: var(--text-muted); font-size: 10px; letter-spacing: 3px; }
.nav-caption { margin: 52px 12px 12px; color: var(--text-muted); font-size: 10px; letter-spacing: 1.8px; }
.sidebar nav { display: grid; gap: 4px; }
.sidebar nav a { display: flex; align-items: center; gap: 12px; min-height: 46px; padding: 10px 12px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--text-muted); font-weight: 550; }
.sidebar nav a[aria-current] { border-color: #354466; background: #202c48; color: var(--accent-strong); }
.sidebar nav a:hover { background: var(--surface-raised); text-decoration: none; }
.nav-mark { width: 22px; color: currentColor; font-size: 19px; text-align: center; }
.sidebar-footer { margin-top: auto; padding: 24px 10px 0; color: var(--text-muted); font-size: 12px; }
.sidebar-footer div { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; }
.sidebar-footer a { display: inline-flex; align-items: center; min-height: 44px; }
.local-label { border-left: 2px solid var(--accent); padding-left: 10px; }

main { width: 100%; max-width: var(--content-width); min-width: 0; margin: auto; padding: 46px 48px 28px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 36px; }
.page-description { max-width: 720px; margin-bottom: 0; font-size: 16px; }
.eyebrow { margin-bottom: 10px; color: var(--accent); font-size: 10px; font-weight: 650; letter-spacing: 2px; }
.badge { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-raised); padding: 3px 9px; color: var(--text-soft); font-size: 10px; font-weight: 650; letter-spacing: .6px; white-space: normal; overflow-wrap: anywhere; }
.badge-success { color: var(--success); }
.badge-warning { color: var(--warning); }
.badge-danger { color: var(--danger); }
.badges { display: flex; flex-wrap: wrap; gap: 8px; }

.card, .provider, .usage-card { min-width: 0; margin-bottom: 24px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); padding: 26px; }
.card-header, .provider-header, .window-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.card-header { border-bottom: 1px solid var(--border); margin-bottom: 24px; padding-bottom: 20px; }
.heading-copy { min-width: 0; }
.heading-copy > :last-child { margin-bottom: 0; }
.provider-header { border-bottom: 1px solid var(--border); margin-bottom: 22px; padding-bottom: 20px; }
.provider-header h2, .provider-header h3 { margin-bottom: 4px; }
.provider-meta { margin: 0; color: var(--text-muted); font-size: 12px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
.section-heading h2 { margin-bottom: 0; }
.section-heading > :first-child > :last-child { margin-bottom: 0; }
.section-count { color: var(--text-muted); font-size: 12px; }

.summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 26px; }
.summary-stat { min-width: 0; border-top: 2px solid var(--border-strong); border-bottom: 1px solid var(--border); padding: 16px 4px 14px; }
.summary-stat strong { display: block; color: var(--text); font-size: 28px; font-weight: 520; font-variant-numeric: tabular-nums; }
.summary-stat span { color: var(--text-muted); font-size: 12px; }
.window-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 14px; }
.window-card { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); padding: 20px; }
.window-card h3 { margin-bottom: 4px; }
.window-id { margin-bottom: 18px; color: var(--text-muted); font-size: 11px; overflow-wrap: anywhere; }
.usage-value { font-size: 28px; letter-spacing: -.8px; font-variant-numeric: tabular-nums; }
.usage-value small { color: var(--text-muted); font-size: 12px; letter-spacing: 0; }
.quota-progress { display: block; width: 100%; height: 7px; margin: 16px 0 8px; border: 0; border-radius: 10px; background: var(--surface-raised); accent-color: var(--accent); overflow: hidden; }
progress::-webkit-progress-bar { background: var(--surface-raised); }
progress::-webkit-progress-value { background: var(--accent); }
progress::-moz-progress-bar { background: var(--accent); }
.window-card dl { margin: 18px 0 0; }
.window-card dd { font-size: 12px; }
.window-card dd .muted { display: block; font-size: 10px; }
.reset-relative { display: block; color: var(--accent); font-size: 13px; }
.decision-panel { border-top: 1px solid var(--border); margin-top: 24px; padding-top: 20px; }
.decision-panel h3 { margin-bottom: 8px; }
.decision-panel p { color: var(--text-muted); }

fieldset { min-inline-size: 0; border: 0; margin: 0; padding: 0; }
fieldset > legend { width: 100%; border-bottom: 1px solid var(--border); margin-bottom: 20px; padding: 0 0 10px; color: var(--text-soft); font-size: 13px; font-weight: 650; }
form { min-width: 0; }
label { display: grid; gap: 8px; font-size: 12px; font-weight: 550; }
input, select { display: block; width: 100%; min-width: 0; min-height: 44px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--input); color: var(--text); padding: 10px 12px; }
input:hover, select:hover { border-color: var(--border-strong); }
input:focus, select:focus { border-color: var(--accent); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.field-help, .help-text { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.form-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 26px; }
button, .button { display: inline-flex; align-items: center; justify-content: center; width: fit-content; min-height: 44px; border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--accent-strong); color: #18233a; padding: 10px 18px; font-weight: 700; cursor: pointer; }
button:hover, .button:hover { background: #d1d9ff; text-decoration: none; }
button:disabled { opacity: .6; cursor: not-allowed; }
.button-primary { white-space: nowrap; }
.button-secondary { border-color: var(--border-strong); background: var(--surface-raised); color: var(--text-soft); }
.button-secondary:hover { border-color: var(--accent); background: #25324b; color: var(--text); }
.button.is-disabled { opacity: .45; cursor: default; pointer-events: none; }

.schedule-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, .75fr); gap: 24px; align-items: start; }
.schedule-preview { border-top: 2px solid var(--accent); }
.schedule-preview-body { display: grid; gap: 20px; }
.preview-time { font-size: 32px; font-variant-numeric: tabular-nums; }
.preview-metric { display: grid; gap: 4px; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); padding: 16px; }
.preview-metric strong { font-size: 16px; overflow-wrap: anywhere; }
.schedule-preview--unknown { border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); padding: 18px; }
.schedule-preview--unknown p:last-child { margin-bottom: 0; }
details { margin-top: 12px; font-size: 12px; }
summary { display: flex; align-items: center; min-height: 44px; color: var(--text-muted); cursor: pointer; }
pre, code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
pre { max-width: 100%; overflow: auto; border-radius: 6px; background: var(--input); padding: 16px; }
.notice, .alert { margin-bottom: 20px; border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; background: var(--surface-raised); padding: 14px 18px; }
.stale { border-color: #79603d; }
.stale-notice { color: var(--warning); font-size: 12px; }
.empty-state { border: 1px dashed var(--border-strong); border-radius: var(--radius-md); color: var(--text-muted); padding: 32px; text-align: center; }
.empty-state h2 { color: var(--text); }
dl { display: grid; grid-template-columns: minmax(80px, .7fr) minmax(0, 1.3fr); gap: 10px 16px; }
dt { color: var(--text-muted); font-size: 12px; }
dd { margin: 0; overflow-wrap: anywhere; }

.settings-page, .history-page { display: grid; gap: 24px; }
.settings-stack { display: grid; gap: 16px; }
.provider-settings { margin-bottom: 0; }
.provider-settings h3 { margin-bottom: 4px; }
.provider-settings h4 { margin: 24px 0 12px; font-size: 13px; }
.provider-settings dl { margin: 0; }
.provider-settings dd { font-size: 12px; }
.provider-settings small { color: var(--text-muted); }
.schedule-safety { margin: 24px 0 0; }

.history-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(480px, 1.35fr); gap: 24px; align-items: end; margin-bottom: 0; }
.history-toolbar-summary { display: grid; gap: 4px; }
.history-toolbar-summary strong { font-size: 18px; }
.history-toolbar-summary .eyebrow { margin-bottom: 0; }
.history-toolbar-fields { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(130px, 1fr) auto; gap: 12px; align-items: end; min-width: 0; }
.field { min-width: 0; }
.field-label { color: var(--text-muted); font-size: 12px; }
.history-sections { display: grid; gap: 36px; }
.history-section { min-width: 0; }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 16px; }
.chart { margin-bottom: 0; }
.chart-heading { min-width: 0; }
.chart-heading h3 { margin: 4px 0 0; }
.chart-divider { color: var(--text-muted); font-weight: 400; }
.chart-summary { display: grid; gap: 4px; text-align: right; }
.chart-stat { margin: 0; color: var(--text-muted); font-size: 12px; }
.chart-stat strong { color: var(--text); font-variant-numeric: tabular-nums; }
.chart-scroll { width: 100%; overflow: hidden; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 12px 0 2px; }
.chart-svg { display: block; width: 100%; height: auto; min-height: 146px; }
.chart-gridline { stroke: var(--border); stroke-dasharray: 3 5; }
.chart-axis { stroke: var(--border-strong); stroke-width: 1; }
.chart-line { stroke: var(--accent); fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.chart-point { fill: var(--accent-strong); stroke: var(--surface); stroke-width: 2; }
.chart-axis-label { fill: var(--text-muted); font-size: 9px; }
.chart-axis-time { font-size: 8px; }
.chart-legend { margin: 12px 0 0; font-size: 11px; }

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

.usage-grid, .window-grid { min-width: 0; }
.usage-gridline, .usage-line { fill: none; }
.usage-gridline { stroke: var(--border); stroke-dasharray: 3 5; }
.usage-line { stroke: var(--accent); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.5; }
.event time, .event .reason, .event .provider, .event .severity { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.event-warn { border-left-color: var(--warning); }
.event-error { border-left-color: var(--danger); }
.page-footer { display: flex; justify-content: space-between; gap: 16px; margin-top: 48px; border-top: 1px solid var(--border); padding-top: 20px; color: var(--text-muted); font-size: 11px; }
.skip-link { position: absolute; z-index: 10; top: -100px; left: 20px; background: var(--surface-raised); padding: 12px; }
.skip-link:focus { top: 12px; }
h1, h2, h3, h4, span { overflow-wrap: anywhere; }

@media (min-width: 1600px) { main { padding: 56px 64px 32px; } }
@media (max-width: 1100px) {
  main { padding: 32px; }
  .schedule-layout, .history-toolbar { grid-template-columns: 1fr; }
  .page-header > .badge { display: none; }
}
@media (max-width: 700px) {
  .app-shell { display: block; }
  .sidebar { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: 16px; }
  .brand { padding: 0; font-size: 13px; }
  .brand-symbol { font-size: 24px; }
  .brand-subtitle { font-size: 8px; }
  .nav-caption, .sidebar-footer { display: none; }
  .sidebar nav { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin-top: 18px; }
  .sidebar nav a { justify-content: center; gap: 4px; padding: 8px 4px; font-size: 12px; }
  .nav-mark { display: none; }
  main { padding: 24px 16px; }
  h1 { font-size: 28px; }
  .page-header { margin-bottom: 26px; }
  .page-description { font-size: 14px; }
  .card, .provider, .usage-card { padding: 18px; }
  .card-header, .provider-header { display: block; }
  .card-header > :last-child, .provider-header > :last-child { margin-top: 14px; }
  .summary-grid { gap: 12px; }
  .summary-stat { padding: 12px 0; }
  .summary-stat strong { font-size: 23px; }
  .summary-stat span { font-size: 10px; }
  .form-grid, .history-toolbar-fields { grid-template-columns: 1fr; }
  .form-actions button, .history-toolbar-fields button { width: 100%; }
  .window-card { padding: 16px; }
  .chart-summary { margin-top: 14px; text-align: left; }
  .history-section .section-heading { align-items: flex-start; flex-direction: column; gap: 6px; }
  .history-pagination { align-items: flex-start; flex-direction: column; }
  .history-pagination-actions, .history-pagination-actions .button { width: 100%; }
  .history-pagination-actions .button { flex: 1; }
  .page-footer { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}
`;
