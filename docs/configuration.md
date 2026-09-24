# Configuration model

Avoid two mutable configuration authorities.

## Immutable/bootstrap configuration: environment

Environment/.env/Compose controls process/container concerns:

- bind/port;
- DB path;
- log level;
- data/secret/provider-home paths;
- migration/startup behavior;
- initial provider/policy defaults (including `AWM_TIMEZONE`) **only when the
  DB is empty**;
- feature flags needed before DB access.
- provider executable paths and dedicated provider state paths;
- `AWM_AUTH_SESSION_TIMEOUT_SECONDS` (60–1800 seconds, default 900);
- `AWM_ANTIGRAVITY_ENABLED` (default `false`) to opt into the official CLI monitor;
- `AWM_ANTIGRAVITY_TRIGGER_ENABLED` (default `false`) as a separate gate for the
  experimental quota-consuming action; persisted provider mode must also be
  `automation`;
- `AWM_ANTIGRAVITY_ACTION_TIMEOUT_SECONDS` (5–120, default `30`);
- `AWM_ANTIGRAVITY_GEMINI_TRIGGER_MODEL` (default `gemini-3.8-flash-low`) and
  `AWM_ANTIGRAVITY_CLAUDE_GPT_TRIGGER_MODEL` (default `claude-sonnet-4-6`),
  each bounded to 128 characters;
- `AWM_ANTIGRAVITY_KEYRING_SECRET_FILE`, an internal mounted-file path only (not secret contents).

These generally require restart.

## Runtime configuration: SQLite

The UI/API changes non-secret product behavior in DB:

- timezone;
- providers enabled/disabled;
- monitor-only vs automation mode;
- polling intervals within safe bounds;
- activation policies (manual, auto, fixed-cycle, custom times or active hours);
- retention settings;
- provider non-secret options.

DB is authoritative after initialization.

## Secrets

Secrets are neither normal env-backed mutable settings nor DB values. Runtime settings store only a secret **reference/slot name**. Secret material lives in dedicated mounts/provider-owned secure storage.

The Antigravity keyring unlock value, if required, must be mounted as a
file below `/run/secrets` using the ignored Compose override example. The
environment variable contains only that in-container path. Keep the host file
readable by UID 10001 and protected from other host users; never put its value
in `.env` or Compose environment.

## Precedence

```text
hardcoded safe defaults
    ↓ (initial bootstrap only)
bootstrap environment
    ↓ (persist initial mutable settings once)
SQLite runtime settings = authority afterward
```

Changing `AWM_TIMEZONE` after DB initialization does not silently override a UI-configured timezone. A documented admin reset/import operation is required to re-bootstrap.

The `/settings` and `/schedule` forms are the runtime configuration path for
non-secret provider polling, timezone and activation-policy fields. A browser
may offer its IANA timezone on first use; a manual choice is then authoritative
and is never silently overwritten by later browser detection. Their writes are
validated before persistence and signal the next reconcile; environment values
remain bootstrap/process configuration and do not override existing SQLite
settings.
