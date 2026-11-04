/** Provider selector: a compact segmented-tab row (radio or link variants). */
export const PROVIDER_PICKER_CSS = `
.provider-picker { min-width: 0; max-width: 100%; border: 0; margin: 0; padding: 0; }
.provider-picker > legend { position: absolute; width: 1px; height: 1px; margin: 0; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.provider-picker-navigation > .field-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.provider-picker-options { display: flex; align-items: center; gap: 2px; width: fit-content; max-width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); padding: 3px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.provider-picker-option { position: relative; display: block; flex: 0 0 auto; min-width: 0; cursor: pointer; }
.provider-picker-option-link { color: inherit; text-decoration: none; }
.provider-picker-option-link:hover { color: inherit; text-decoration: none; }
.provider-picker-input { position: absolute; z-index: 1; top: 50%; left: 16px; width: 1px; height: 1px; min-height: 0; margin: 0; padding: 0; opacity: 0; }
.provider-picker-card { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 34px; border: 1px solid transparent; border-radius: 4px; padding: 0 12px 0 10px; white-space: nowrap; transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
.provider-picker-option:hover .provider-picker-card { background: var(--surface-raised); }
.provider-picker-option.is-selected .provider-picker-card { border-color: var(--line-strong); background: var(--surface-raised); }
.provider-picker-input:focus-visible + .provider-picker-card { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
.provider-picker-option-link:focus-visible .provider-picker-card { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
.provider-picker-logo { display: grid; place-items: center; width: 20px; height: 20px; flex: 0 0 20px; overflow: hidden; border-radius: 4px; }
.provider-picker-logo img { display: block; width: 20px; height: 20px; object-fit: contain; }
.provider-picker-logo--claude-code { width: 22px; height: 22px; flex-basis: 22px; border-radius: 0; }
.provider-picker-logo--claude-code img { width: 22px; height: 22px; }
.provider-picker-option.is-unconfigured .provider-picker-logo img { filter: grayscale(1); opacity: .6; }
.provider-picker-fallback { color: var(--accent); font-size: 10px; font-weight: 600; }
.provider-picker-option.is-unconfigured .provider-picker-fallback { color: var(--text-muted); }
.provider-picker-copy { display: flex; align-items: center; gap: 8px; min-width: 0; }
.provider-picker-name { color: var(--text); font-size: 14px; font-weight: 500; line-height: 1.25; }
.provider-picker-option.is-unconfigured .provider-picker-name { color: var(--text-muted); }
.provider-picker-dot { flex: 0 0 auto; width: 7px; height: 7px; border: 1.5px solid var(--text-faint); border-radius: 50%; }
.provider-picker-option[data-configured="true"] .provider-picker-dot { border-color: var(--ok); background: var(--ok); }
.provider-picker-dot[data-tone="ok"] { border-color: var(--ok); background: var(--ok); }
.provider-picker-option .provider-picker-dot[data-tone="attention"] { border-color: var(--warn); background: transparent; }
.provider-picker-option .provider-picker-dot[data-tone="muted"] { border-color: var(--text-faint); background: transparent; }
.provider-picker-status { color: var(--text-muted); font-size: 12px; line-height: 1.3; }
.provider-picker-empty { margin: 0; color: var(--text-muted); font-size: 13px; }
.usage-filter-form > .provider-picker, .history-toolbar-fields > .provider-picker, .schedule-primary-fields > .provider-picker, .schedule-page .provider-picker { grid-column: 1 / -1; }
@media (max-width: 760px) {
  .provider-picker-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .provider-picker-card { min-height: 40px; }
  .provider-picker-options { flex-wrap: wrap; width: auto; overflow-x: visible; }
}
`;
