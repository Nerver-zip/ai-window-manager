import { describe, expect, it } from 'vitest';
import {
  renderAuthOnboarding,
  type AuthOnboardingStatus,
} from '../../src/web/ui/auth-onboarding.js';
import { AUTH_ONBOARDING_CSS } from '../../src/web/ui/auth-onboarding-styles.js';
import { AUTH_ONBOARDING_JS } from '../../src/web/ui/auth-onboarding-interactions.js';

const status = (overrides: Partial<AuthOnboardingStatus> = {}): AuthOnboardingStatus => ({
  providerId: 'codex',
  state: 'IDLE',
  startedAt: null,
  expiresAt: null,
  authorizationUrl: null,
  userCode: null,
  requiresCodeSubmission: false,
  reasonCode: null,
  ...overrides,
});

describe('auth onboarding UI', () => {
  it('renders a loading state without exposing implementation details', () => {
    const html = renderAuthOnboarding({ providerId: 'codex' });

    expect(html).toContain('Checking sign-in status');
    expect(html).toContain('data-auth-state="loading"');
    expect(html).toContain('Connect Codex');
    expect(html).not.toContain('auth.json');
    expect(html).not.toContain('refresh_token');
    expect(html).not.toContain('authorization_code');
    expect(html).not.toContain('CLI output');
  });

  it('renders the empty state for an unconfigured provider', () => {
    const html = renderAuthOnboarding({ providerId: 'antigravity', configured: false });

    expect(html).toContain('Not configured');
    expect(html).toContain('Authentication is not configured for this provider.');
    expect(html).toContain('data-auth-start hidden');
  });

  it.each([
    ['IDLE', 'Not connected', 'Start official sign-in'],
    [
      'STARTING',
      'Starting sign-in',
      'The official provider client is preparing a sign-in request.',
    ],
    ['VERIFYING', 'Checking sign-in', 'The provider client is checking that sign-in completed.'],
    ['SUCCEEDED', 'Connected', 'This provider is connected and ready for usage checks.'],
    ['FAILED', 'Sign-in failed', 'The official sign-in could not be completed.'],
    ['TIMED_OUT', 'Sign-in expired', 'The sign-in window expired'],
    ['CANCELED', 'Sign-in canceled', 'The sign-in request was canceled'],
  ] as const)('renders the %s state with clear copy', (state, label, detail) => {
    const html = renderAuthOnboarding({ providerId: 'codex', status: status({ state }) });

    expect(html).toContain(`data-auth-state="${state}"`);
    expect(html).toContain(label);
    expect(html).toContain(detail);
  });

  it('renders a safe awaiting-user-action state with an optional one-time code', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({
        state: 'AWAITING_USER_ACTION',
        startedAt: '2026-09-23T10:00:00.000Z',
        expiresAt: '2026-09-23T10:05:00.000Z',
        authorizationUrl: 'https://auth.example.test/device?flow=awm',
        userCode: 'ABCD-EFGH',
        requiresCodeSubmission: true,
      }),
    });

    expect(html).toContain('Action needed');
    expect(html).toContain('Open official sign-in');
    expect(html).toContain('href="https://auth.example.test/device?flow=awm"');
    expect(html).toContain('ABCD-EFGH');
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain('data-auth-submit');
    expect(html).toContain('This sign-in expires at');
  });

  it('does not render unsafe or out-of-state authorization material', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({
        state: 'SUCCEEDED',
        authorizationUrl: 'javascript:alert(1)',
        userCode: '<img src=x onerror=alert(1)>',
        requiresCodeSubmission: true,
      }),
    });

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('img src');
    expect(html).not.toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders status-unavailable errors without raw reason codes', () => {
    const html = renderAuthOnboarding({ providerId: 'codex', status: null });

    expect(html).toContain('Status unavailable');
    expect(html).toContain('The status check failed');
    expect(html).not.toContain('AUTH_SESSION_FAILED');
  });

  it('escapes provider-facing text and never renders credential-shaped fields', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({
        state: 'FAILED',
        reasonCode: 'AUTH_START_FAILED',
      }),
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('access_token');
    expect(html).not.toContain('secret_path');
    expect(html).toContain('official client could not start sign-in');
  });

  it('explains when the official sign-in process never starts responding', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({ state: 'TIMED_OUT', reasonCode: 'AUTH_START_TIMEOUT' }),
    });

    expect(html).toContain('official sign-in process did not respond in time');
  });

  it('keeps the client-side flow safe and progressive', () => {
    expect(AUTH_ONBOARDING_JS).toContain('fetch(url, options)');
    expect(AUTH_ONBOARDING_JS).toContain("readCookie('awm_csrf')");
    expect(AUTH_ONBOARDING_JS).toContain("input.value = ''");
    expect(AUTH_ONBOARDING_JS).toContain('setTimeout(poll, 2000)');
    expect(AUTH_ONBOARDING_JS).not.toContain('localStorage');
    expect(AUTH_ONBOARDING_JS).not.toContain('sessionStorage');
    expect(AUTH_ONBOARDING_JS).not.toContain('innerHTML');
    expect(AUTH_ONBOARDING_JS).not.toContain('console.log');
  });

  it('keeps styles scoped, responsive, and motion-conscious', () => {
    expect(AUTH_ONBOARDING_CSS).toContain('.auth-onboarding');
    expect(AUTH_ONBOARDING_CSS).toContain(
      '.auth-onboarding__status[data-auth-state="SUCCEEDED"] .auth-onboarding__status-dot',
    );
    expect(AUTH_ONBOARDING_CSS).toContain('animation: online-pulse 1.8s ease-out infinite');
    expect(AUTH_ONBOARDING_CSS).toContain('@media (max-width: 700px)');
    expect(AUTH_ONBOARDING_CSS).toContain('prefers-reduced-motion');
    expect(AUTH_ONBOARDING_CSS).not.toMatch(/(^|\n)\s*body\s*\{/);
    expect(AUTH_ONBOARDING_CSS).not.toContain('@import');
  });
});
