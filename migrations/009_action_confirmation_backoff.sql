ALTER TABLE action_intents
  ADD COLUMN confirmation_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (confirmation_attempt_count >= 0);

ALTER TABLE action_intents
  ADD COLUMN confirmation_not_before_ms INTEGER;
