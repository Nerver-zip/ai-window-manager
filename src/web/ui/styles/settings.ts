/** Settings page: sectioned document with a local nav, provider panels, client updates and retention. */
export const SETTINGS_CSS = `
.settings-page { display: grid; gap: var(--space-5); }
.settings-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-6); align-items: start; }
.settings-nav { display: none; }
.settings-sections { display: grid; gap: var(--space-7); min-width: 0; }
.settings-section { min-width: 0; scroll-margin-top: var(--space-5); }
.settings-section > .heading-copy, .settings-section > .section-heading { margin-bottom: var(--space-4); }
.settings-section h2 { margin-bottom: 4px; }
.settings-section .heading-copy > p { margin: 0; }
.timezone-settings .timezone-row { display: grid; grid-template-columns: minmax(0, 420px) auto; gap: var(--space-4); align-items: start; }
.timezone-settings .timezone-row .form-actions { margin-top: 22px; }
.timezone-settings [data-timezone-status]:empty { display: none; }
.timezone-settings [data-timezone-status] { margin: var(--space-3) 0 0; }
.settings-stack { display: grid; gap: var(--space-5); }
.retention-list { grid-template-columns: minmax(0, 1fr); gap: 0; margin: 0; }
.retention-list > div { display: grid; grid-template-columns: minmax(180px, .6fr) minmax(0, 1.4fr); gap: var(--space-4); border-top: 1px solid var(--line); padding: var(--space-3) 0; }
.retention-list > div:last-child { border-bottom: 1px solid var(--line); }
.retention-list dt { color: var(--text-muted); font-size: 13px; }
.retention-list dd { color: var(--text); font-size: 14px; }
.retention-list dd span { display: block; margin-top: 2px; color: var(--text-muted); font-size: 13px; }

/* Provider panel */
.provider-settings { margin-bottom: 0; }
.provider-settings > * + * { margin-top: var(--space-5); }
.provider-settings .provider-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.provider-settings .provider-identity { gap: var(--space-3); }
.provider-settings .provider-logo, .provider-settings .provider-logo--claude-code { width: 28px; height: 28px; }
.provider-settings h3 { margin: 0; font-size: 16px; }
.provider-connection-badge { gap: 8px; color: var(--text-soft); font-size: 13px; font-weight: 500; white-space: nowrap; }
.provider-connection-badge[data-connection-state="connected"] { color: var(--text-soft); }
.provider-connection-badge[data-connection-state="connecting"] { color: var(--accent-strong); }
.provider-connection-badge[data-connection-state="required"] { color: var(--warn); }
.provider-connection-badge .online-indicator { display: none; }
.provider-connection-badge[data-connection-state="connected"] .online-indicator { display: inline-block; }
.provider-connection-badge:not([data-connection-state="connected"])::before { content: ''; flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.provider-auth-area, .provider-reconnect, .provider-monitoring-note, .provider-settings > form[data-provider-settings-form], .provider-client-updates, .provider-settings .capability-details { border-top: 1px solid var(--line); padding-top: var(--space-4); }
.provider-monitoring-note { margin-bottom: 0; color: var(--text-muted); }
.provider-reconnect > summary { min-height: 32px; }
.provider-settings [hidden] { display: none !important; }
.provider-settings fieldset > legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.provider-settings .form-grid { grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: var(--space-4) var(--space-5); align-items: start; }
.provider-settings .form-actions { margin-top: var(--space-4); }
.provider-settings dl { margin: 0; }
.provider-settings dd { font-size: 13px; }
.provider-settings small { color: var(--text-muted); font-size: 13px; }
.provider-settings .capability-details { margin-top: var(--space-4); }
.provider-settings .capability-details dl { grid-template-columns: minmax(120px, 200px) minmax(0, 1fr); }

/* Provider app versions */
.provider-client-updates h4 { margin: 0 0 4px; font-size: 14px; }
.provider-client-updates .field-help { margin: 0 0 var(--space-2); }
.provider-client-versions { display: flex; flex-wrap: wrap; grid-template-columns: none; gap: var(--space-1) var(--space-6); margin: var(--space-3) 0; }
.provider-client-versions > div { display: flex; align-items: baseline; gap: var(--space-2); }
.provider-client-versions dt { color: var(--text-muted); font-size: 13px; }
.provider-client-versions dd { color: var(--text); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.provider-client-update-status { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--space-2); margin: 0 0 var(--space-2); color: var(--text); font-size: 13px; }
.provider-client-update-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: var(--space-3) 0 0; }
.provider-client-update-actions form { margin: 0; }
.provider-client-update-actions .button { min-height: 34px; padding: 4px 14px; font-size: 13px; white-space: nowrap; }
.provider-client-auto-update { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); margin-top: var(--space-3) !important; }
.provider-client-auto-update .field-help { flex: 1 1 100%; margin: 0; order: 3; }
.provider-client-auto-update .form-actions { margin: 0; }
.provider-client-auto-update .form-actions button { min-height: 32px; padding: 4px 12px; font-size: 13px; }
.refresh-interval-field { display: grid; gap: 6px; min-width: 0; }
.refresh-interval-field > label { display: block; }
.refresh-interval-field .field-help { margin: 0; }
.refresh-interval-field details { margin-top: 2px; }
.refresh-interval-field details[hidden] { display: none; }
.refresh-interval-field details label { margin: 4px 0 6px; }
.refresh-interval-field details input { margin-bottom: 6px; }

@media (min-width: 1100px) {
  .settings-layout { grid-template-columns: 168px minmax(0, 1fr); gap: var(--space-7); }
  .settings-nav { position: sticky; top: var(--space-5); display: grid; gap: 2px; }
  .settings-nav a { border-left: 2px solid var(--line); padding: 6px var(--space-3); color: var(--text-muted); font-size: 13px; font-weight: 500; }
  .settings-nav a:hover { border-left-color: var(--accent); color: var(--text); text-decoration: none; }
}
@media (max-width: 700px) {
  .settings-page .section-heading { align-items: flex-start; flex-direction: column; gap: 6px; }
  .timezone-settings .timezone-row { grid-template-columns: minmax(0, 1fr); }
  .provider-client-update-actions { flex-direction: column; align-items: stretch; }
  .provider-client-update-actions form, .provider-client-update-actions .button { width: 100%; }
  .provider-client-versions { flex-direction: column; }
  .retention-list > div { grid-template-columns: 1fr; gap: 4px; }
  .provider-settings dl, .provider-settings .capability-details dl { grid-template-columns: 1fr; }
  .provider-settings .provider-header { align-items: flex-start; }
}
`;
