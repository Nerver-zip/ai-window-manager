export type Page = 'overview' | 'usage' | 'schedule' | 'history' | 'settings';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const NAV_ICONS: Readonly<Record<Page, string>> = {
  overview: `<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>`,
  usage: `<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V8"/><path d="M2 19h20"/></svg>`,
  schedule: `<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M12 14v4"/><path d="M12 14h3"/></svg>`,
  history: `<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>`,
  settings: `<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
};

export function renderAppShell(input: {
  page: Page;
  title: string;
  description?: string;
  content: string;
}): string {
  const navigation = (['overview', 'usage', 'schedule', 'history', 'settings'] as const)
    .map(
      (page) =>
        `<a href="${page === 'overview' ? '/' : `/${page}`}"${input.page === page ? ' aria-current="page"' : ''}><span class="nav-mark" aria-hidden="true">${NAV_ICONS[page]}</span><span>${page.charAt(0).toUpperCase()}${page.slice(1)}</span></a>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(input.title)} · AI Window Manager</title><link rel="icon" type="image/png" href="/assets/images/logo.png"><link rel="stylesheet" href="/assets/app.css"><script defer src="/assets/app.js"></script></head><body><a class="skip-link" href="#main">Skip to content</a><div class="app-shell"><aside class="sidebar"><a class="brand" href="/"><img class="brand-logo" src="/assets/images/logo.png" alt="" width="28" height="28"><span>AI Window<span class="brand-subtitle">MANAGER</span></span></a><p class="nav-caption">WORKSPACE</p><nav aria-label="Primary navigation">${navigation}</nav><footer class="sidebar-footer"><details class="developer-links"><summary>Developer tools</summary><div><a href="/api/v1/providers">JSON API</a><a href="/metrics">Metrics</a></div></details></footer></aside><main id="main" tabindex="-1"><header class="page-header"><div><p class="eyebrow">WINDOW OPERATIONS</p><h1>${escapeHtml(input.title)}</h1>${input.description ? `<p class="page-description">${escapeHtml(input.description)}</p>` : ''}</div></header>${input.content}<footer class="page-footer">AI Window Manager <span>Observe. Plan. Understand.</span></footer></main></div></body></html>`;
}
