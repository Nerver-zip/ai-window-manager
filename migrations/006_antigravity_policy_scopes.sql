ALTER TABLE schedule_policies
ADD COLUMN scope TEXT NOT NULL DEFAULT 'default'
CHECK (scope IN ('default', 'gemini', 'claude_gpt', 'legacy'));

ALTER TABLE schedule_policies
ADD COLUMN requires_review INTEGER NOT NULL DEFAULT 0
CHECK (requires_review IN (0, 1));

CREATE INDEX idx_schedule_policies_provider_scope
  ON schedule_policies(provider_id, scope);

-- Preserve the legacy row as an inert tombstone because existing action intents
-- may still reference its ID. The new family policies are always review-gated.
UPDATE schedule_policies
SET scope = 'legacy', enabled = 0
WHERE id = 'activation-antigravity'
  AND provider_id IN (SELECT id FROM providers WHERE kind = 'antigravity');

INSERT INTO schedule_policies (
  id, provider_id, kind, kind_explicit, enabled, timezone, config_json,
  created_at_ms, updated_at_ms, scope, requires_review
)
SELECT
  'activation-antigravity-gemini',
  legacy.provider_id,
  CASE
    WHEN CASE WHEN json_valid(legacy.config_json)
      THEN json_extract(legacy.config_json, '$.windowKind') END
      IN ('antigravity_gemini_five_hour', 'antigravity_gemini_weekly')
    THEN legacy.kind ELSE 'manual'
  END,
  CASE
    WHEN CASE WHEN json_valid(legacy.config_json)
      THEN json_extract(legacy.config_json, '$.windowKind') END
      IN ('antigravity_gemini_five_hour', 'antigravity_gemini_weekly')
    THEN legacy.kind_explicit ELSE 0
  END,
  0,
  legacy.timezone,
  CASE
    WHEN CASE WHEN json_valid(legacy.config_json)
      THEN json_extract(legacy.config_json, '$.windowKind') END
      IN ('antigravity_gemini_five_hour', 'antigravity_gemini_weekly')
    THEN legacy.config_json ELSE '{}'
  END,
  legacy.created_at_ms,
  legacy.updated_at_ms,
  'gemini',
  1
FROM schedule_policies AS legacy
WHERE legacy.id = 'activation-antigravity'
  AND legacy.scope = 'legacy';

INSERT INTO schedule_policies (
  id, provider_id, kind, kind_explicit, enabled, timezone, config_json,
  created_at_ms, updated_at_ms, scope, requires_review
)
SELECT
  'activation-antigravity-claude-gpt',
  legacy.provider_id,
  CASE
    WHEN CASE WHEN json_valid(legacy.config_json)
      THEN json_extract(legacy.config_json, '$.windowKind') END
      IN ('antigravity_claude_gpt_five_hour', 'antigravity_claude_gpt_weekly')
    THEN legacy.kind ELSE 'manual'
  END,
  CASE
    WHEN CASE WHEN json_valid(legacy.config_json)
      THEN json_extract(legacy.config_json, '$.windowKind') END
      IN ('antigravity_claude_gpt_five_hour', 'antigravity_claude_gpt_weekly')
    THEN legacy.kind_explicit ELSE 0
  END,
  0,
  legacy.timezone,
  CASE
    WHEN CASE WHEN json_valid(legacy.config_json)
      THEN json_extract(legacy.config_json, '$.windowKind') END
      IN ('antigravity_claude_gpt_five_hour', 'antigravity_claude_gpt_weekly')
    THEN legacy.config_json ELSE '{}'
  END,
  legacy.created_at_ms,
  legacy.updated_at_ms,
  'claude_gpt',
  1
FROM schedule_policies AS legacy
WHERE legacy.id = 'activation-antigravity'
  AND legacy.scope = 'legacy';
