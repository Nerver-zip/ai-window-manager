-- Expand the CHECK constraint without rewriting shipped schema or old outcomes.
CREATE TABLE action_intents_new (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  policy_id TEXT REFERENCES schedule_policies(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'executing', 'succeeded', 'confirmed', 'uncertain',
    'skipped', 'canceled', 'failed_retryable', 'failed_terminal', 'resolved_unknown'
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
  updated_at_ms INTEGER NOT NULL,
  confirmation_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_attempt_count >= 0),
  confirmation_not_before_ms INTEGER
);
INSERT INTO action_intents_new SELECT * FROM action_intents;
DROP TABLE action_intents;
ALTER TABLE action_intents_new RENAME TO action_intents;
CREATE INDEX idx_action_intents_provider_state ON action_intents(provider_id, state, scheduled_for_ms);
CREATE INDEX idx_action_intents_scheduled ON action_intents(scheduled_for_ms, state);
CREATE INDEX idx_action_intents_retention ON action_intents(state, COALESCE(finished_at_ms, updated_at_ms), id);

-- Lifecycle closure evidence is retained independently of raw history TTL.
-- It is not a claim about whether a particular prompt succeeded.
CREATE TABLE observed_cycle_closures (
  intent_id TEXT PRIMARY KEY REFERENCES action_intents(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  window_kind TEXT NOT NULL,
  cycle_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL CHECK (ended_at_ms > cycle_at_ms),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= ended_at_ms),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('anchored_boundary', 'reported_inactive_transition'))
);
CREATE INDEX idx_observed_cycle_closures_target ON observed_cycle_closures(provider_id, window_kind, cycle_at_ms);

CREATE TABLE action_resolution_requests (
  intent_id TEXT PRIMARY KEY REFERENCES action_intents(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'checked')),
  reason_code TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  checked_at_ms INTEGER
);
