import type { AuthProviderId } from './session-manager.js';

const ALLOWED_AUTH_HOSTS: Readonly<Record<AuthProviderId, ReadonlySet<string>>> = {
  codex: new Set(['auth.openai.com']),
  antigravity: new Set(['accounts.google.com']),
  claude_code: new Set(['claude.com']),
};

const SENSITIVE_QUERY_PARAMETER =
  /^(access_token|refresh_token|id_token|token|authorization|code)$/i;
const CLAUDE_CODE_BOOTSTRAP_PARAMETER_LIMITS = new Map([
  ['code', 2048],
  ['client_id', 256],
  ['response_type', 16],
  ['redirect_uri', 128],
  ['scope', 512],
  ['code_challenge', 128],
  ['code_challenge_method', 16],
  ['state', 512],
]);
const CLAUDE_CODE_CALLBACK = {
  hostname: 'platform.claude.com',
  pathname: '/oauth/code/callback',
} as const;

/** Validate a provider-owned URL before it can cross the authenticated UI boundary. */
export function validateAuthorizationUrl(
  providerId: AuthProviderId,
  value: string | null | undefined,
): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !ALLOWED_AUTH_HOSTS[providerId].has(url.hostname.toLowerCase()) ||
      url.username ||
      url.password
    )
      return undefined;

    const hasSensitiveParameter = [...url.searchParams.keys()].some((name) =>
      SENSITIVE_QUERY_PARAMETER.test(name),
    );
    if (hasSensitiveParameter && !isClaudeCodeBootstrapUrl(url)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Claude Code's CLI embeds a short-lived login challenge in its OAuth URL. */
function isClaudeCodeBootstrapUrl(url: URL): boolean {
  if (
    url.hostname.toLowerCase() !== 'claude.com' ||
    url.pathname !== '/cai/oauth/authorize' ||
    url.hash !== ''
  )
    return false;

  const parameters = [...url.searchParams.entries()];
  const parameterNames = new Set(parameters.map(([name]) => name));
  if (
    parameters.length !== CLAUDE_CODE_BOOTSTRAP_PARAMETER_LIMITS.size ||
    parameterNames.size !== CLAUDE_CODE_BOOTSTRAP_PARAMETER_LIMITS.size ||
    [...parameterNames].some((name) => !CLAUDE_CODE_BOOTSTRAP_PARAMETER_LIMITS.has(name)) ||
    parameters.some(([name, value]) => {
      const maxLength = CLAUDE_CODE_BOOTSTRAP_PARAMETER_LIMITS.get(name);
      return (
        maxLength === undefined ||
        value.length === 0 ||
        value.length > maxLength ||
        !isVisibleAscii(value)
      );
    })
  )
    return false;

  if (
    url.searchParams.get('response_type') !== 'code' ||
    url.searchParams.get('code_challenge_method') !== 'S256' ||
    !isClaudeCodeCallback(url.searchParams.get('redirect_uri'))
  )
    return false;

  const code = url.searchParams.get('code');
  return code !== null && code.length <= 2048 && isVisibleAscii(code, false);
}

function isClaudeCodeCallback(value: string | null): boolean {
  if (!value) return false;
  try {
    const callback = new URL(value);
    return (
      callback.protocol === 'https:' &&
      callback.hostname.toLowerCase() === CLAUDE_CODE_CALLBACK.hostname &&
      callback.pathname === CLAUDE_CODE_CALLBACK.pathname &&
      callback.port === '' &&
      callback.username === '' &&
      callback.password === '' &&
      callback.search === '' &&
      callback.hash === ''
    );
  } catch {
    return false;
  }
}

function isVisibleAscii(value: string, allowSpace = true): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= (allowSpace ? 0x20 : 0x21) && code <= 0x7e;
  });
}
