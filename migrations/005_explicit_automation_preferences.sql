ALTER TABLE providers
ADD COLUMN mode_explicit INTEGER NOT NULL DEFAULT 0 CHECK (mode_explicit IN (0, 1));

ALTER TABLE schedule_policies
ADD COLUMN kind_explicit INTEGER NOT NULL DEFAULT 0 CHECK (kind_explicit IN (0, 1));

-- A settings audit records an operator-submitted mode even if an older
-- bootstrap later rewrote the provider row. Restore the latest saved choice.
UPDATE providers
SET mode = (
  SELECT json_extract(events.data_json, '$.mode')
  FROM events
  WHERE events.provider_id = providers.id
    AND events.type = 'provider_settings_updated'
    AND json_extract(events.data_json, '$.mode') IN ('monitor_only', 'automation')
  ORDER BY events.occurred_at_ms DESC, events.id DESC
  LIMIT 1
),
mode_explicit = 1
WHERE EXISTS (
  SELECT 1
  FROM events
  WHERE events.provider_id = providers.id
    AND events.type = 'provider_settings_updated'
    AND json_extract(events.data_json, '$.mode') IN ('monitor_only', 'automation')
);

-- Only activation-policy saves include policyKind. Ignore legacy reset-policy
-- events, which have different semantics and must not be converted.
UPDATE schedule_policies
SET kind = (
  SELECT json_extract(events.data_json, '$.policyKind')
  FROM events
  WHERE events.provider_id = schedule_policies.provider_id
    AND events.type = 'schedule_policy_updated'
    AND json_extract(events.data_json, '$.policyId') = schedule_policies.id
    AND json_extract(events.data_json, '$.policyKind') IN (
      'manual', 'auto', 'fixed', 'custom_schedule', 'active_hours'
    )
  ORDER BY events.occurred_at_ms DESC, events.id DESC
  LIMIT 1
),
kind_explicit = 1
WHERE EXISTS (
  SELECT 1
  FROM events
  WHERE events.provider_id = schedule_policies.provider_id
    AND events.type = 'schedule_policy_updated'
    AND json_extract(events.data_json, '$.policyId') = schedule_policies.id
    AND json_extract(events.data_json, '$.policyKind') IN (
      'manual', 'auto', 'fixed', 'custom_schedule', 'active_hours'
    )
);
