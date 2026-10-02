-- Derived internal classification; original event type/data/history are untouched.
ALTER TABLE events ADD COLUMN retention_class TEXT GENERATED ALWAYS AS (
  CASE
    WHEN lower(trim(type)) GLOB 'security_*'
      OR lower(trim(type)) GLOB 'auth_*'
      OR lower(trim(type)) GLOB 'csrf_*'
      OR lower(trim(type)) GLOB 'origin_*'
      OR lower(trim(type)) = 'provider_auth_required' THEN 'security'
    WHEN lower(trim(type)) GLOB 'action_*'
      OR lower(trim(type)) GLOB 'manual_trigger_*' THEN 'action'
    WHEN lower(trim(type)) GLOB 'provider_*'
      OR lower(trim(type)) GLOB 'scheduler_*'
      OR lower(trim(type)) GLOB 'schedule_*'
      OR lower(trim(type)) GLOB 'config_*'
      OR lower(trim(type)) GLOB 'setting_*'
      OR lower(trim(type)) GLOB 'policy_*'
      OR lower(trim(type)) IN ('inspection_failed', 'inspect_requested', 'reconcile_started', 'reconcile_finished')
      THEN 'lifecycle'
    ELSE 'ordinary'
  END
) VIRTUAL;

CREATE INDEX idx_events_retention_class_time ON events(retention_class, occurred_at_ms, id);
CREATE INDEX idx_window_samples_retention ON window_samples(observed_at_ms, id);
CREATE INDEX idx_action_intents_retention ON action_intents(state, COALESCE(finished_at_ms, updated_at_ms), id);
