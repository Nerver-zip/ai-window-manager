export type Page = 'overview' | 'schedule' | 'history' | 'settings';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderAppShell(input: {
  page: Page;
  title: string;
  description?: string;
  content: string;
}): string {
  const navigation = (['overview', 'schedule', 'history', 'settings'] as const)
    .map(
      (page) =>
        `<a href="${page === 'overview' ? '/' : `/${page}`}"${input.page === page ? ' aria-current="page"' : ''}><span class="nav-mark" aria-hidden="true">${{ overview: '◫', schedule: '◷', history: '≋', settings: '⊞' }[page]}</span>${page[0]?.toUpperCase()}${page.slice(1)}</a>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(input.title)} · AI Window Manager</title><link rel="stylesheet" href="/assets/app.css"></head><body><a class="skip-link" href="#main">Skip to content</a><div class="app-shell"><aside class="sidebar"><a class="brand" href="/"><span class="brand-symbol" aria-hidden="true">▥</span><span>AI Window<span class="brand-subtitle">MANAGER</span></span></a><p class="nav-caption">WORKSPACE</p><nav aria-label="Primary navigation">${navigation}</nav><footer class="sidebar-footer"><span class="local-label">Self-hosted console</span><div><a href="/api/v1/providers">JSON API</a><a href="/metrics">Metrics</a></div></footer></aside><main id="main" tabindex="-1"><header class="page-header"><div><p class="eyebrow">WINDOW OPERATIONS</p><h1>${escapeHtml(input.title)}</h1>${input.description ? `<p class="page-description">${escapeHtml(input.description)}</p>` : ''}</div><span class="badge">LOCAL WORKSPACE</span></header>${input.content}<footer class="page-footer">AI Window Manager <span>Observe. Plan. Understand.</span></footer></main></div></body></html>`;
}
