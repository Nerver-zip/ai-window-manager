import { describe, expect, it } from 'vitest';
import {
  renderAuthOnboarding,
  type AuthOnboardingStatus,
} from '../../src/web/ui/auth-onboarding.js';
import { AUTH_ONBOARDING_CSS } from '../../src/web/ui/auth-onboarding-styles.js';
import { AUTH_ONBOARDING_JS } from '../../src/web/ui/auth-onboarding-interactions.js';
import { APP_CSS } from '../../src/web/ui/styles.js';

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

    expect(html).toContain('Checking your connection…');
    expect(html).toContain('data-auth-state="loading"');
    expect(html).toContain('Connect Codex');
    expect(html).toContain('Sign in with OpenAI to start tracking your usage windows.');
    expect(html).not.toContain('auth.json');
    expect(html).not.toContain('refresh_token');
    expect(html).not.toContain('authorization_code');
    expect(html).not.toContain('CLI output');
  });

  it('renders the empty state for an unconfigured provider', () => {
    const html = renderAuthOnboarding({ providerId: 'antigravity', configured: false });

    expect(html).toContain('Sign-in is not available for this provider yet.');
    expect(html).toContain('data-auth-start hidden');
  });

  it.each([
    ['IDLE', 'Connect Codex', 'Sign in with OpenAI to start tracking your usage windows.'],
    ['STARTING', 'Opening sign-in…', 'Opening sign-in…'],
    ['VERIFYING', 'Checking your account…', 'Checking your account…'],
    ['SUCCEEDED', 'Connected. Usage checks are ready.', 'Connected. Usage checks are ready.'],
    [
      'FAILED',
      'We couldn’t complete sign-in. Try again.',
      'We couldn’t complete sign-in. Try again.',
    ],
    ['TIMED_OUT', 'Sign-in timed out. Try again.', 'Sign-in timed out. Try again.'],
    ['CANCELED', 'Sign-in canceled. Try again.', 'Sign-in canceled. Try again.'],
  ] as const)('renders the %s state with clear copy', (state, label, detail) => {
    const html = renderAuthOnboarding({ providerId: 'codex', status: status({ state }) });

    expect(html).toContain(`data-auth-state="${state}"`);
    expect(html).toContain(label);
    expect(html).toContain(detail);
  });

  it('shows and can copy the Codex device code and sign-in link', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({
        state: 'AWAITING_USER_ACTION',
        startedAt: '2026-09-23T10:00:00.000Z',
        expiresAt: '2026-09-23T10:05:00.000Z',
        authorizationUrl: 'https://auth.example.test/device?flow=awm',
        userCode: 'ABCD-EFGH',
        requiresCodeSubmission: false,
      }),
    });

    expect(html).toContain('Open sign-in');
    expect(html).toContain('href="https://auth.example.test/device?flow=awm"');
    expect(html).toContain('data-auth-device-code');
    expect(html).toContain('Enter this code on the sign-in page.');
    expect(html).toContain('ABCD-EFGH');
    expect(html).toContain('data-auth-copy-code');
    expect(html).toContain('Copy sign-in code');
    expect(html).toContain('data-auth-copy-url');
    expect(html).toContain('Copy sign-in link');
    expect(html).toMatch(/data-auth-code-section hidden/);
    expect(html).toContain('This sign-in expires at');
  });

  it('keeps Antigravity code submission separate from a displayed device code', () => {
    const html = renderAuthOnboarding({
      providerId: 'antigravity',
      status: status({
        providerId: 'antigravity',
        state: 'AWAITING_USER_ACTION',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?flow=awm',
        requiresCodeSubmission: true,
      }),
    });

    expect(html).toContain('data-auth-code-section>');
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain('Enter the code shown by the provider.');
    expect(html).toContain('data-auth-submit');
    expect(html).toMatch(/data-auth-device-code hidden/);
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

    expect(html).toContain('The provider connection status could not be loaded. Try again.');
    expect(html).not.toContain('The status check failed');
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
    expect(html).toContain('Couldn’t start sign-in. Try again.');
  });

  it('explains when the official sign-in process never starts responding', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({ state: 'TIMED_OUT', reasonCode: 'AUTH_START_TIMEOUT' }),
    });

    expect(html).toContain('Sign-in timed out. Try again.');
  });

  it('uses the requested concise copy for canceled and rejected sign-in states', () => {
    const canceled = renderAuthOnboarding({
      providerId: 'codex',
      status: status({ state: 'CANCELED', reasonCode: 'AUTH_CANCELED' }),
    });
    const rejected = renderAuthOnboarding({
      providerId: 'antigravity',
      status: status({
        providerId: 'antigravity',
        state: 'FAILED',
        reasonCode: 'AUTH_CODE_REJECTED',
      }),
    });

    expect(canceled).toContain('Sign-in canceled. Try again.');
    expect(rejected).toContain(
      'Sign-in code was not accepted. Please check the code and try again.',
    );
    expect(rejected).toContain('Sign in with Google to start tracking your usage windows.');
  });

  it('labels an already connected account with a secondary reconnect action', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({ state: 'SUCCEEDED' }),
      reconnect: true,
    });

    expect(html).toContain('data-auth-role="reconnect"');
    expect(html).toContain('Reconnect Codex');
    expect(html).not.toMatch(/data-auth-start hidden/);
  });

  it('keeps the client-side flow safe and progressive', () => {
    expect(AUTH_ONBOARDING_JS).toContain('fetch(url, options)');
    expect(AUTH_ONBOARDING_JS).toContain("'[data-auth-device-code]'");
    expect(AUTH_ONBOARDING_JS).toContain('setHidden(deviceCode, !(awaiting && status?.userCode));');
    expect(AUTH_ONBOARDING_JS).toContain("readCookie('awm_csrf')");
    expect(AUTH_ONBOARDING_JS).toContain(
      "const message = status\n        ? STATE_DETAILS[state]\n        : 'The provider connection status is unavailable. Try again.';",
    );
    expect(AUTH_ONBOARDING_JS).not.toContain(
      "STATE_DETAILS[state] || 'The provider connection status is unavailable. Try again.'",
    );
    expect(AUTH_ONBOARDING_JS).toContain("input.value = ''");
    expect(AUTH_ONBOARDING_JS).toContain('setTimeout(poll, 2000)');
    expect(AUTH_ONBOARDING_JS).toContain('navigator.clipboard.writeText(value)');
    expect(AUTH_ONBOARDING_JS).toContain("'[data-auth-copy-code]'");
    expect(AUTH_ONBOARDING_JS).toContain("'[data-auth-copy-url]'");
    expect(AUTH_ONBOARDING_JS).toContain("'[data-provider-connection-status]'");
    expect(AUTH_ONBOARDING_JS).not.toContain('localStorage');
    expect(AUTH_ONBOARDING_JS).not.toContain('sessionStorage');
    expect(AUTH_ONBOARDING_JS).not.toContain('innerHTML');
    expect(AUTH_ONBOARDING_JS).not.toContain('console.log');
  });

  it('keeps styles scoped, responsive, and motion-conscious', () => {
    expect(AUTH_ONBOARDING_CSS).toContain('.auth-onboarding');
    expect(AUTH_ONBOARDING_CSS).toContain('.auth-copy-button');
    expect(APP_CSS).toContain('.provider-connection-badge[data-connection-state="connected"]');
    expect(APP_CSS).toContain('animation: online-pulse 1.8s ease-out infinite');
    expect(AUTH_ONBOARDING_CSS).toContain('@media (max-width: 700px)');
    expect(AUTH_ONBOARDING_CSS).toContain('prefers-reduced-motion');
    expect(AUTH_ONBOARDING_CSS).not.toMatch(/(^|\n)\s*body\s*\{/);
    expect(AUTH_ONBOARDING_CSS).not.toContain('@import');
  });
});
