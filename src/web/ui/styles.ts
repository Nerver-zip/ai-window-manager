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
  --success-rgb: 131, 221, 176;
  --success: #83ddb0;
  --warning: #efc878;
  --danger: #ff9fa8;
  --unknown: #b2bbca;
  --focus: #d6ddff;
  --chart-1: #9db2ff;
  --chart-2: #73d5c0;
  --chart-3: #f0c674;
  --chart-4: #e9a5c7;
  --chart-5: #a9d18e;
  --chart-6: #c4a7e7;
  --chart-grid: #2a3546;
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
.brand-logo { width: 30px; height: 30px; border-radius: 7px; object-fit: contain; flex-shrink: 0; }
.brand-symbol { color: var(--accent); font-size: 29px; line-height: 1; }
.brand-subtitle { display: block; margin-top: 4px; color: var(--text-muted); font-size: 10px; letter-spacing: 3px; }
.nav-caption { margin: 52px 12px 12px; color: var(--text-muted); font-size: 10px; letter-spacing: 1.8px; }
.sidebar nav { display: grid; gap: 4px; }
.sidebar nav a { display: flex; align-items: center; gap: 12px; min-height: 46px; padding: 10px 12px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--text-muted); font-weight: 550; }
.sidebar nav a[aria-current] { border-color: #354466; background: #202c48; color: var(--accent-strong); }
.sidebar nav a:hover { background: var(--surface-raised); text-decoration: none; }
.nav-mark { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; color: currentColor; font-size: 19px; text-align: center; flex-shrink: 0; }
.nav-icon { width: 18px; height: 18px; display: block; }
.sidebar-footer { margin-top: auto; padding: 24px 10px 0; color: var(--text-muted); font-size: 12px; }
.sidebar-footer div { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 8px; }
.sidebar-footer .developer-links { margin-top: 0; }
.sidebar-footer .developer-links summary { min-height: 40px; }
.sidebar-footer a { display: inline-flex; align-items: center; min-height: 44px; }

main { width: 100%; max-width: var(--content-width); min-width: 0; margin: auto; padding: 46px 48px 28px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 36px; }
.page-description { max-width: 720px; margin-bottom: 0; font-size: 16px; }
.eyebrow { margin-bottom: 10px; color: var(--accent); font-size: 10px; font-weight: 650; letter-spacing: 2px; }
.badge { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-raised); padding: 3px 9px; color: var(--text-soft); font-size: 10px; font-weight: 650; letter-spacing: .6px; white-space: normal; overflow-wrap: anywhere; }
.badge-success { color: var(--success); }
.online-indicator { display: inline-block; width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--success); animation: online-pulse 1.8s ease-out infinite; }
.badge-warning { color: var(--warning); }
.badge-danger { color: var(--danger); }
.badges { display: flex; flex-wrap: wrap; gap: 8px; }
@keyframes online-pulse {
  0% { box-shadow: 0 0 0 0 rgba(var(--success-rgb), .55); }
  70%, 100% { box-shadow: 0 0 0 5px rgba(var(--success-rgb), 0); }
}

