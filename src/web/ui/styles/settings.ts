/** Settings page: provider settings, retention, client updates and timezone. */
export const SETTINGS_CSS = `
.settings-page { display: grid; gap: 24px; }
.timezone-settings { margin-bottom: 0; }
.timezone-settings .form-actions { margin-top: 18px; }
.timezone-settings [data-timezone-status]:empty { display: none; }
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
.provider-client-updates { border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); padding: 18px 20px; margin-top: 24px; }
.provider-client-updates h4 { margin: 0 0 4px; font-size: 14px; font-weight: 650; }
.provider-client-updates .field-help { margin-top: 0; }
.provider-client-versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 14px 0; }
.provider-client-versions > div { display: grid; gap: 3px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
.provider-client-versions dt { color: var(--text-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; }
.provider-client-versions dd { color: var(--text); font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
.provider-client-update-status { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); font-size: 13px; margin: 10px 0; }
.provider-client-update-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 14px 0 16px; }
.provider-client-update-actions form { margin: 0; }
.provider-client-update-actions .button { min-height: 40px; padding: 8px 14px; font-size: 12px; white-space: nowrap; }
.provider-client-auto-update { border-top: 1px solid var(--border); padding-top: 14px; margin-top: 14px; }
.provider-client-auto-update .form-actions { margin-top: 10px; }
.provider-client-auto-update .form-actions button { min-height: 38px; padding: 6px 12px; font-size: 12px; }
.refresh-interval-field { display: grid; gap: 7px; min-width: 0; }
.refresh-interval-field > label { display: block; }
.refresh-interval-field details { border-top: 1px solid var(--border); margin-top: 2px; padding-top: 4px; }
.refresh-interval-field details[hidden] { display: none; }
.refresh-interval-field details label { margin: 4px 0 7px; }
.refresh-interval-field details input { margin-bottom: 5px; }
.refresh-interval-field details .field-help { margin: 0; }

@media (max-width: 700px) {
  .settings-page .section-heading { align-items: flex-start; flex-direction: column; gap: 6px; }
  .provider-client-update-actions { flex-direction: column; align-items: stretch; }
  .provider-client-update-actions form, .provider-client-update-actions .button { width: 100%; }
  .retention-list > div { grid-template-columns: 1fr; gap: 4px; }
  .provider-settings dl { grid-template-columns: 1fr; }
}
`;
