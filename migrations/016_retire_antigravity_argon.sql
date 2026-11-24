-- awm:requires-foreign-keys-off
-- Retire the independent Argon quota without rewriting historical usage or action evidence.
CREATE TEMP TABLE antigravity_quota_retirement_clock AS
SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS retired_at_ms;

INSERT INTO events (
  occurred_at_ms, provider_id, type, severity, reason_code, data_json
)
SELECT
  (SELECT retired_at_ms FROM antigravity_quota_retirement_clock),
  provider_id,
  'schedule_policy_retired',
  'warn',
  'ANTIGRAVITY_QUOTA_SCOPE_RETIRED',
  json_object(
    'policyId', id,
    'scope', scope,
    'previousKind', kind,
    'previouslyEnabled', enabled,
    'requiresReview', requires_review,
    'timezone', timezone,
    'configJson', config_json
  )
FROM schedule_policies
WHERE scope = 'argon';

CREATE TEMP TABLE antigravity_argon_intents_to_retire AS
SELECT
  intent.id,
  intent.provider_id,
  intent.policy_id,
  intent.state AS previous_state,
  intent.attempt_count,
  intent.reason_code AS previous_reason_code,
  CASE
    WHEN json_valid(intent.explanation_json)
      THEN json_extract(intent.explanation_json, '$.windowKind')
    ELSE NULL
  END AS window_kind,
  CASE
    WHEN intent.state = 'planned' AND intent.attempt_count = 0 THEN 'skipped'
    WHEN intent.state = 'failed_retryable' THEN 'failed_terminal'
    WHEN intent.state IN ('planned', 'executing', 'succeeded', 'uncertain') THEN 'resolved_unknown'
    ELSE intent.state
  END AS retired_state
FROM action_intents AS intent
WHERE intent.policy_id IN (
    SELECT id FROM schedule_policies WHERE scope = 'argon'
  )
  OR (
    intent.provider_id IN (SELECT id FROM providers WHERE kind = 'antigravity')
    AND CASE
      WHEN json_valid(intent.explanation_json)
        THEN json_extract(intent.explanation_json, '$.windowKind')
      ELSE NULL
    END GLOB 'antigravity_argon_*'
  );

-- Keep the original policy ID, action state and target in the durable intent explanation
-- before removing the policy row. Raw provider output and credentials are never copied.
UPDATE action_intents
SET
  explanation_json = CASE
    WHEN json_valid(explanation_json) THEN json_set(
      explanation_json,
      '$.retiredQuotaScope', 'argon',
      '$.retiredPolicyId', policy_id,
      '$.retiredIntentState', state,
      '$.retiredReasonCode', reason_code
    )
    ELSE json_object(
      'legacyExplanationJson', explanation_json,
      'retiredQuotaScope', 'argon',
      'retiredPolicyId', policy_id,
      'retiredIntentState', state,
      'retiredReasonCode', reason_code
    )
  END,
  policy_id = NULL
WHERE id IN (SELECT id FROM antigravity_argon_intents_to_retire);

-- Never retry an obsolete target. Unsent intents are skipped; an attempt that may
-- have crossed dispatch is retained as resolved_unknown without claiming success.
UPDATE action_intents
SET
  state = (
    SELECT retired_state
    FROM antigravity_argon_intents_to_retire AS retired
    WHERE retired.id = action_intents.id
  ),
  reason_code = CASE
    WHEN state = 'planned' AND attempt_count = 0 THEN 'ANTIGRAVITY_ARGON_SCOPE_RETIRED'
    ELSE reason_code
  END,
  finished_at_ms = CASE
    WHEN (
      SELECT retired_state
      FROM antigravity_argon_intents_to_retire AS retired
      WHERE retired.id = action_intents.id
    ) IN ('skipped', 'failed_terminal', 'resolved_unknown')
      THEN COALESCE(finished_at_ms, (SELECT retired_at_ms FROM antigravity_quota_retirement_clock))
    ELSE finished_at_ms
  END,
  updated_at_ms = (SELECT retired_at_ms FROM antigravity_quota_retirement_clock)
