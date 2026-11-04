/** Overview page: provider heading, attention area, window rows and start policies. */
export const OVERVIEW_CSS = `
.overview-provider-switcher { margin: 0 0 var(--space-5); }
.overview-provider-switcher noscript button { min-height: 44px; margin-top: 10px; }
article.provider { display: grid; gap: var(--space-6); border: 0; border-radius: 0; background: none; margin: 0; padding: 0; }
.provider-header { margin: 0; }
.provider-identity { display: flex; align-items: center; gap: var(--space-4); min-width: 0; }
.provider-logo { width: 34px; height: 34px; border-radius: 8px; object-fit: contain; flex-shrink: 0; }
.provider-logo--claude-code { width: 40px; height: 40px; }
.provider-logo-xs { width: 14px; height: 14px; border-radius: 3px; object-fit: contain; vertical-align: -2px; margin-right: 6px; }
.provider-logo-xs--claude-code { width: 16px; height: 16px; border-radius: 0; vertical-align: -3px; margin-right: 5px; }
.provider-header h2 { margin-bottom: 4px; font-size: 20px; }
.provider-meta { margin: 0; color: var(--text-muted); font-size: 13px; }
.provider-statusline { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--space-2); }
.provider-statusline .status { color: var(--text-soft); }
.provider-status-separator { color: var(--text-faint); }
.has-live-dot::before { display: none; }
.has-live-dot { gap: 8px; }
.provider-attention { display: grid; gap: var(--space-3); }
.provider-attention > * { margin: 0; }
.provider-attention .stale-notice { color: var(--text-soft); font-size: 14px; }
.provider-onboarding { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3) var(--space-4); }
.provider-onboarding p { margin: 0; }
.pending-intent h3 { margin-bottom: var(--space-3); color: var(--text); }
.pending-intent form { margin-top: var(--space-3); }
.pending-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3) var(--space-4); margin: 0 0 var(--space-3); }
.pending-facts > div { min-width: 0; }
.pending-facts dt { color: var(--text-muted); font-size: 12px; }
.pending-facts dd { color: var(--text); font-size: 14px; font-variant-numeric: tabular-nums; }
.provider-section-title { margin-bottom: var(--space-3); font-size: 16px; }
.provider-windows, .provider-policy { min-width: 0; }
.window-families { display: grid; gap: var(--space-6); }
.window-family { min-width: 0; }
.window-family > h4 { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: 13px; font-weight: 600; }
.window-rows { border-top: 1px solid var(--line); }
.window-rows > .window-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(200px, 1.3fr) minmax(190px, 1.1fr) 210px; align-items: center; gap: var(--space-3) var(--space-5); min-width: 0; border-top: 0; border-bottom: 1px solid var(--line); padding: var(--space-4) 0; }
.window-rows > .window-row:first-child { padding-top: var(--space-4); }
.window-title { display: grid; gap: 2px; min-width: 0; }
.window-title h4, .window-title h5 { margin: 0; font-size: 15px; }
.window-title .status { font-size: 12px; color: var(--text-muted); }
.window-usage { display: grid; gap: var(--space-2); min-width: 0; }
.window-usage p { margin: 0; }
.window-figures { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-2); color: var(--text-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.window-percent { color: var(--text); font-size: 28px; font-weight: 600; letter-spacing: -.02em; line-height: 1.1; }
.window-left { margin-left: var(--space-2); color: var(--text-soft); font-weight: 500; }
.window-reset { display: grid; gap: 1px; min-width: 0; }
.window-reset .field-label { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.window-reset strong { color: var(--text); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.reset-relative { display: block; color: var(--accent); font-size: 13px; font-variant-numeric: tabular-nums; }
.window-reset small { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.window-action { min-width: 0; }
.manual-start-form { display: grid; justify-items: stretch; gap: var(--space-2); }
.manual-start-model { margin: 0; color: var(--text-muted); font-size: 12px; }
.manual-start-model strong { color: var(--text-soft); font-weight: 500; }
.policy-list > .policy-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); min-width: 0; padding: var(--space-3) 0; }
.policy-list { border-top: 1px solid var(--line); }
.policy-list > .policy-row:first-child { padding-top: var(--space-3); }
.policy-list > .policy-row { border-bottom: 1px solid var(--line); border-top: 0; }
.policy-copy { display: grid; gap: 2px; min-width: 0; }
.policy-copy strong { color: var(--text); font-size: 14px; font-weight: 600; }
.policy-copy p { margin: 0; }
.provider-policy-status { color: var(--text-muted); font-size: 13px; }
.policy-row > a { flex: 0 0 auto; }
.provider-details { margin-top: calc(var(--space-3) * -1); }
.provider-details dl { max-width: 520px; margin: 0; }

@media (max-width: 1100px) {
  .window-rows > .window-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .window-title, .window-action { grid-column: 1 / -1; }
}
@media (max-width: 700px) {
  article.provider { gap: var(--space-5); }
  .window-rows > .window-row { grid-template-columns: minmax(0, 1fr); gap: var(--space-3); }
  .manual-start-form button { width: 100%; }
  .manual-start-form { justify-items: stretch; }
  .policy-list > .policy-row { flex-direction: column; gap: var(--space-2); }
  .policy-row > a { padding-left: 0; }
}
`;
