import { describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  CSRF_COOKIE_NAME,
  CSRF_TOKEN_BYTES,
  CsrfReasonCode,
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  getSecurityHeaders,
  ensureCsrfToken,
  isMutationMethod,
  isValidCsrfToken,
  readCookie,
  serializeCsrfCookie,
  validateCsrf,
  validateMutationOrigin,
  validateOrigin,
  OriginReasonCode,
} from '../../src/web/security.js';

const EXPECTED_ORIGIN = 'http://localhost:8787';

describe('HTTP security helpers', () => {
  it('classifies state-changing methods without treating reads as mutations', () => {
    expect(isMutationMethod('POST')).toBe(true);
    expect(isMutationMethod('post')).toBe(true);
    expect(isMutationMethod('PUT')).toBe(true);
    expect(isMutationMethod('PATCH')).toBe(true);
    expect(isMutationMethod('DELETE')).toBe(true);
    expect(isMutationMethod('GET')).toBe(false);
    expect(isMutationMethod('OPTIONS')).toBe(false);
  });

  it('accepts same-origin mutations and rejects cross-origin or malformed origins', () => {
    const policy = { expectedOrigin: EXPECTED_ORIGIN };
    expect(validateMutationOrigin('POST', EXPECTED_ORIGIN, policy)).toEqual({
      ok: true,
      reason: OriginReasonCode.SameOrigin,
    });
    expect(validateMutationOrigin('POST', 'https://evil.example', policy)).toEqual({
      ok: false,
      reason: OriginReasonCode.CrossOrigin,
    });
    expect(validateMutationOrigin('POST', 'null', policy)).toEqual({
      ok: false,
      reason: OriginReasonCode.InvalidOrigin,
    });
    expect(validateMutationOrigin('POST', ['http://a', 'http://b'], policy)).toEqual({
      ok: false,
      reason: OriginReasonCode.InvalidOrigin,
    });
    expect(validateMutationOrigin('POST', 'http://localhost:8787/path', policy)).toEqual({
      ok: false,
      reason: OriginReasonCode.InvalidOrigin,
    });
    expect(validateMutationOrigin('GET', 'https://evil.example', policy)).toEqual({
      ok: true,
      reason: OriginReasonCode.NotMutation,
    });
  });

  it('requires or explicitly allows an absent Origin according to local API policy', () => {
    expect(validateOrigin(undefined, { expectedOrigin: EXPECTED_ORIGIN })).toEqual({
      ok: false,
      reason: OriginReasonCode.MissingOrigin,
    });
    expect(
      validateOrigin(undefined, { expectedOrigin: EXPECTED_ORIGIN, allowMissingOrigin: true }),
    ).toEqual({
      ok: true,
      reason: OriginReasonCode.MissingOriginAllowed,
    });
    expect(validateOrigin(EXPECTED_ORIGIN, { expectedOrigin: 'not-an-origin' })).toEqual({
      ok: false,
      reason: OriginReasonCode.InvalidExpectedOrigin,
    });
  });

  it('creates a high-entropy token and serializes a restrictive CSRF cookie', () => {
    const token = ensureCsrfToken(undefined, { secure: true }).token;
    expect(token).toHaveLength(43);
    expect(isValidCsrfToken(token)).toBe(true);
    expect(CSRF_TOKEN_BYTES).toBe(32);

    const cookie = serializeCsrfCookie(token, { secure: true, httpOnly: true, maxAgeSeconds: 900 });
    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=${token}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=900');
  });

  it('keeps a valid CSRF token stable and supports local HTTP cookie configuration', () => {
    const token = ensureCsrfToken(undefined, { secure: false }).token;
    const cookie = serializeCsrfCookie(token, { secure: false });
    expect(cookie).not.toContain('Secure');
    expect(ensureCsrfToken(`other=value; ${CSRF_COOKIE_NAME}=${token}`).setCookie).toBeNull();
    expect(readCookie(`other=value; ${CSRF_COOKIE_NAME}=${token}`, CSRF_COOKIE_NAME)).toBe(token);
  });

  it('rejects malformed, missing, duplicate, or invalid CSRF material', () => {
    const token = ensureCsrfToken(undefined).token;
    const cookie = `${CSRF_COOKIE_NAME}=${token}`;
    expect(validateCsrf({ cookieHeader: undefined, headerToken: token })).toEqual({
      ok: false,
      reason: CsrfReasonCode.CookieMissing,
    });
    expect(validateCsrf({ cookieHeader: `${CSRF_COOKIE_NAME}=short`, headerToken: token })).toEqual(
      {
        ok: false,
        reason: CsrfReasonCode.CookieInvalid,
      },
    );
    expect(validateCsrf({ cookieHeader: cookie })).toEqual({
      ok: false,
      reason: CsrfReasonCode.TokenMissing,
    });
    expect(validateCsrf({ cookieHeader: cookie, headerToken: ['a', 'b'] })).toEqual({
      ok: false,
      reason: CsrfReasonCode.TokenInvalid,
    });
    expect(validateCsrf({ cookieHeader: cookie, headerToken: 'short' })).toEqual({
      ok: false,
      reason: CsrfReasonCode.TokenInvalid,
    });
    expect(validateCsrf({ cookieHeader: cookie, headerToken: token, formToken: 'short' })).toEqual({
      ok: false,
      reason: CsrfReasonCode.TokenInvalid,
    });
    expect(validateCsrf({ cookieHeader: `${cookie}; ${cookie}`, headerToken: token })).toEqual({
      ok: false,
      reason: CsrfReasonCode.CookieMissing,
    });
    expect(readCookie(['awm_csrf=value'], CSRF_COOKIE_NAME)).toBeNull();
    expect(readCookie('malformed; =value', CSRF_COOKIE_NAME)).toBeNull();
  });

  it('accepts a valid header or form token and compares using a safe equality path', () => {
    const token = ensureCsrfToken(undefined).token;
    const cookie = `${CSRF_COOKIE_NAME}=${token}`;
    expect(validateCsrf({ cookieHeader: cookie, headerToken: token })).toEqual({
      ok: true,
      reason: CsrfReasonCode.Valid,
    });
    expect(validateCsrf({ cookieHeader: cookie, formToken: token })).toEqual({
      ok: true,
      reason: CsrfReasonCode.Valid,
    });
    expect(validateCsrf({ cookieHeader: cookie, headerToken: token, formToken: token })).toEqual({
      ok: true,
      reason: CsrfReasonCode.Valid,
    });
    expect(validateCsrf({ cookieHeader: cookie, headerToken: `${token.slice(0, -1)}A` })).toEqual({
      ok: false,
      reason: CsrfReasonCode.TokenMismatch,
    });
    expect(
      validateCsrf({
        cookieHeader: cookie,
        headerToken: token,
        formToken: `${token.slice(0, -1)}A`,
      }),
    ).toEqual({
      ok: false,
      reason: CsrfReasonCode.TokenInvalid,
    });
  });

  it('preserves the CSP/body-limit baseline and adds privacy headers', () => {
    expect(DEFAULT_HTTP_BODY_LIMIT_BYTES).toBe(64 * 1024);
    expect(getSecurityHeaders()).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    expect(getSecurityHeaders({ noStore: true })['Cache-Control']).toBe('no-store');
  });

  it('rejects invalid cookie options and invalid tokens without exposing secret values', () => {
    const token = ensureCsrfToken(undefined).token;
    expect(() => serializeCsrfCookie('short')).toThrow('Invalid CSRF token');
    expect(() => serializeCsrfCookie(token, { maxAgeSeconds: -1 })).toThrow(
      'Invalid CSRF cookie max age',
    );
    expect(() => serializeCsrfCookie(token, { maxAgeSeconds: 1.5 })).toThrow(
      'Invalid CSRF cookie max age',
    );
    expect(isValidCsrfToken('')).toBe(false);
    expect(isValidCsrfToken(`${token}!`)).toBe(false);
  });
});
