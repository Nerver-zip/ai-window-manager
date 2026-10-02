import { createHash, timingSafeEqual } from 'node:crypto';

export function validateMetricsTokenDigest(value: string): boolean {
  return value === '' || /^[a-f0-9]{64}$/.test(value);
}

/** This credential grants no authority outside the exact read-only metrics route. */
export function authorizeMetricsRead(
  method: string,
  url: string,
  authorization: string | undefined,
  digest: string,
): boolean {
  if (
    digest === '' ||
    !validateMetricsTokenDigest(digest) ||
    (method !== 'GET' && method !== 'HEAD') ||
    url !== '/metrics' ||
    !authorization ||
    !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
  ) {
    return false;
  }
  const actual = createHash('sha256').update(authorization.slice(7), 'utf8').digest();
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}
