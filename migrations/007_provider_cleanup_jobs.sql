CREATE TABLE provider_cleanup_jobs (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  artifact_kind TEXT NOT NULL CHECK (
    artifact_kind IN ('codex_thread', 'antigravity_conversation')
  ),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN ('pending', 'executing', 'retryable')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  not_before_ms INTEGER NOT NULL,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (provider_id, artifact_kind, external_id)
);

CREATE INDEX idx_provider_cleanup_due
  ON provider_cleanup_jobs(state, not_before_ms, created_at_ms);