WHERE id IN (SELECT id FROM antigravity_argon_intents_to_retire)
  AND state <> (
    SELECT retired_state
    FROM antigravity_argon_intents_to_retire AS retired
    WHERE retired.id = action_intents.id
  );

INSERT INTO events (
  occurred_at_ms, provider_id, type, severity, reason_code, data_json
)
SELECT
  (SELECT retired_at_ms FROM antigravity_quota_retirement_clock),
  retired.provider_id,
  CASE retired.retired_state
    WHEN 'skipped' THEN 'action_skipped'
    WHEN 'failed_terminal' THEN 'action_failed_terminal'
    ELSE 'action_resolved_unknown'
  END,
  'warn',
  'ANTIGRAVITY_ARGON_SCOPE_RETIRED',
  json_object(
    'intentId', retired.id,
    'previousState', retired.previous_state,
    'retiredState', retired.retired_state,
    'previousPolicyId', retired.policy_id,
    'windowKind', retired.window_kind,
    'attemptCount', retired.attempt_count,
    'previousReasonCode', retired.previous_reason_code,
    'outcome', CASE
      WHEN retired.retired_state = 'resolved_unknown' THEN 'unknown'
      ELSE NULL
    END,
    'resolutionSource', CASE
      WHEN retired.retired_state = 'resolved_unknown' THEN 'quota_family_retired_during_upgrade'
      ELSE NULL
    END,
    'providerSerializationReleased', retired.retired_state = 'resolved_unknown'
  )
FROM antigravity_argon_intents_to_retire AS retired
WHERE retired.previous_state <> retired.retired_state;

-- Remove retired buckets from current state so old observations cannot surface as targets.
-- Historical samples, usage intervals, cycle evidence, events and cleanup jobs remain intact.
UPDATE provider_state
SET observation_json = CASE
    WHEN EXISTS (
      SELECT 1
      FROM json_each(provider_state.observation_json, '$.windows') AS window
      WHERE COALESCE(json_extract(window.value, '$.windowKind'), '') NOT GLOB 'antigravity_argon_*'
    ) THEN json_set(
        observation_json,
        '$.windows',
        json((
          SELECT json_group_array(json(window.value))
          FROM json_each(provider_state.observation_json, '$.windows') AS window
          WHERE COALESCE(json_extract(window.value, '$.windowKind'), '') NOT GLOB 'antigravity_argon_*'
        ))
      )
    ELSE json_set(
      observation_json,
      '$.windows', json('[]'),
      '$.summary', 'AGY_NO_SUPPORTED_WINDOWS'
    )
  END
WHERE provider_id IN (SELECT id FROM providers WHERE kind = 'antigravity')
  AND observation_json IS NOT NULL
  AND json_valid(observation_json)
  AND json_type(observation_json, '$.windows') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(provider_state.observation_json, '$.windows') AS window
    WHERE COALESCE(json_extract(window.value, '$.windowKind'), '') GLOB 'antigravity_argon_*'
  );

-- Rebuild the policy scope constraint forward-only. Gemini and Claude/GPT rows retain
-- their IDs and settings; Argon policies are archived above and are not transferred.
CREATE TABLE schedule_policies_retirement_migration (
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
    CHECK (scope IN ('default', 'gemini', 'claude_gpt', 'legacy')),
  requires_review INTEGER NOT NULL DEFAULT 0 CHECK (requires_review IN (0, 1))
);

INSERT INTO schedule_policies_retirement_migration (
  id, provider_id, kind, enabled, timezone, config_json, created_at_ms, updated_at_ms,
  kind_explicit, scope, requires_review
)
SELECT
  id, provider_id, kind, enabled, timezone, config_json, created_at_ms, updated_at_ms,
  kind_explicit, scope, requires_review
FROM schedule_policies
WHERE scope <> 'argon';

DROP TABLE schedule_policies;
ALTER TABLE schedule_policies_retirement_migration RENAME TO schedule_policies;

CREATE INDEX idx_schedule_policies_provider_scope
  ON schedule_policies(provider_id, scope);

DROP TABLE antigravity_argon_intents_to_retire;
DROP TABLE antigravity_quota_retirement_clock;
