/** Scoped styles for the standalone operator login and logout pages. */
export const OPERATOR_AUTH_CSS = `
.operator-auth-body { min-height: 100vh; }
.operator-auth-layout {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: clamp(18px, 5vw, 52px);
}
.operator-auth-main { width: min(100%, 440px); }
.operator-auth-brand {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 0 26px 4px;
  color: var(--text);
  font-size: 18px;
  font-weight: 650;
  line-height: 1.3;
}
.operator-auth-brand img { width: 44px; height: 44px; flex: 0 0 auto; object-fit: contain; }
.operator-auth-brand-subtitle {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 3px;
}
.operator-auth-panel {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: clamp(22px, 6vw, 34px);
}
.operator-auth-eyebrow {
  margin: 0 0 10px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 2px;
}
.operator-auth-panel h1 {
  margin-bottom: 8px;
  font-size: clamp(26px, 6vw, 32px);
  letter-spacing: -.8px;
}
.operator-auth-copy { margin: 0 0 24px; color: var(--text-muted); }
.operator-auth-error {
  border-left: 2px solid var(--danger);
  margin: -8px 0 20px;
  background: var(--surface-raised);
  padding: 10px 12px;
  color: var(--text-soft);
}
.operator-auth-error[hidden] { display: none; }
.operator-auth-form { display: grid; gap: 18px; }
.operator-auth-form label { gap: 7px; color: var(--text-soft); font-size: 13px; }
.operator-auth-form input:not([type="hidden"]) { min-height: 48px; font-size: 16px; }
.operator-auth-form input:focus-visible,
.operator-auth-form button:focus-visible,
.operator-auth-form a:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.operator-auth-submit { width: 100%; min-height: 48px; margin-top: 2px; }
.operator-auth-form--logout { gap: 10px; }
.operator-auth-cancel { width: 100%; min-height: 48px; }
@media (max-width: 480px) {
  .operator-auth-layout { align-items: start; padding: 28px 16px; }
  .operator-auth-brand { margin-bottom: 20px; }
  .operator-auth-panel { padding: 22px 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .operator-auth-body *, .operator-auth-body *::before, .operator-auth-body *::after {
    scroll-behavior: auto !important;
    transition: none !important;
    animation: none !important;
  }
}
`;
