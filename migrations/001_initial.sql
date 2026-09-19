CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  mode TEXT NOT NULL DEFAULT 'monitor_only' CHECK (mode IN ('monitor_only', 'automation')),
  poll_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (poll_interval_seconds BETWEEN 30 AND 86400),
  config_json TEXT NOT NULL DEFAULT '{}',
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE schedule_policies (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'target_reset', 'work_window')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  timezone TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE provider_state (
  provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  health TEXT NOT NULL,
  observed_at_ms INTEGER,
  stale_after_ms INTEGER,
  observation_json TEXT,
  last_success_at_ms INTEGER,
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE window_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  window_kind TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  phase TEXT NOT NULL,
  started_at_ms INTEGER,
  started_source TEXT,
  started_confidence TEXT,
  reset_at_ms INTEGER,
  reset_source TEXT,
  reset_confidence TEXT,
  duration_seconds INTEGER,
  duration_source TEXT,
  duration_confidence TEXT,
  usage_ratio REAL CHECK (usage_ratio IS NULL OR (usage_ratio >= 0.0 AND usage_ratio <= 1.0)),
  remaining_ratio REAL CHECK (remaining_ratio IS NULL OR (remaining_ratio >= 0.0 AND remaining_ratio <= 1.0))
);

CREATE INDEX idx_window_samples_provider_time
  ON window_samples(provider_id, observed_at_ms DESC);
CREATE INDEX idx_window_samples_provider_kind_time
  ON window_samples(provider_id, window_kind, observed_at_ms DESC);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at_ms INTEGER NOT NULL,
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  reason_code TEXT,
  data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_events_time ON events(occurred_at_ms DESC);
CREATE INDEX idx_events_provider_time ON events(provider_id, occurred_at_ms DESC);
CREATE INDEX idx_events_type_time ON events(type, occurred_at_ms DESC);

CREATE TABLE action_intents (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  policy_id TEXT REFERENCES schedule_policies(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'executing', 'succeeded', 'confirmed', 'uncertain',
    'skipped', 'canceled', 'failed_retryable', 'failed_terminal'
  )),
  scheduled_for_ms INTEGER NOT NULL,
  not_before_ms INTEGER,
  expires_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  reason_code TEXT NOT NULL,
  explanation_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_action_intents_provider_state
  ON action_intents(provider_id, state, scheduled_for_ms);
CREATE INDEX idx_action_intents_scheduled
  ON action_intents(scheduled_for_ms, state);
