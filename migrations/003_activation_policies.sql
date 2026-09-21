PRAGMA foreign_keys = OFF;

CREATE TABLE schedule_policies_new (
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
  updated_at_ms INTEGER NOT NULL
);

INSERT INTO schedule_policies_new (
  id, provider_id, kind, enabled, timezone, config_json, created_at_ms, updated_at_ms
)
SELECT id, provider_id, kind, enabled, timezone, config_json, created_at_ms, updated_at_ms
FROM schedule_policies;

DROP TABLE schedule_policies;
ALTER TABLE schedule_policies_new RENAME TO schedule_policies;

PRAGMA foreign_keys = ON;
