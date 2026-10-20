-- awm:requires-foreign-keys-off
-- Rebuild only schedule_policies so old policy IDs remain valid for action intents.
CREATE TABLE schedule_policies_argon_migration (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'manual', 'auto', 'fixed', 'custom_schedule', 'active_hours',
    'target_reset', 'work_window'
  )),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  timezone TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  kind_explicit INTEGER NOT NULL DEFAULT 0 CHECK (kind_explicit IN (0, 1)),
  scope TEXT NOT NULL DEFAULT 'default'
    CHECK (scope IN ('default', 'gemini', 'claude_gpt', 'legacy', 'argon')),
  requires_review INTEGER NOT NULL DEFAULT 0 CHECK (requires_review IN (0, 1))
);

INSERT INTO schedule_policies_argon_migration (
  id, provider_id, kind, enabled, timezone, config_json, created_at_ms, updated_at_ms,
  kind_explicit, scope, requires_review
)
SELECT
  id, provider_id, kind, enabled, timezone, config_json, created_at_ms, updated_at_ms,
  kind_explicit, scope, requires_review
FROM schedule_policies;

DROP TABLE schedule_policies;
ALTER TABLE schedule_policies_argon_migration RENAME TO schedule_policies;

CREATE INDEX idx_schedule_policies_provider_scope
  ON schedule_policies(provider_id, scope);
