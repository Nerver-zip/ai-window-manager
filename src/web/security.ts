import { randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_HTTP_BODY_LIMIT_BYTES = 64 * 1024;
export const CSRF_COOKIE_NAME = 'awm_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_TOKEN_BYTES = 32;

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; frame-ancestors 'none'";

const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type HeaderValue = string | readonly string[] | undefined;

export const OriginReasonCode = {
  NotMutation: 'NOT_MUTATION',
  SameOrigin: 'SAME_ORIGIN',
  MissingOriginAllowed: 'MISSING_ORIGIN_ALLOWED',
  MissingOrigin: 'MISSING_ORIGIN',
  InvalidOrigin: 'INVALID_ORIGIN',
  InvalidExpectedOrigin: 'INVALID_EXPECTED_ORIGIN',
  CrossOrigin: 'CROSS_ORIGIN',
} as const;

export type OriginReasonCode = (typeof OriginReasonCode)[keyof typeof OriginReasonCode];

export interface OriginPolicy {
  expectedOrigin: string;
  allowMissingOrigin?: boolean;
}

export interface OriginValidation {
  ok: boolean;
  reason: OriginReasonCode;
}

export const CsrfReasonCode = {
  Valid: 'CSRF_VALID',
  CookieMissing: 'CSRF_COOKIE_MISSING',
  CookieInvalid: 'CSRF_COOKIE_INVALID',
  TokenMissing: 'CSRF_TOKEN_MISSING',
  TokenInvalid: 'CSRF_TOKEN_INVALID',
  TokenMismatch: 'CSRF_TOKEN_MISMATCH',
} as const;

export type CsrfReasonCode = (typeof CsrfReasonCode)[keyof typeof CsrfReasonCode];

export interface CsrfValidation {
  ok: boolean;
  reason: CsrfReasonCode;
}

export interface CsrfRequestTokens {
  cookieHeader?: HeaderValue;
  headerToken?: HeaderValue;
  formToken?: HeaderValue;
}

export interface CsrfCookieOptions {
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax';
  maxAgeSeconds?: number;
}

export interface CsrfTokenResult {
  token: string;
  setCookie: string | null;
}

/**
 * Mutation routes need an explicit same-origin policy. Non-browser local API
 * clients may opt into missing Origin headers, but arbitrary origins are never
 * accepted and the CSRF check remains independent.
 */
export function validateMutationOrigin(
  method: string,
  origin: HeaderValue,
  policy: OriginPolicy,
): OriginValidation {
  if (!isMutationMethod(method)) {
    return { ok: true, reason: OriginReasonCode.NotMutation };
  }

  return validateOrigin(origin, policy);
}

export function isMutationMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return MUTATION_METHODS.some((candidate) => candidate === normalized);
}

export function validateOrigin(origin: HeaderValue, policy: OriginPolicy): OriginValidation {
  const expected = canonicalOrigin(policy.expectedOrigin);
  if (!expected) {
    return { ok: false, reason: OriginReasonCode.InvalidExpectedOrigin };
  }

  if (origin === undefined) {
    return policy.allowMissingOrigin
      ? { ok: true, reason: OriginReasonCode.MissingOriginAllowed }
      : { ok: false, reason: OriginReasonCode.MissingOrigin };
  }

  if (typeof origin !== 'string') {
    return { ok: false, reason: OriginReasonCode.InvalidOrigin };
  }

  const actual = canonicalOrigin(origin);
  if (!actual) {
    return { ok: false, reason: OriginReasonCode.InvalidOrigin };
  }

  return actual === expected
    ? { ok: true, reason: OriginReasonCode.SameOrigin }
    : { ok: false, reason: OriginReasonCode.CrossOrigin };
}

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    return url.origin === 'null' ? null : url.origin;
  } catch {
    return null;
  }
}

export function createCsrfToken(randomSource: (size: number) => Buffer = randomBytes): string {
  return randomSource(CSRF_TOKEN_BYTES).toString('base64url');
}

export function isValidCsrfToken(token: string): boolean {
  return CSRF_TOKEN_PATTERN.test(token);
}

/**
 * The CSRF cookie is intentionally readable by the browser: this is the
 * double-submit value that a form/header sends back. It contains no provider
 * credential. Integrations that render the token server-side may additionally
 * request HttpOnly, but the default remains browser-readable for forms.
 */
export function serializeCsrfCookie(token: string, options: CsrfCookieOptions = {}): string {
  if (!isValidCsrfToken(token)) {
    throw new Error('Invalid CSRF token');
  }

  const attributes = [
    `${CSRF_COOKIE_NAME}=${token}`,
    'Path=/',
    `SameSite=${options.sameSite ?? 'Strict'}`,
  ];
  if (options.secure ?? true) attributes.push('Secure');
  if (options.httpOnly ?? false) attributes.push('HttpOnly');
  if (options.maxAgeSeconds !== undefined) {
    if (!Number.isInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0) {
      throw new Error('Invalid CSRF cookie max age');
    }
    attributes.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return attributes.join('; ');
}

export function ensureCsrfToken(
  cookieHeader: HeaderValue,
  options: CsrfCookieOptions = {},
): CsrfTokenResult {
  const existing = readCookie(cookieHeader, CSRF_COOKIE_NAME);
  if (existing && isValidCsrfToken(existing)) {
    return { token: existing, setCookie: null };
  }

  const token = createCsrfToken();
  return { token, setCookie: serializeCsrfCookie(token, options) };
}

export function readCookie(cookieHeader: HeaderValue, name: string): string | null {
  if (typeof cookieHeader !== 'string' || name.length === 0) {
    return null;
  }

  let value: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    if (value !== undefined) {
      return null;
    }
    value = part.slice(separator + 1).trim();
  }
  return value ?? null;
}

export function validateCsrf(request: CsrfRequestTokens): CsrfValidation {
  const cookie = readCookie(request.cookieHeader, CSRF_COOKIE_NAME);
  if (!cookie) {
    return { ok: false, reason: CsrfReasonCode.CookieMissing };
  }
  if (!isValidCsrfToken(cookie)) {
    return { ok: false, reason: CsrfReasonCode.CookieInvalid };
  }

  const headerToken = scalarToken(request.headerToken);
  const formToken = scalarToken(request.formToken);
  if (headerToken === null || formToken === null) {
    return { ok: false, reason: CsrfReasonCode.TokenInvalid };
  }
  if (headerToken === undefined && formToken === undefined) {
    return { ok: false, reason: CsrfReasonCode.TokenMissing };
  }
  if (headerToken !== undefined && formToken !== undefined && headerToken !== formToken) {
    return { ok: false, reason: CsrfReasonCode.TokenInvalid };
  }

  const supplied = headerToken ?? formToken;
  if (supplied === undefined || !isValidCsrfToken(supplied)) {
    return { ok: false, reason: CsrfReasonCode.TokenInvalid };
  }

  return safeTokenEqual(cookie, supplied)
    ? { ok: true, reason: CsrfReasonCode.Valid }
    : { ok: false, reason: CsrfReasonCode.TokenMismatch };
}

function scalarToken(value: HeaderValue): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return null;
  }
  return value;
}

function safeTokenEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function getSecurityHeaders(options: { noStore?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (options.noStore) {
    headers['Cache-Control'] = 'no-store';
  }
  return headers;
}
