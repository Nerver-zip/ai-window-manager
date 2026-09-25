import { describe, expect, it } from 'vitest';
import { renderAppShell } from '../../src/web/ui/layout.js';
import {
  renderOperatorLoginPage,
  renderOperatorLogoutPage,
} from '../../src/web/ui/operator-auth.js';
import { OPERATOR_AUTH_CSS } from '../../src/web/ui/operator-auth-styles.js';

describe('operator authentication UI', () => {
  it('renders a standalone login page with native, labelled credentials form', () => {
    const html = renderOperatorLoginPage({
      csrfToken: 'synthetic-csrf-token',
      next: '/schedule',
    });

    expect(html).toContain('<main class="operator-auth-layout">');
    expect(html).toContain('/assets/images/logo.png');
    expect(html).toContain('AI Window Manager');
    expect(html).toContain('<form class="operator-auth-form" method="post" action="/login"');
    expect(html).toContain('name="csrfToken" value="synthetic-csrf-token"');
    expect(html).toContain('name="next" value="/schedule"');
    expect(html).toContain('for="operator-auth-username">Username');
    expect(html).toContain(
      'id="operator-auth-username" name="username" type="text" autocomplete="username"',
    );
    expect(html).toContain('for="operator-auth-password">Password');
    expect(html).toContain(
      'id="operator-auth-password" name="password" type="password" autocomplete="current-password"',
    );
    expect(html).toContain('type="submit">Sign in</button>');
    expect(html).not.toContain('sidebar');
    expect(html).not.toContain('Codex');
    expect(html).not.toContain('Antigravity');
    expect(html).not.toContain('quota');
    expect(html).not.toContain('Developer tools');
    expect(html).not.toContain('JSON API');
    expect(html).not.toContain('Metrics');
    expect(html).not.toMatch(/<script\b|\sstyle=/);
  });

  it('escapes hidden values and never echoes a password', () => {
    const html = renderOperatorLoginPage({
      csrfToken: `csrf"&<token`,
      next: `/usage?x="<script>alert(1)</script>`,
      error: 'invalid_credentials',
    });

    expect(html).toContain('name="csrfToken" value="csrf&quot;&amp;&lt;token"');
    expect(html).toContain(
      'name="next" value="/usage?x=&quot;&lt;script&gt;alert(1)&lt;/script&gt;"',
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Invalid username or password.');
    expect(html).not.toMatch(/name="password"[^>]*value=/);
    expect(html).not.toMatch(/<input[^>]*type="password"[^>]*value=/);
  });

  it.each([
    ['invalid_credentials', 'Invalid username or password.'],
    ['too_many_attempts', 'Too many sign-in attempts. Try again shortly.'],
    ['session_expired', 'Your session expired. Sign in again.'],
  ] as const)('renders the accessible %s error without technical details', (error, copy) => {
    const html = renderOperatorLoginPage({ csrfToken: 'synthetic-csrf', next: '/', error });

    expect(html).toContain(
      'id="operator-auth-error" class="operator-auth-error" role="alert" aria-live="assertive"',
    );
    expect(html).toContain(copy);
    expect(html).not.toContain('session token');
    expect(html).not.toContain('operator-authentication');
  });

  it('renders GET logout as a confirmation whose only mutation is an explicit CSRF-protected POST', () => {
    const html = renderOperatorLogoutPage({ csrfToken: 'synthetic-csrf-token' });

    expect(html).toContain('<h1 id="operator-auth-title">Sign out?</h1>');
    expect(html).toContain(
      '<form class="operator-auth-form operator-auth-form--logout" method="post" action="/logout">',
    );
    expect(html).toContain('name="csrfToken" value="synthetic-csrf-token"');
    expect(html).toContain('type="submit">Sign out</button>');
    expect(html).toContain('href="/">Stay signed in</a>');
    expect(html).not.toMatch(/<form[^>]*method="get"[^>]*action="\/logout"/);
    expect(html).not.toMatch(/<script\b|\sstyle=/);
  });

  it('adds one clear sign-out navigation link to the authenticated application shell', () => {
    const html = renderAppShell({ page: 'overview', title: 'Overview', content: '' });

    expect(html.match(/href="\/logout"/g)).toHaveLength(1);
    expect(html).toContain(
      '<a class="button button-secondary shell-sign-out" href="/logout">Sign out</a>',
    );
  });

  it('exports responsive, token-based auth styles with a visible keyboard focus state', () => {
    expect(OPERATOR_AUTH_CSS).toContain('var(--surface)');
    expect(OPERATOR_AUTH_CSS).toContain('var(--border)');
    expect(OPERATOR_AUTH_CSS).toContain(':focus-visible');
    expect(OPERATOR_AUTH_CSS).toContain('min-height: 48px');
    expect(OPERATOR_AUTH_CSS).toContain('@media (max-width: 480px)');
    expect(OPERATOR_AUTH_CSS).toContain('prefers-reduced-motion');
    expect(OPERATOR_AUTH_CSS).not.toMatch(/@import|https?:/);
  });
});
