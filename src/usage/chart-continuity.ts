/** Display-only grace period for provider reads delayed by polling and reconcile ticks. */
export function chartContinuityGapMs(
  pollIntervalSeconds: number,
  reconcileIntervalSeconds: number,
): number {
  if (!Number.isSafeInteger(pollIntervalSeconds) || pollIntervalSeconds < 1) {
    throw new RangeError('poll interval must be a positive integer');
  }
  if (!Number.isSafeInteger(reconcileIntervalSeconds) || reconcileIntervalSeconds < 1) {
    throw new RangeError('reconcile interval must be a positive integer');
  }
  const gapMs =
    (3 * Math.max(pollIntervalSeconds, reconcileIntervalSeconds) + reconcileIntervalSeconds) *
    1_000;
  if (!Number.isSafeInteger(gapMs)) throw new RangeError('chart gap exceeds safe integer range');
  return gapMs;
}
