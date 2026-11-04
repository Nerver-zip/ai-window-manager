import { describe, expect, it } from 'vitest';
import { validateAuthorizationUrl } from '../../src/auth/authorization-url.js';

const CLAUDE_BOOTSTRAP_PARAMETERS = {
  code: 'synthetic-bootstrap-code-0123456789',
  client_id: 'synthetic-client-id',
  response_type: 'code',
  redirect_uri: 'https://platform.claude.com/oauth/code/callback',
  scope: 'user:profile user:inference',
  code_challenge: 'A'.repeat(43),
  code_challenge_method: 'S256',
  state: 'synthetic-state',
};

function claudeBootstrapUrl(overrides: Partial<typeof CLAUDE_BOOTSTRAP_PARAMETERS> = {}): string {
  const query = new URLSearchParams({ ...CLAUDE_BOOTSTRAP_PARAMETERS, ...overrides });
  return `https://claude.com/cai/oauth/authorize?${query.toString()}`;
}

describe('validateAuthorizationUrl', () => {
  it('allows provider-owned HTTPS URLs and Antigravity OAuth code-challenge URLs', () => {
    expect(
      validateAuthorizationUrl('codex', 'https://auth.openai.com/codex/device?state=synthetic'),
    ).toBe('https://auth.openai.com/codex/device?state=synthetic');
    expect(
      validateAuthorizationUrl(
        'antigravity',
        'https://accounts.google.com/o/oauth2/auth?response_type=code&code_challenge=synthetic',
      ),
    ).toBe('https://accounts.google.com/o/oauth2/auth?response_type=code&code_challenge=synthetic');
  });

  it('allows Claude Code’s observed one-time OAuth URL with its exact parameter set', () => {
    const url = claudeBootstrapUrl();
    expect(validateAuthorizationUrl('claude_code', url)).toBe(url);
  });

  it('allows nonempty short and longer bootstrap codes within the URL bound', () => {
    const shortCodeUrl = claudeBootstrapUrl({ code: 'short-code' });
    const longerCodeUrl = claudeBootstrapUrl({ code: 'x'.repeat(513) });
    expect(validateAuthorizationUrl('claude_code', shortCodeUrl)).toBe(shortCodeUrl);
    expect(validateAuthorizationUrl('claude_code', longerCodeUrl)).toBe(longerCodeUrl);
  });

  it('rejects a missing URL', () => {
    expect(validateAuthorizationUrl('claude_code', '')).toBeUndefined();
  });

  it.each([
    ['codex', 'https://auth.openai.com/login?code=synthetic-bootstrap-code'],
    ['antigravity', 'https://accounts.google.com/login?code=synthetic-bootstrap-code'],
    ['claude_code', 'https://claude.com/oauth/authorize?code=synthetic-bootstrap-code'],
    ['claude_code', claudeBootstrapUrl({ code: '' })],
    ['claude_code', claudeBootstrapUrl({ code: 'synthetic bootstrap code' })],
    ['claude_code', claudeBootstrapUrl({ response_type: 'token' })],
    ['claude_code', claudeBootstrapUrl({ code_challenge_method: 'plain' })],
    ['claude_code', claudeBootstrapUrl({ code_challenge: 'x'.repeat(129) })],
    [
      'claude_code',
      claudeBootstrapUrl({ redirect_uri: 'https://evil.example.test/oauth/callback' }),
    ],
    ['claude_code', `${claudeBootstrapUrl()}&prompt=login`],
    ['claude_code', `${claudeBootstrapUrl()}&code=synthetic-duplicate-code-value`],
    ['claude_code', `${claudeBootstrapUrl()}#fragment`],
  ] as const)('rejects unsafe auth URL for %s', (providerId, url) => {
    expect(validateAuthorizationUrl(providerId, url)).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    'not a URL',
    'http://claude.com/cai/oauth/authorize?code=synthetic-bootstrap-code',
    'https://claude.com.evil.test/cai/oauth/authorize?code=synthetic-bootstrap-code',
    'https://user:pass@claude.com/cai/oauth/authorize?code=synthetic-bootstrap-code',
    claudeBootstrapUrl({ code: 'x'.repeat(1900) }),
  ])('rejects malformed, untrusted, or oversized values', (url) => {
    expect(validateAuthorizationUrl('claude_code', url)).toBeUndefined();
  });
});
