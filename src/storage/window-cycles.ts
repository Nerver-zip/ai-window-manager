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

export interface ClosedWindowCycle {
  providerId: string;
  windowKind: string;
  cycleAtMs: number;
  endedAtMs: number;
  observedAtMs: number;
  evidenceKind: 'anchored_boundary' | 'reported_inactive_transition';
}

export class WindowCycleRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getClosure(
    providerId: string,
    windowKind: string,
    cycleAtMs: number,
  ): ClosedWindowCycle | undefined {
    return this.db
      .prepare(
        `SELECT provider_id AS providerId, window_kind AS windowKind,
      cycle_at_ms AS cycleAtMs, ended_at_ms AS endedAtMs, observed_at_ms AS observedAtMs,
      evidence_kind AS evidenceKind FROM observed_cycle_closures
      WHERE provider_id = ? AND window_kind = ? AND cycle_at_ms = ?`,
      )
      .get(providerId, windowKind, cycleAtMs) as ClosedWindowCycle | undefined;
  }

  recordClosure(closure: ClosedWindowCycle): void {
    // Store only evidence needed by unresolved side effects, bounded by intents.
    // Terminal-intent retention cascades its closure evidence instead of creating
    // an unbounded second history stream.
    this.db
      .prepare(
        `INSERT INTO observed_cycle_closures
      (intent_id, provider_id, window_kind, cycle_at_ms, ended_at_ms, observed_at_ms, evidence_kind)
      SELECT id, @providerId, @windowKind, @cycleAtMs, @endedAtMs, @observedAtMs, @evidenceKind
      FROM action_intents WHERE provider_id = @providerId
        AND state IN ('succeeded', 'uncertain')
        AND json_extract(explanation_json, '$.windowKind') = @windowKind
        AND json_extract(explanation_json, '$.observedCycleAt') = @cycleAtIso
      ON CONFLICT(intent_id) DO NOTHING`,
      )
      .run({ ...closure, cycleAtIso: new Date(closure.cycleAtMs).toISOString() });
  }

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