.card, .provider, .usage-card { min-width: 0; margin-bottom: 24px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); padding: 26px; }
.card-header, .provider-header, .window-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.card-header { border-bottom: 1px solid var(--border); margin-bottom: 24px; padding-bottom: 20px; }
.heading-copy { min-width: 0; }
.heading-copy > :last-child { margin-bottom: 0; }
.provider-header { border-bottom: 1px solid var(--border); margin-bottom: 22px; padding-bottom: 20px; }
.provider-identity { display: flex; align-items: center; gap: 14px; min-width: 0; }
.provider-logo { width: 34px; height: 34px; border-radius: 8px; object-fit: contain; flex-shrink: 0; background: var(--surface-raised); border: 1px solid var(--border); padding: 2px; }
.provider-logo-xs { width: 14px; height: 14px; border-radius: 3px; object-fit: contain; vertical-align: -2px; margin-right: 6px; }
.provider-header h2, .provider-header h3 { margin-bottom: 4px; }
.provider-meta { margin: 0; color: var(--text-muted); font-size: 12px; }
.provider-policy { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-width: 0; margin: -4px 0 22px; border-bottom: 1px solid var(--border); padding: 0 0 18px; }
.provider-policy > div { display: grid; gap: 4px; min-width: 0; }
.provider-policy strong { font-size: 14px; font-weight: 620; }
.provider-policy a { display: inline-flex; align-items: center; min-height: 44px; flex: 0 0 auto; color: var(--accent-strong); font-size: 12px; }
.provider-policy-status { margin: 2px 0 0; color: var(--text-muted); font-size: 12px; }
.provider-policy-families { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 8px; }
.provider-policy-family { display: grid; align-content: start; justify-items: start; gap: 4px; min-width: 0; border-left: 2px solid var(--border-strong); padding-left: 12px; }
.policy-scope-navigation { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 18px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
.section-heading h2 { margin-bottom: 0; }
.section-heading > :first-child > :last-child { margin-bottom: 0; }
.section-count { color: var(--text-muted); font-size: 12px; }

.summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 26px; }
.summary-stat { min-width: 0; border-top: 2px solid var(--border-strong); border-bottom: 1px solid var(--border); padding: 16px 4px 14px; }
.summary-stat strong { display: block; color: var(--text); font-size: 28px; font-weight: 520; font-variant-numeric: tabular-nums; }
.summary-stat span { color: var(--text-muted); font-size: 12px; }
.window-families { display: grid; gap: 24px; }
.window-family { display: grid; gap: 10px; min-width: 0; }
.window-family > h3 { margin: 0; font-size: 14px; }
.window-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 14px; }
.window-card { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); padding: 20px; }
.window-card h3, .window-card h4 { margin-bottom: 4px; }
.window-id { margin-bottom: 18px; color: var(--text-muted); font-size: 11px; overflow-wrap: anywhere; }
.usage-value { font-size: 28px; letter-spacing: -.8px; font-variant-numeric: tabular-nums; }
.usage-value small { color: var(--text-muted); font-size: 12px; letter-spacing: 0; }
.quota-values { display: grid; grid-template-columns: auto 1fr auto auto; align-items: baseline; gap: 4px 8px; margin-top: 16px; }
.quota-values strong { font-size: 24px; font-variant-numeric: tabular-nums; letter-spacing: -.5px; }
.quota-values span { color: var(--text-muted); font-size: 12px; }
.quota-progress { display: block; width: 100%; height: 7px; margin: 16px 0 8px; border: 0; border-radius: 10px; background: var(--surface-raised); accent-color: var(--accent); overflow: hidden; }
progress::-webkit-progress-bar { background: var(--surface-raised); }
progress::-webkit-progress-value { background: var(--accent); }
progress::-moz-progress-bar { background: var(--accent); }
.window-reset { display: grid; gap: 3px; border-top: 1px solid var(--border); margin-top: 18px; padding-top: 14px; }
.window-reset strong { font-size: 14px; font-variant-numeric: tabular-nums; }
.window-reset small { color: var(--text-muted); font-size: 11px; }
.reset-relative { display: block; color: var(--accent); font-size: 13px; }
.manual-start-form { display: grid; justify-items: start; gap: 10px; border-top: 1px solid var(--border); margin-top: 18px; padding-top: 14px; }
.manual-start-form button { min-height: 44px; }
.manual-start-model { margin: 0; color: var(--text-muted); font-size: 12px; }
.manual-start-model strong { color: var(--text-soft); }
.current-window-read { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end; border-bottom: 1px solid var(--border); padding: 18px 0; }
.current-window-read > :last-child { margin-bottom: 0; text-align: right; }
.current-window-status { display: block; margin: 2px 0 6px; color: var(--text); font-size: clamp(20px, 2vw, 26px); font-weight: 600; letter-spacing: -.4px; }
.current-window-status::before { display: inline-block; width: 8px; height: 8px; margin: 0 8px 3px 0; border-radius: 50%; background: var(--accent); content: ''; }
.managed-window-summary, .managed-window-model { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 12px 0 0; }
.managed-window-summary strong { color: var(--text); font-size: 14px; }
.managed-window-model code { color: var(--text-soft); font-size: 12px; }
.policy-fields { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 20px; }
.policy-fields[aria-hidden="true"] { display: none; }
.policy-fields > .field-help { margin-top: 14px; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; clip-path: inset(50%); }
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
.timezone-settings { margin-bottom: 0; }
.timezone-settings .form-actions { margin-top: 18px; }
.timezone-settings [data-timezone-status]:empty { display: none; }
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

