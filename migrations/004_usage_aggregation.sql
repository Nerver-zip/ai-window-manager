CREATE TABLE usage_aggregation_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sample_id INTEGER NOT NULL DEFAULT 0 CHECK (last_sample_id >= 0),
  updated_at_ms INTEGER NOT NULL
);

INSERT INTO usage_aggregation_checkpoint(id, last_sample_id, updated_at_ms)
VALUES (1, 0, 0);

CREATE TABLE usage_series_state (
  provider_id TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(provider_id, window_kind)
);

CREATE TABLE usage_intervals (
  source_sample_id INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL,
  usage_delta_ratio REAL CHECK (usage_delta_ratio IS NULL OR usage_delta_ratio >= 0),
  quality TEXT NOT NULL CHECK (quality IN ('observed', 'partial', 'unknown')),
  reason_code TEXT
);

CREATE INDEX idx_usage_intervals_provider_window_time
  ON usage_intervals(provider_id, window_kind, from_ms, to_ms);

CREATE INDEX idx_usage_intervals_retention
  ON usage_intervals(to_ms);

CREATE INDEX idx_usage_intervals_provider_window_end
  ON usage_intervals(provider_id, window_kind, to_ms);
