export const READ_PURPOSES = [
  'reconcile',
  'preflight',
  'confirmation',
  'resolution',
  'auth_check',
  'auth_verify',
] as const;
export type ReadPurpose = (typeof READ_PURPOSES)[number];
export type ReadFailureKind = 'unavailable' | 'auth_required' | 'invalid_response';

/** Only pass retry-after normalized from a validated official surface. */
export function readBackoffDelay(input: {
  failures: number;
  pollIntervalMs: number;
  kind: ReadFailureKind;
  jitter: number;
  retryAfterSeconds?: unknown;
}): number {
  if (
    !Number.isSafeInteger(input.failures) ||
    input.failures < 1 ||
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs < 1 ||
    !Number.isFinite(input.jitter) ||
    input.jitter < 0 ||
    input.jitter > 1
  )
    throw new RangeError('invalid read backoff inputs');
  const auth = input.kind === 'auth_required';
  const cap = auth ? 3_600_000 : 300_000;
  const base = auth ? 900_000 : Math.min(cap, Math.max(30_000, input.pollIntervalMs));
  const exponential = Math.min(cap, base * 2 ** Math.min(input.failures - 1, 30));
  const delay = Math.min(cap, Math.ceil(exponential * (1 + input.jitter * 0.2)));
  const retryAfter = input.retryAfterSeconds;
  if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter < 0)
    return delay;
  return Math.max(delay, Math.min(3_600_000, Math.ceil(retryAfter * 1000)));
}
