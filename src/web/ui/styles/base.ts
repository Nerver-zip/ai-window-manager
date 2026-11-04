/** Design tokens, reset, typography and shared controls ("quiet operations console"). */
export const BASE_CSS = `
:root {
  color-scheme: dark;
  --bg: #0b0f17;
  --surface: #0f1522;
  --surface-raised: #151d2d;
  --input: #0a0f19;
  --line: #1c2638;
  --line-strong: #2c384d;
  --text: #eef2f7;
  --text-soft: #c6cfdc;
  --text-muted: #93a1b5;
  --text-faint: #66748a;
  --accent: #5cc8e4;
  --accent-strong: #93dcf0;
  --accent-soft: rgba(92, 200, 228, .12);
  --on-accent: #06222b;
  --ok: #5fd39a;
  --ok-soft: rgba(95, 211, 154, .12);
  --warn: #f0b955;
  --warn-soft: rgba(240, 185, 85, .12);
  --danger: #f2777a;
  --danger-soft: rgba(242, 119, 122, .12);
  --unknown: #93a1b5;
  --unknown-soft: rgba(147, 161, 181, .12);
  --chart-1: #5cc8e4;
  --chart-2: #8b9cf7;
  --chart-3: #f0b955;
  --chart-4: #e98fbf;
  --chart-5: #7fd18a;
  --chart-6: #c3a6f0;
  --chart-grid: #1c2638;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-pill: 999px;
  --content-width: 1180px;
  --sidebar-width: 216px;
  --font-sm: 12px;
  --font-base: 14px;
  --line-height: 1.55;
  --font-ui: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  /* Legacy aliases: page CSS that has not been redesigned yet still resolves these. */
  --sidebar: var(--bg);
  --surface-soft: var(--bg);
  --border: var(--line);
  --border-strong: var(--line-strong);
  --success: var(--ok);
  --success-rgb: 95, 211, 154;
  --warning: var(--warn);
  --focus: var(--accent-strong);
  font-family: var(--font-ui);
  font-size: var(--font-base);
  line-height: var(--line-height);
}

* { box-sizing: border-box; }
html { background: var(--bg); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-strong); text-decoration: underline; }
button, input, select, textarea { font: inherit; }
button, a, input, select, summary { touch-action: manipulation; }
:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
h1, h2, h3, h4, p { margin-top: 0; }
h1 { margin-bottom: 8px; font-size: 26px; font-weight: 600; letter-spacing: -.02em; line-height: 1.2; }
h2 { margin-bottom: 8px; font-size: 18px; font-weight: 600; letter-spacing: -.01em; line-height: 1.3; }
h3 { margin-bottom: 4px; font-size: 16px; font-weight: 600; line-height: 1.35; }
h4 { font-size: 14px; font-weight: 600; }
p { margin-bottom: var(--space-4); }
small, .muted, .page-description, .chart-legend { color: var(--text-muted); }
.unknown { color: var(--unknown); }
.warning { color: var(--warn); }
.tabular, time, output { font-variant-numeric: tabular-nums; }
h1, h2, h3, h4, span { overflow-wrap: anywhere; }
.eyebrow { margin-bottom: 4px; color: var(--text-muted); font-size: 12px; font-weight: 500; }

/* Layout utilities */
.stack { display: grid; gap: var(--space-4); }
.cluster { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.row-list { display: grid; margin: 0; padding: 0; list-style: none; }
.row-list > * { border-top: 1px solid var(--line); padding: var(--space-3) 0; }
.row-list > :first-child { border-top: 0; padding-top: 0; }
.section-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2) var(--space-5); margin-bottom: var(--space-4); }
.section-heading h2 { margin-bottom: 0; }
.section-heading > :first-child > :last-child { margin-bottom: 0; }
.section-count { color: var(--text-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.badges { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }

/* Surfaces: content sits on the canvas; .panel is the single permitted container level. */
.panel, .card, .provider, .usage-card { min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); padding: var(--space-5); }
.card, .provider, .usage-card { margin-bottom: var(--space-5); }
.card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); border-bottom: 1px solid var(--line); margin-bottom: var(--space-5); padding-bottom: var(--space-4); }
.heading-copy { min-width: 0; }
.heading-copy > :last-child { margin-bottom: 0; }

/* Status: a quiet dot plus text instead of pill badges. */
.status { --status-color: var(--unknown); display: inline-flex; align-items: center; gap: 8px; color: var(--text-soft); font-size: 13px; }
.status::before { content: ''; flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--status-color); }
.status-ok { --status-color: var(--ok); }
.status-warn { --status-color: var(--warn); }
.status-danger { --status-color: var(--danger); }
.status-info { --status-color: var(--accent); }
.status-muted { --status-color: var(--text-faint); }
.badge { display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; padding: 0; color: var(--text-soft); font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
.badge-success { color: var(--ok); }
.badge-warning { color: var(--warn); }
.badge-danger { color: var(--danger); }
.badge-success:not(:has(.online-indicator))::before, .badge-warning::before, .badge-danger::before { content: ''; flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.online-indicator { display: inline-block; width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--ok); animation: online-pulse 1.8s ease-out infinite; }
@keyframes online-pulse {
  0% { box-shadow: 0 0 0 0 rgba(var(--success-rgb), .55); }
  70%, 100% { box-shadow: 0 0 0 5px rgba(var(--success-rgb), 0); }
}

/* Meter: a 6px track; the value is always rendered as text beside it, never inside. */
progress { appearance: none; -webkit-appearance: none; display: block; height: 6px; border: 0; border-radius: var(--radius-pill); background: var(--surface-raised); accent-color: var(--meter-color, var(--accent)); overflow: hidden; }
progress::-webkit-progress-bar { background: var(--surface-raised); border-radius: var(--radius-pill); }
progress::-webkit-progress-value { background: var(--meter-color, var(--accent)); border-radius: var(--radius-pill); }
progress::-moz-progress-bar { background: var(--meter-color, var(--accent)); border-radius: var(--radius-pill); }
.meter { width: 100%; }
.meter.is-high { --meter-color: var(--warn); }
.meter.is-full { --meter-color: var(--danger); }

/* Forms */
fieldset { min-inline-size: 0; border: 0; margin: 0; padding: 0; }
fieldset > legend { max-width: 100%; margin: 0 0 var(--space-2); padding: 0; color: var(--text-soft); font-size: 13px; font-weight: 500; }
form { min-width: 0; }
label { display: grid; gap: 6px; color: var(--text-soft); font-size: 13px; font-weight: 500; }
input:not([type="checkbox"]):not([type="radio"]), select, textarea { display: block; width: 100%; min-width: 0; min-height: 38px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--input); color: var(--text); padding: 7px 12px; transition: border-color .12s ease, box-shadow .12s ease; }
textarea { min-height: 96px; }
input:not([type="checkbox"]):not([type="radio"]):hover, select:hover, textarea:hover { border-color: var(--text-faint); }
input:not([type="checkbox"]):not([type="radio"]):focus, select:focus, textarea:focus { border-color: var(--accent); outline: 0; box-shadow: 0 0 0 3px var(--accent-soft); }
input:not([type="checkbox"]):not([type="radio"]):focus-visible, select:focus-visible, textarea:focus-visible { outline: 0; }
input:disabled, select:disabled, textarea:disabled { opacity: .5; cursor: not-allowed; }
input[type="checkbox"], input[type="radio"] { width: 18px; height: 18px; min-height: auto; margin: 0; accent-color: var(--accent); cursor: pointer; }
.checkbox-label { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 400; cursor: pointer; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); }
.form-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-5); }
.field { min-width: 0; }
.field-label { color: var(--text-soft); font-size: 13px; font-weight: 500; }
.field-help, .help-text { color: var(--text-muted); font-size: 13px; font-weight: 400; }

/* Buttons: an unvariant button is the primary action (existing markup relies on this). */
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: fit-content; min-height: 36px; border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--accent); color: var(--on-accent); padding: 6px 16px; font-size: 14px; font-weight: 500; line-height: 1.3; cursor: pointer; transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
button:hover, .button:hover { border-color: var(--accent-strong); background: var(--accent-strong); color: var(--on-accent); text-decoration: none; }
button:disabled, .button:disabled { opacity: .5; cursor: not-allowed; }
.button.is-disabled { opacity: .5; cursor: not-allowed; pointer-events: none; }
.button-primary { white-space: nowrap; }
.button-secondary { border-color: var(--line-strong); background: var(--surface-raised); color: var(--text); }
.button-secondary:hover { border-color: var(--text-faint); background: var(--surface-raised); color: var(--text); }
.button-ghost { border-color: transparent; background: transparent; color: var(--accent); }
.button-ghost:hover { border-color: transparent; background: var(--accent-soft); color: var(--accent-strong); }
.button-danger { border-color: transparent; background: var(--danger-soft); color: var(--danger); }
.button-danger:hover { border-color: var(--danger); background: var(--danger-soft); color: var(--danger); }

/* Segmented control: works for links (aria-current) and labels wrapping radios. */
.segmented { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); padding: 3px; overflow-x: auto; }
.segmented > a, .segmented > label { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; border: 1px solid transparent; border-radius: 4px; padding: 0 12px; color: var(--text-muted); font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: background-color .12s ease, color .12s ease, border-color .12s ease; }
.segmented > a:hover, .segmented > label:hover { color: var(--text); text-decoration: none; }
.segmented > a[aria-current], .segmented > label:has(input:checked) { border-color: var(--line-strong); background: var(--surface-raised); color: var(--text); }
.segmented > label input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.segmented > label:has(input:focus-visible) { outline: 2px solid var(--accent-strong); outline-offset: 2px; }

/* Notices */
.notice, .alert { --notice-color: var(--accent); margin-bottom: var(--space-4); border: 0; border-left: 3px solid var(--notice-color); border-radius: var(--radius-sm); background: var(--accent-soft); padding: var(--space-3) var(--space-4); color: var(--text-soft); }
.notice-info { --notice-color: var(--accent); background: var(--accent-soft); }
.notice-success { --notice-color: var(--ok); background: var(--ok-soft); }
.notice-warning { --notice-color: var(--warn); background: var(--warn-soft); }
.notice-danger { --notice-color: var(--danger); background: var(--danger-soft); }
.notice > :last-child, .alert > :last-child { margin-bottom: 0; }
.notice > strong, .alert > strong { color: var(--text); font-weight: 600; }
.notice > strong + .muted, .alert > strong + .muted { display: block; margin-top: 4px; }
.stale { border-color: var(--warn); }
.stale-notice { color: var(--warn); font-size: 13px; }
.awm-interaction-error { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); border-left: 3px solid var(--warn); border-radius: var(--radius-sm); background: var(--warn-soft); padding: var(--space-3) var(--space-4); }
.awm-interaction-error p { margin: 0; color: var(--text-soft); }
.awm-interaction-error .button { flex: 0 0 auto; }

/* Disclosure */
summary { display: flex; align-items: center; gap: 8px; min-height: 36px; color: var(--text-muted); font-size: 13px; font-weight: 500; list-style: none; cursor: pointer; transition: color .12s ease; }
summary::-webkit-details-marker { display: none; }
summary::before { content: ''; flex: 0 0 auto; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform .12s ease; }
details[open] > summary::before { transform: rotate(45deg); }
summary:hover { color: var(--text); }
details { font-size: 13px; }
details > summary + * { margin-top: var(--space-3); }

.empty-state { padding: var(--space-5) 0; color: var(--text-muted); font-size: 14px; }
.empty-state h2, .empty-state h3 { color: var(--text); }
.empty-state > :last-child { margin-bottom: 0; }

pre, code { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
pre { max-width: 100%; overflow: auto; border-radius: var(--radius-sm); background: var(--input); padding: var(--space-4); }
dl { display: grid; grid-template-columns: minmax(80px, .7fr) minmax(0, 1.3fr); gap: 10px 16px; }
dt { color: var(--text-muted); font-size: 13px; }
dd { margin: 0; overflow-wrap: anywhere; }

.visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; clip-path: inset(50%); }
.awm-is-loading, [aria-busy="true"] { opacity: .6; cursor: progress; transition: opacity .14s ease; }

@media (max-width: 700px) {
  .panel, .card, .provider, .usage-card { padding: var(--space-4); }
  .card-header { display: block; }
  .card-header > :last-child { margin-top: var(--space-3); }
  .form-grid { grid-template-columns: 1fr; }
  .form-actions button { width: 100%; }
  .awm-interaction-error { align-items: flex-start; flex-direction: column; gap: 10px; }
}
@media (pointer: coarse) {
  button, .button, input:not([type="checkbox"]):not([type="radio"]), select, summary { min-height: 44px; }
  .segmented > a, .segmented > label { min-height: 40px; }
  .checkbox-label { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}
`;
