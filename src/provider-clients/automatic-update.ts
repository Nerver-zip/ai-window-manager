export const AUTOMATIC_PROVIDER_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const AUTOMATIC_PROVIDER_UPDATE_RETRY_MS = 15 * 60 * 1_000;

export interface AutomaticProviderUpdateDueInput {
  enabled: boolean;
  running: boolean;
  busy: boolean;
  nowMs: number;
  lastAttemptAtMs: unknown;
  lastSuccessfulCheckAtMs: unknown;
}

/**
 * Successful checks are daily; failed/interrupted attempts become eligible for
 * retry after a short bounded cooldown instead of suppressing checks for a day.
 */
export function isAutomaticProviderUpdateDue(input: AutomaticProviderUpdateDueInput): boolean {
  if (
    !input.enabled ||
    input.running ||
    input.busy ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0
  ) {
    return false;
  }

  const lastAttemptAtMs = validTimestamp(input.lastAttemptAtMs);
  if (
    lastAttemptAtMs !== undefined &&
    input.nowMs - lastAttemptAtMs < AUTOMATIC_PROVIDER_UPDATE_RETRY_MS
  ) {
    return false;
  }

  const lastSuccessfulCheckAtMs = validTimestamp(input.lastSuccessfulCheckAtMs);
  return (
    lastSuccessfulCheckAtMs === undefined ||
    input.nowMs - lastSuccessfulCheckAtMs >= AUTOMATIC_PROVIDER_UPDATE_INTERVAL_MS
  );
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
