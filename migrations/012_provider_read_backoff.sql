CREATE TABLE provider_read_backoff (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('reconcile', 'preflight', 'confirmation', 'resolution', 'auth_check', 'auth_verify')),
  failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 1 AND 1000000),
  not_before_ms INTEGER NOT NULL,
  failure_kind TEXT NOT NULL CHECK (failure_kind IN ('unavailable', 'auth_required', 'invalid_response')),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (provider_id, purpose)
);
