-- Evidence for an explicit unknown-outcome review when no anchored cycle ever appeared.
-- This proves only that an old attempted start is no longer actionable.
CREATE TABLE rolling_inactive_resolution_evidence (
  intent_id TEXT PRIMARY KEY REFERENCES action_intents(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  window_kind TEXT NOT NULL,
  cycle_at_ms INTEGER NOT NULL,
  outcome_recorded_at_ms INTEGER NOT NULL,
  first_observed_at_ms INTEGER NOT NULL,
  first_reset_at_ms INTEGER NOT NULL,
  last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms > first_observed_at_ms),
  last_reset_at_ms INTEGER NOT NULL CHECK (last_reset_at_ms > first_reset_at_ms),
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= last_observed_at_ms)
);
