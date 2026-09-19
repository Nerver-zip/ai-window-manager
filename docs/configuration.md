# Configuration model

Avoid two mutable configuration authorities.

## Immutable/bootstrap configuration: environment

Environment/.env/Compose controls process/container concerns:

- bind/port;
- DB path;
- log level;
- data/secret/provider-home paths;
- migration/startup behavior;
- initial timezone/defaults **only when the DB is empty**;
- feature flags needed before DB access.

These generally require restart.

## Runtime configuration: SQLite

The UI/API changes non-secret product behavior in DB:

- timezone;
- providers enabled/disabled;
- monitor-only vs automation mode;
- polling intervals within safe bounds;
- target reset / work-period schedules;
- retention settings;
- provider non-secret options.

DB is authoritative after initialization.

## Secrets

Secrets are neither normal env-backed mutable settings nor DB values. Runtime settings store only a secret **reference/slot name**. Secret material lives in dedicated mounts/provider-owned secure storage.

## Precedence

```text
hardcoded safe defaults
    ↓ (initial bootstrap only)
bootstrap environment
    ↓ (persist initial mutable settings once)
SQLite runtime settings = authority afterward
```

Changing `AWM_TIMEZONE` after DB initialization does not silently override a UI-configured timezone. A documented admin reset/import operation is required to re-bootstrap.