fieldset { min-inline-size: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); margin: 0; padding: 14px 16px 16px; }
fieldset > legend { max-width: 100%; margin-left: -4px; padding: 0 5px; color: var(--text-soft); font-size: 13px; font-weight: 650; }
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
.horizon-milestones { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.horizon-milestones li { display: grid; grid-template-columns: minmax(140px, .8fr) minmax(0, 1.2fr); gap: 12px; border-bottom: 1px solid var(--border); padding: 10px 0; }
.horizon-milestones li:last-child { border-bottom: 0; }
.horizon-milestones time { color: var(--text-soft); font-size: 12px; font-variant-numeric: tabular-nums; }
.horizon-milestones span, .horizon-empty { margin: 0; color: var(--text-muted); font-size: 12px; }
.horizon-safety-note { margin: 0; }
details { margin-top: 12px; font-size: 12px; }
summary { display: flex; align-items: center; min-height: 44px; color: var(--text-muted); cursor: pointer; }
pre, code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
pre { max-width: 100%; overflow: auto; border-radius: 6px; background: var(--input); padding: 16px; }
.notice, .alert { margin-bottom: 20px; border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; background: var(--surface-raised); padding: 14px 18px; }
.notice > strong + .muted, .alert > strong + .muted { display: block; margin-top: 4px; }
.stale { border-color: #79603d; }
.stale-notice { color: var(--warning); font-size: 12px; }
.empty-state { border: 1px dashed var(--border-strong); border-radius: var(--radius-md); color: var(--text-muted); padding: 32px; text-align: center; }
.empty-state h2 { color: var(--text); }
dl { display: grid; grid-template-columns: minmax(80px, .7fr) minmax(0, 1.3fr); gap: 10px 16px; }
dt { color: var(--text-muted); font-size: 12px; }
dd { margin: 0; overflow-wrap: anywhere; }

.settings-page, .logs-page, .history-page, .usage-page { display: grid; gap: 24px; }
.settings-stack { display: grid; gap: 16px; }
.retention-list { grid-template-columns: minmax(0, 1fr); gap: 0; margin: 0; }
.retention-list > div { display: grid; grid-template-columns: minmax(180px, .7fr) minmax(0, 1.3fr); gap: 16px; border-bottom: 1px solid var(--border); padding: 11px 0; }
.retention-list > div:last-child { border-bottom: 0; }
.retention-list dt { font-size: 13px; }
.retention-list dd { color: var(--text); font-size: 13px; }
.retention-list dd span { display: block; margin-top: 3px; color: var(--text-muted); font-size: 12px; }
.provider-settings { margin-bottom: 0; }
.provider-settings h3 { margin-bottom: 4px; }
.provider-connection-badge[data-connection-state="connected"] { color: var(--success); }
.provider-connection-badge[data-connection-state="connecting"] { color: var(--accent); }
.provider-connection-badge[data-connection-state="required"] { color: var(--warning); }
.provider-connection-badge .online-indicator { display: none; }
.provider-connection-badge[data-connection-state="connected"] .online-indicator { display: inline-block; }
.provider-auth-area { margin: 18px 0; }
.provider-reconnect { margin: 18px 0; border-top: 1px solid var(--border); padding-top: 14px; }
.provider-reconnect > summary { color: var(--text-muted); font-size: 12px; font-weight: 600; }
.provider-monitoring-note { margin: 18px 0; color: var(--text-muted); }
.provider-settings [hidden] { display: none !important; }
.provider-settings h4 { margin: 24px 0 12px; font-size: 13px; }
.provider-settings dl { margin: 0; }
.provider-settings dd { font-size: 12px; }
.provider-settings small { color: var(--text-muted); }
.provider-settings .capability-details { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 8px; }
.provider-settings .capability-details dl { margin-top: 8px; }
.refresh-interval-field { display: grid; gap: 7px; min-width: 0; }
.refresh-interval-field > label { display: block; }
.refresh-interval-field details { border-top: 1px solid var(--border); margin-top: 2px; padding-top: 4px; }
.refresh-interval-field details[hidden] { display: none; }
.refresh-interval-field details label { margin: 4px 0 7px; }
.refresh-interval-field details input { margin-bottom: 5px; }
.refresh-interval-field details .field-help { margin: 0; }
.schedule-safety { margin: 24px 0 0; }

.history-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(480px, 1.35fr); gap: 24px; align-items: end; margin-bottom: 0; }
.history-toolbar-summary { display: grid; gap: 4px; }
.history-toolbar-summary strong { font-size: 18px; }
.history-toolbar-summary .eyebrow { margin-bottom: 0; }
.history-toolbar-fields { display: grid; grid-template-columns: minmax(130px, 1fr) auto; gap: 12px; align-items: end; min-width: 0; }
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
.field { min-width: 0; }
.field-label { color: var(--text-muted); font-size: 12px; }
.provider-picker { min-width: 0; border: 0; border-radius: 0; margin: 0; padding: 0; }
.provider-picker > legend { margin: 0 0 8px; padding: 0; color: var(--text-muted); font-size: 12px; font-weight: 500; }
.provider-picker-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 138px), 1fr)); gap: 8px; min-width: 0; }
.provider-picker-option { position: relative; display: block; min-width: 0; min-height: 60px; cursor: pointer; }
.provider-picker-option-link { color: inherit; text-decoration: none; }
.provider-picker-input { position: absolute; z-index: 1; top: 50%; left: 16px; width: 1px; height: 1px; min-height: 0; margin: 0; padding: 0; opacity: 0; }
.provider-picker-card { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 60px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); padding: 9px 11px; transition: border-color .15s ease, background-color .15s ease; }
.provider-picker-option:hover .provider-picker-card { border-color: var(--border-strong); background: var(--surface-raised); }
.provider-picker-option.is-selected .provider-picker-card { border-color: var(--accent); background: #202b42; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); }
.provider-picker-input:focus-visible + .provider-picker-card { outline: 2px solid var(--focus); outline-offset: 3px; }
.provider-picker-option-link:focus-visible .provider-picker-card { outline: 2px solid var(--focus); outline-offset: 3px; }
.provider-picker-option.is-unconfigured .provider-picker-card { background: var(--input); color: var(--text-muted); }
.provider-picker-option.is-unconfigured:hover .provider-picker-card { border-color: var(--border-strong); background: #171f2b; }
.provider-picker-option.is-unconfigured.is-selected .provider-picker-card { border-color: var(--accent); background: #1b2432; }
.provider-picker-logo { display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 36px; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-raised); }
.provider-picker-logo img { display: block; width: 34px; height: 34px; object-fit: contain; }
.provider-picker-option.is-unconfigured .provider-picker-logo img { filter: grayscale(1); opacity: .58; }
.provider-picker-fallback { color: var(--accent); font-size: 10px; font-weight: 700; letter-spacing: .4px; }
.provider-picker-option.is-unconfigured .provider-picker-fallback { color: var(--text-muted); }
.provider-picker-copy { display: grid; gap: 2px; min-width: 0; }
.provider-picker-name { color: var(--text); font-size: 13px; font-weight: 620; line-height: 1.25; }
.provider-picker-option.is-unconfigured .provider-picker-name { color: var(--text-muted); }
.provider-picker-status { color: var(--text-muted); font-size: 10px; line-height: 1.3; }
.provider-picker-empty { margin: 0; color: var(--text-muted); font-size: 12px; }
.overview-provider-switcher { max-width: 760px; margin: 0 0 22px; }
.overview-provider-switcher noscript button { min-height: 44px; margin-top: 10px; }
.usage-filter-form > .provider-picker, .history-toolbar-fields > .provider-picker, .schedule-primary-fields > .provider-picker, .schedule-page .provider-picker { grid-column: 1 / -1; }
.history-sections { display: grid; gap: 36px; }
.history-section { min-width: 0; }
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
.page-footer { display: flex; justify-content: space-between; gap: 16px; margin-top: 48px; border-top: 1px solid var(--border); padding-top: 20px; color: var(--text-muted); font-size: 11px; }
.skip-link { position: absolute; z-index: 10; top: -100px; left: 20px; background: var(--surface-raised); padding: 12px; }
.skip-link:focus { top: 12px; }
h1, h2, h3, h4, span { overflow-wrap: anywhere; }

@media (min-width: 1600px) { main { padding: 56px 64px 32px; } }
@media (max-width: 1100px) {
  main { padding: 32px; }
  .schedule-layout, .history-toolbar, .usage-controls { grid-template-columns: 1fr; }
  .policy-choice-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (min-width: 701px) and (max-width: 820px) {
  .policy-choice-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 700px) {
  .app-shell { display: block; }
  .sidebar { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: 16px; }
  .brand { padding: 0; font-size: 13px; }
  .brand-logo { width: 24px; height: 24px; }
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
  .provider-policy { align-items: flex-start; gap: 12px; }
  .provider-policy-families { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .summary-grid { gap: 12px; }
  .summary-stat { padding: 12px 0; }
  .summary-stat strong { font-size: 23px; }
  .summary-stat span { font-size: 10px; }
  .form-grid, .history-toolbar-fields, .usage-filter-form { grid-template-columns: 1fr; }
  .policy-controls-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .policy-choice-grid { grid-template-columns: minmax(0, 1fr); }
  .policy-choice { min-height: 76px; }
  .form-actions button, .history-toolbar-fields button { width: 100%; }
  .dynamic-list-item { grid-template-columns: 1fr; }
  .time-chip { display: inline-flex; width: fit-content; grid-template-columns: none; }
  .time-chip .dynamic-list-remove { width: auto; }
  .active-period-item { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .active-period-item .dynamic-list-remove { grid-column: 1 / -1; width: 100%; }
  .dynamic-list-remove, .dynamic-list-add { width: 100%; }
  .dynamic-list-actions { width: 100%; }
  .schedule-presets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .schedule-presets .button { width: 100%; }
  .current-window-read { grid-template-columns: 1fr; gap: 14px; }
  .current-window-read > :last-child { text-align: left; }
  .settings-page .section-heading { align-items: flex-start; flex-direction: column; gap: 6px; }
  .retention-list > div { grid-template-columns: 1fr; gap: 4px; }
  .upcoming-list li { grid-template-columns: 1fr; gap: 4px; }
  .horizon-axis { font-size: 9px; }
  .horizon-milestones li { grid-template-columns: 1fr; gap: 3px; }
  .window-card { padding: 16px; }
  .manual-start-form button { width: 100%; }
  .chart-card { padding: 16px; }
  .chart-card-header { display: block; }
  .chart-card-controls { display: grid; grid-template-columns: minmax(0, 1fr); justify-content: stretch; gap: 12px; margin-top: 12px; }
  .chart-range-form, .chart-range-control, .chart-range-control select { width: 100%; }
  .chart-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 12px; text-align: left; }
  .chart-plot { min-height: 205px; margin: 10px -4px 0 -8px; }
  .chart-svg { height: 205px; }
  .chart-axis-label, .chart-axis-time { font-size: 18px; }
  .history-section .section-heading { align-items: flex-start; flex-direction: column; gap: 6px; }
  .usage-controls, .usage-calendar-section, .usage-day-detail { padding: 16px; }
  .usage-calendar-section .section-heading { align-items: flex-start; }
  .usage-calendar-section .section-heading > :last-child { text-align: left; }
  .usage-calendar-layout { grid-template-columns: 32px minmax(0, 1fr); gap: 6px; }
  .usage-calendar { gap: 4px; }
  .usage-calendar-row { gap: 4px; }
  .usage-calendar-months { gap: 4px; }
  .usage-cell, .usage-cell-spacer { width: 13px; height: 13px; }
  .usage-day-list ol { grid-template-columns: 1fr; }
  .history-pagination { align-items: flex-start; flex-direction: column; }
  .history-pagination-actions, .history-pagination-actions .button { width: 100%; }
  .history-pagination-actions .button { flex: 1; }
  .provider-settings dl { grid-template-columns: 1fr; }
  .page-footer { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}
`;
