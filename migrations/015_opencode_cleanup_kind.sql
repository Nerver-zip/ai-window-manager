-- Allow the OpenCode Go disposable-session cleanup artifact kind.
-- provider_cleanup_jobs is referenced by no other table, so it is rebuilt in
-- place; every existing job (and its dedupe key) is preserved unchanged.
CREATE TABLE provider_cleanup_jobs_opencode_migration (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  artifact_kind TEXT NOT NULL CHECK (
    artifact_kind IN ('codex_thread', 'antigravity_conversation', 'opencode_session')
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

INSERT INTO provider_cleanup_jobs_opencode_migration (
  id, provider_id, artifact_kind, external_id, state, attempt_count,
  not_before_ms, last_error_code, created_at_ms, updated_at_ms
)
SELECT
  id, provider_id, artifact_kind, external_id, state, attempt_count,
  not_before_ms, last_error_code, created_at_ms, updated_at_ms
FROM provider_cleanup_jobs;

DROP TABLE provider_cleanup_jobs;
ALTER TABLE provider_cleanup_jobs_opencode_migration RENAME TO provider_cleanup_jobs;

CREATE INDEX idx_provider_cleanup_due
  ON provider_cleanup_jobs(state, not_before_ms, created_at_ms);
