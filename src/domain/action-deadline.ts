export interface ActionDeadline {
  expiresAtMs: number | null;
  scheduledForMs: number;
  explanation: unknown;
}

/** Positive tolerances have an exclusive end; zero tolerance admits the exact instant only. */
export function actionDeadlineExpired(intent: ActionDeadline, nowMs: number): boolean {
  if (intent.expiresAtMs === null || nowMs < intent.expiresAtMs) return false;
  const explanation = intent.explanation;
  return !(
    intent.expiresAtMs === intent.scheduledForMs &&
    nowMs === intent.expiresAtMs &&
    typeof explanation === 'object' &&
    explanation !== null &&
    'toleranceSeconds' in explanation &&
    explanation.toleranceSeconds === 0
  );
}

/** SQL equivalent, evaluated atomically by the action claim. */
export const ACTION_DEADLINE_SQL = `(
  expires_at_ms IS NULL OR expires_at_ms > @nowMs OR (
    expires_at_ms = scheduled_for_ms AND expires_at_ms = @nowMs
    AND json_extract(explanation_json, '$.toleranceSeconds') = 0
  )
)`;
