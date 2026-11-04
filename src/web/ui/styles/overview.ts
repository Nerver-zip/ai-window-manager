/** Overview page: provider cards, windows, quota and manual start. */
export const OVERVIEW_CSS = `
.card-header, .provider-header, .window-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.provider-header { border-bottom: 1px solid var(--border); margin-bottom: 22px; padding-bottom: 20px; }
.provider-identity { display: flex; align-items: center; gap: 14px; min-width: 0; }
.provider-logo { width: 34px; height: 34px; border-radius: 8px; object-fit: contain; flex-shrink: 0; background: var(--surface-raised); border: 1px solid var(--border); padding: 2px; }
.provider-logo--claude-code { width: 40px; height: 40px; border: 0; padding: 0; background: transparent; }
.provider-logo-xs { width: 14px; height: 14px; border-radius: 3px; object-fit: contain; vertical-align: -2px; margin-right: 6px; }
.provider-logo-xs--claude-code { width: 16px; height: 16px; border-radius: 0; vertical-align: -3px; margin-right: 5px; }
.provider-header h2, .provider-header h3 { margin-bottom: 4px; }
.provider-meta { margin: 0; color: var(--text-muted); font-size: 12px; }
.provider-policy { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-width: 0; margin: -4px 0 22px; border-bottom: 1px solid var(--border); padding: 0 0 18px; }
.provider-onboarding-cta + .provider-policy { margin-top: 18px; }
.provider-policy > div { display: grid; gap: 4px; min-width: 0; }
.provider-policy strong { font-size: 14px; font-weight: 620; }
.provider-policy a { display: inline-flex; align-items: center; min-height: 44px; flex: 0 0 auto; color: var(--accent-strong); font-size: 12px; }
.provider-policy-status { margin: 2px 0 0; color: var(--text-muted); font-size: 12px; }
.provider-policy-families { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 8px; }
.provider-policy-family { display: grid; align-content: start; justify-items: start; gap: 4px; min-width: 0; border-left: 2px solid var(--border-strong); padding-left: 12px; }
.policy-scope-navigation { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 18px; }
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
.overview-provider-switcher { max-width: 760px; margin: 0 0 22px; }
.overview-provider-switcher noscript button { min-height: 44px; margin-top: 10px; }

@media (max-width: 700px) {
  .card-header, .provider-header { display: block; }
  .card-header > :last-child, .provider-header > :last-child { margin-top: 14px; }
  .provider-policy { align-items: flex-start; gap: 12px; }
  .provider-policy-families { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .summary-grid { gap: 12px; }
  .summary-stat { padding: 12px 0; }
  .summary-stat strong { font-size: 23px; }
  .summary-stat span { font-size: 10px; }
  .current-window-read { grid-template-columns: 1fr; gap: 14px; }
  .current-window-read > :last-child { text-align: left; }
  .window-card { padding: 16px; }
  .manual-start-form button { width: 100%; }
}
`;
