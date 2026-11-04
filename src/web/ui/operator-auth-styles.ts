/** Scoped styles for the standalone operator login and logout pages. */
export const OPERATOR_AUTH_CSS = `
.operator-auth-body { min-height: 100vh; background: var(--bg); }
.operator-auth-layout {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: clamp(18px, 5vw, 52px);
}
.operator-auth-main { width: min(100%, 400px); }
.operator-auth-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 0 0 var(--space-5);
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
}
.operator-auth-brand img { width: 28px; height: 28px; flex: 0 0 auto; border-radius: 6px; object-fit: contain; }
.operator-auth-panel {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: clamp(22px, 6vw, 32px);
}
.operator-auth-eyebrow {
  margin: 0 0 var(--space-2);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
}
.operator-auth-panel h1 {
  margin-bottom: 6px;
  font-size: 22px;
  letter-spacing: -.01em;
}
.operator-auth-copy { margin: 0 0 var(--space-5); color: var(--text-muted); }
.operator-auth-error {
  border-left: 3px solid var(--danger);
  border-radius: var(--radius-sm);
  margin: 0 0 var(--space-4);
  background: var(--danger-soft);
  padding: 10px 12px;
  color: var(--text);
}
.operator-auth-error[hidden] { display: none; }
.operator-auth-form { display: grid; gap: var(--space-4); }
.operator-auth-form label { gap: 6px; color: var(--text-soft); font-size: 13px; }
.operator-auth-form input:not([type="hidden"]) { min-height: 48px; font-size: 16px; }
.operator-auth-form input:focus-visible,
.operator-auth-form button:focus-visible,
.operator-auth-form a:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
.operator-auth-form input:not([type="hidden"]):focus-visible { outline-offset: 0; }
.operator-auth-submit { width: 100%; min-height: 48px; margin-top: 2px; }
.operator-auth-form--logout { gap: var(--space-2); }
.operator-auth-cancel { width: 100%; min-height: 48px; }
@media (max-width: 480px) {
  .operator-auth-layout { align-items: start; padding: 28px 16px; }
  .operator-auth-brand { margin-bottom: var(--space-4); }
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
