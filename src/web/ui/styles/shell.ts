/** Application shell: sidebar, page header and the mobile top bar. */
export const SHELL_CSS = `
.skip-link { position: absolute; z-index: 20; top: -100px; left: 16px; border-radius: var(--radius-sm); background: var(--surface-raised); padding: 10px 14px; color: var(--text); }
.skip-link:focus { top: 12px; }

.app-shell { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: sticky; top: 0; display: flex; flex-direction: column; gap: var(--space-5); height: 100vh; border-right: 1px solid var(--line); background: var(--bg); padding: var(--space-4) var(--space-3); overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 4px 8px; color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.3; white-space: nowrap; }
.brand:hover { color: var(--text); text-decoration: none; }
.brand-logo { width: 24px; height: 24px; border-radius: 6px; object-fit: contain; flex-shrink: 0; }
.sidebar nav { display: grid; gap: 2px; }
.sidebar nav a { position: relative; display: flex; align-items: center; gap: 12px; min-height: 40px; border-radius: var(--radius-sm); padding: 0 12px; color: var(--text-muted); font-size: 14px; font-weight: 500; transition: background-color .12s ease, color .12s ease; }
.sidebar nav a:hover { background: var(--surface); color: var(--text); text-decoration: none; }
.sidebar nav a[aria-current] { background: var(--surface-raised); color: var(--text); }
.sidebar nav a[aria-current]::before { content: ''; position: absolute; top: 8px; bottom: 8px; left: 0; width: 2px; border-radius: 2px; background: var(--accent); }
.nav-mark { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; color: currentColor; flex-shrink: 0; }
.nav-icon { width: 18px; height: 18px; display: block; }
.sidebar-footer { display: grid; gap: 2px; margin-top: auto; border-top: 1px solid var(--line); padding-top: var(--space-3); }
.sidebar-footer .developer-links > summary { min-height: 40px; padding: 0 12px; }
.developer-links > div { display: grid; gap: 2px; margin-top: 0; padding: 0 0 var(--space-2); }
.developer-links > div a { display: flex; align-items: center; min-height: 36px; padding: 0 12px 0 26px; color: var(--text-muted); font-size: 13px; }
.developer-links > div a:hover { color: var(--text); }
.shell-sign-out { display: flex; align-items: center; gap: 12px; min-height: 40px; border-radius: var(--radius-sm); padding: 0 12px; color: var(--text-muted); font-size: 14px; font-weight: 500; transition: background-color .12s ease, color .12s ease; }
.shell-sign-out:hover { background: var(--surface); color: var(--text); text-decoration: none; }

main { width: 100%; max-width: var(--content-width); min-width: 0; margin: 0 auto; padding: 40px 48px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); margin-bottom: var(--space-6); }
.page-header h1 { margin-bottom: 4px; }
.page-description { max-width: 720px; margin-bottom: 0; font-size: 14px; }

@media (max-width: 1100px) {
  main { padding: 32px; }
}
@media (max-width: 760px) {
  .app-shell { display: block; }
  .sidebar { position: sticky; z-index: 10; top: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "brand signout" "nav nav"; align-items: center; gap: 0 var(--space-3); height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: var(--space-2) var(--space-4) 0; overflow: visible; }
  .brand { grid-area: brand; padding: 4px 0; }
  .sidebar-footer { display: contents; }
  .sidebar-footer .developer-links { display: none; }
  .shell-sign-out { grid-area: signout; min-height: 44px; padding: 0 8px; }
  .shell-sign-out svg { display: none; }
  .sidebar nav { grid-area: nav; display: flex; gap: 4px; margin: 0 calc(var(--space-4) * -1); padding: 0 var(--space-4); overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
  .sidebar nav::-webkit-scrollbar { display: none; }
  .sidebar nav a { flex: 1 1 0; flex-direction: column; justify-content: center; gap: 2px; min-width: 64px; min-height: 52px; border-radius: 0; padding: 6px 4px; font-size: 12px; white-space: nowrap; }
  .sidebar nav a:hover { background: transparent; }
  .sidebar nav a[aria-current] { background: transparent; }
  .sidebar nav a[aria-current]::before { top: auto; right: 14px; bottom: 0; left: 14px; width: auto; height: 2px; }
  main { padding: 20px 16px; }
  .page-header { margin-bottom: var(--space-5); }
}
@media (max-width: 700px) {
  h1 { font-size: 24px; }
}
`;
