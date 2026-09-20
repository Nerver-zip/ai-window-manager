# Persistence

## Decision

SQLite at `/data/window-manager.db`, with WAL enabled, foreign keys on, a bounded busy timeout, and forward-only SQL migrations.

SQLite fits because there is one owning daemon, low write concurrency, modest history volume, simple backup/restore, and no need for a network database. Postgres/Redis add operational failure modes without solving an MVP requirement.

## Current state vs history

- `provider_state`: one current last-known normalized state per provider.
- `window_samples`: normalized historical measurements.
- `events`: append-only human/metric history, not the source of truth for reconstructing all state.
- `action_intents`: durable side-effect state and duplicate prevention.
- `settings`/`providers`/`schedule_policies`: current runtime config.

This is **not event sourcing**.

## Retention

MVP defaults:

- `window_samples`: 90 days;
- ordinary `usage_sampled` events: 90 days;
- lifecycle/action/config/security-relevant events: 365 days;
- action intents required for current dedupe/recovery are retained at least 365 days;
- current state/config: no TTL.

A daily low-priority maintenance pass deletes eligible rows in bounded batches. No downsampling/OLAP pipeline in MVP.

Action intents use conditional SQL transitions for claim, success, uncertainty,
retryable failure, confirmation and terminal recovery. `executing` intents are
recovered as uncertain on startup; an uncertain result is never blindly retried.
The retention pass protects current state, settings, policies and open/recovery
states while pruning bounded historical classes.

## Backups

SQLite online backup or a brief application stop + copy of DB plus WAL-safe procedure. Documentation should prefer `VACUUM INTO`/SQLite backup API once implemented. Never copy only the main DB file while ignoring active WAL semantics.

## Schema and repositories

The forward-only schema currently consists of:

- `migrations/001_initial.sql` for the base current-state/history tables;
- `migrations/002_window_fact_evidence.sql` for provenance columns on every persisted window fact, including phase.

`src/storage/database.ts` applies numbered migrations transactionally, records the
applied version and timestamp in `schema_migrations`, enables WAL, foreign keys
and a bounded busy timeout, and resolves migrations from the packaged application
path rather than relying only on the process working directory.

`src/storage/repositories.ts` provides repositories for providers, current
provider state, window samples, events, settings, schedule policies and action
intents. Provider observations are validated at the persistence boundary, window
samples round-trip evidence/source/confidence metadata, and action-intent
creation uses a transaction plus the database `UNIQUE(dedupe_key)` constraint.

The reconciler writes a successful normalized observation, all of its window
samples and a bounded inspection event together. Inspection failures update
health/error metadata while retaining the previous normalized observation; no
fabricated empty observation replaces last-known-good state.
