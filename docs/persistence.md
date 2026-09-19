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

## Backups

SQLite online backup or a brief application stop + copy of DB plus WAL-safe procedure. Documentation should prefer `VACUUM INTO`/SQLite backup API once implemented. Never copy only the main DB file while ignoring active WAL semantics.

## Schema

See `migrations/001_initial.sql`. The schema keeps evidence for reset/start/usage facts and a unique `dedupe_key` on action intents.
