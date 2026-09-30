-- Current lifecycle evidence, independent of wall-clock schedule buckets/history TTL.
CREATE TABLE observed_window_cycles (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  window_kind TEXT NOT NULL,
  cycle_at_ms INTEGER NOT NULL,
  anchored_reset_at_ms INTEGER,
  last_observed_at_ms INTEGER NOT NULL,
  last_reset_at_ms INTEGER,
  phase TEXT NOT NULL CHECK (phase IN ('ACTIVE', 'INACTIVE', 'EXHAUSTED', 'UNKNOWN', 'RESET_DUE')),
  phase_confidence TEXT NOT NULL CHECK (phase_confidence IN ('exact', 'high', 'medium', 'low', 'unknown')),
  PRIMARY KEY (provider_id, window_kind)
);
