/** Scoped styles for the provider-auth onboarding panel. */
export const AUTH_ONBOARDING_CSS = `
.auth-onboarding {
  min-width: 0;
  margin: 0;
}
.auth-onboarding__body { display: grid; gap: 12px; }
.auth-onboarding__intro { margin: 0; color: var(--text); font-size: 14px; font-weight: 550; }
.auth-onboarding__detail,
.auth-onboarding__expiry,
.auth-onboarding__error,
.auth-onboarding__code-hint,
.auth-onboarding__next-step p { margin: 0; color: var(--text-muted); }
.auth-onboarding__error {
  border-left: 2px solid var(--danger);
  padding: 8px 12px;
  color: var(--danger);
}
.auth-onboarding__expiry time { color: var(--text-soft); font-variant-numeric: tabular-nums; }
.auth-onboarding__actions { display: flex; flex-wrap: wrap; gap: 10px; }
.auth-onboarding__awaiting {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  border-top: 1px solid var(--border);
  padding-top: 18px;
}
.auth-onboarding__next-step,
.auth-onboarding__code { display: grid; align-content: start; gap: 8px; min-width: 0; }
.auth-onboarding__next-step .button { justify-self: start; margin-top: 6px; }
.auth-onboarding__link-actions,
.auth-onboarding__code-copy-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.auth-onboarding__code-row { display: flex; align-items: stretch; gap: 8px; }
.auth-onboarding__code-row input { min-width: 0; flex: 1 1 auto; }
.auth-onboarding__user-code {
  width: fit-content;
  margin: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--input);
  padding: 8px 12px;
  color: var(--accent-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 16px;
  letter-spacing: .12em;
}
.auth-copy-button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface-raised);
  padding: 8px 13px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.auth-copy-button:hover { border-color: var(--accent); background: var(--input); }
.auth-copy-button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.auth-copy-button svg { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.auth-onboarding__copy-status { min-height: 1em; margin: 0; color: var(--text-muted); font-size: 12px; }
.auth-onboarding__noscript { margin: 0; color: var(--warning); font-size: 12px; }
.auth-onboarding [hidden] { display: none !important; }
@media (max-width: 700px) {
  .auth-onboarding__awaiting { grid-template-columns: 1fr; }
  .auth-onboarding__code-row { display: grid; grid-template-columns: 1fr; }
  .auth-onboarding__code-row .button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .auth-onboarding * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`;
