/** Scoped styles for the provider-auth onboarding panel. */
export const AUTH_ONBOARDING_CSS = `
.auth-onboarding {
  min-width: 0;
  margin-bottom: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 24px;
}
.auth-onboarding__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 18px;
}
.auth-onboarding__header h2 { margin-bottom: 6px; }
.auth-onboarding__intro { max-width: 680px; margin-bottom: 0; color: var(--text-muted); }
.auth-onboarding__status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  flex: 0 0 auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  padding: 5px 10px;
  color: var(--text-soft);
  font-size: 12px;
  font-weight: 650;
}
.auth-onboarding__status[data-auth-state="SUCCEEDED"] { color: var(--success); }
.auth-onboarding__status[data-auth-state="FAILED"],
.auth-onboarding__status[data-auth-state="TIMED_OUT"] { color: var(--danger); }
.auth-onboarding__status-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--unknown);
}
.auth-onboarding__status[data-auth-state="SUCCEEDED"] .auth-onboarding__status-dot {
  background: var(--success);
  animation: online-pulse 1.8s ease-out infinite;
}
.auth-onboarding__status[data-auth-state="STARTING"] .auth-onboarding__status-dot,
.auth-onboarding__status[data-auth-state="AWAITING_USER_ACTION"] .auth-onboarding__status-dot,
.auth-onboarding__status[data-auth-state="VERIFYING"] .auth-onboarding__status-dot { background: var(--accent); }
.auth-onboarding__body { display: grid; gap: 16px; padding-top: 20px; }
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
.auth-onboarding__code-row { display: flex; align-items: stretch; gap: 8px; }
.auth-onboarding__code-row input { min-width: 0; flex: 1 1 auto; }
.auth-onboarding__user-code {
  width: fit-content;
  margin: 2px 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--input);
  padding: 8px 12px;
  color: var(--accent-strong);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 16px;
  letter-spacing: .12em;
}
.auth-onboarding__noscript { margin: 0; color: var(--warning); font-size: 12px; }
.auth-onboarding [hidden] { display: none !important; }
@media (max-width: 700px) {
  .auth-onboarding { padding: 18px; }
  .auth-onboarding__header { display: grid; gap: 14px; }
  .auth-onboarding__status { justify-self: start; }
  .auth-onboarding__awaiting { grid-template-columns: 1fr; }
  .auth-onboarding__code-row { display: grid; grid-template-columns: 1fr; }
  .auth-onboarding__code-row .button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .auth-onboarding * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`;
