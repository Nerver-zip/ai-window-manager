import type { SqliteDatabase } from './database.js';
import type { WindowPhase, Confidence } from '../domain/types.js';

export interface ObservedWindowCycle {
  providerId: string;
  windowKind: string;
  cycleAtMs: number;
  anchoredResetAtMs: number | null;
  lastObservedAtMs: number;
  lastResetAtMs: number | null;
  phase: WindowPhase;
  phaseConfidence: Confidence;
}

export class WindowCycleRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(providerId: string, windowKind: string): ObservedWindowCycle | undefined {
    return this.db
      .prepare(
        `SELECT provider_id AS providerId, window_kind AS windowKind,
      cycle_at_ms AS cycleAtMs, anchored_reset_at_ms AS anchoredResetAtMs,
      last_observed_at_ms AS lastObservedAtMs, last_reset_at_ms AS lastResetAtMs, phase,
      phase_confidence AS phaseConfidence
      FROM observed_window_cycles WHERE provider_id = ? AND window_kind = ?`,
      )
      .get(providerId, windowKind) as ObservedWindowCycle | undefined;
  }

  upsert(cycle: ObservedWindowCycle): void {
    this.db
      .prepare(
        `INSERT INTO observed_window_cycles (
          provider_id, window_kind, cycle_at_ms, anchored_reset_at_ms,
          last_observed_at_ms, last_reset_at_ms, phase, phase_confidence
        ) VALUES (
      @providerId, @windowKind, @cycleAtMs, @anchoredResetAtMs, @lastObservedAtMs, @lastResetAtMs, @phase, @phaseConfidence
    ) ON CONFLICT(provider_id, window_kind) DO UPDATE SET
      cycle_at_ms = excluded.cycle_at_ms,
      anchored_reset_at_ms = excluded.anchored_reset_at_ms,
      last_observed_at_ms = excluded.last_observed_at_ms,
      last_reset_at_ms = excluded.last_reset_at_ms, phase = excluded.phase,
      phase_confidence = excluded.phase_confidence`,
      )
      .run(cycle);
  }
}
