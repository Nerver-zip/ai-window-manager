import { describe, expect, it } from 'vitest';
import { escapeHtml, renderAppShell } from '../../src/web/ui/layout.js';
import { APP_CSS } from '../../src/web/ui/styles.js';

describe('shared application shell', () => {
  it.each(['overview', 'schedule', 'history', 'settings'] as const)(
    'marks only %s as current and serves local assets',
    (page) => {
      const html = renderAppShell({
        page,
        title: page,
        content: '<section>Safe application markup</section>',
      });
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toContain(
        `href="${page === 'overview' ? '/' : `/${page}`}" aria-current="page"`,
      );
      expect(html).toContain(`${page} · AI Window Manager`);
      expect(html).toContain('href="/assets/app.css"');
      expect(html).toContain('<script defer src="/assets/app.js"></script>');
      expect(html).toContain('Skip to content');
      expect(html).not.toMatch(/<style|<script>|style=/);
    },
  );
  it('escapes all untrusted heading text and preserves readable descriptions', () => {
    const html = renderAppShell({
      page: 'overview',
      title: '<script>"&\'</script>',
      description: '<img onerror="bad">',
      content: '',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img onerror=&quot;bad&quot;&gt;');
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
  it('defines mobile, focus, reduced-motion and bounded graph styling without remote dependencies', () => {
    expect(APP_CSS).toContain('@media (max-width: 700px)');
    expect(APP_CSS).toContain(':focus-visible');
    expect(APP_CSS).toContain('min-height: 44px');
    expect(APP_CSS).toContain('.chart-tooltip[data-position="center"]');
    expect(APP_CSS).toContain('.chart-point-hit:hover .chart-point-active');
    expect(APP_CSS).toContain('stroke-width: 1.6');
    expect(APP_CSS).toContain('.chart-svg { height: 205px; }');
    expect(APP_CSS).toContain('.chart-axis-label, .chart-axis-time { font-size: 18px; }');
    expect(APP_CSS).toContain('prefers-reduced-motion');
    expect(APP_CSS).not.toMatch(/@import|https?:/);
  });
});
