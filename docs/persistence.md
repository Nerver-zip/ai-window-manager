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

## Backups and restore runbook

The supported MVP procedure is a short, graceful application stop followed by
a copy from the named Compose volume. Do not copy the database while the
daemon is running and do not copy only the main file if a `-wal` or `-shm`
sidecar remains after shutdown.

Create and verify a backup:

```bash
mkdir -m 700 -p backups
docker compose stop ai-window-manager
container_id="$(docker compose ps -aq ai-window-manager)"
docker compose run --rm --no-deps --user 10001:10001 \
  --entrypoint sh ai-window-manager \
  -c 'test ! -e /data/window-manager.db-wal && test ! -e /data/window-manager.db-shm'
backup="backups/window-manager-$(date -u +%Y%m%dT%H%M%SZ).db"
docker cp "$container_id:/data/window-manager.db" "$backup"
chmod 600 "$backup"
node --input-type=module -e '
  import Database from "better-sqlite3";
  const db = new Database(process.argv[1], { readonly: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  const foreignKeys = db.pragma("foreign_key_check");
  db.close();
  if (integrity !== "ok" || foreignKeys.length !== 0) {
    throw new Error(`backup verification failed: integrity=${integrity}`);
  }
' "$backup"
docker compose up -d
```

Store the resulting file outside the Docker volume with an access-controlled
retention policy. The backup contains application history and configuration,
not provider credentials. Codex state is a separate provider-owned volume and
must not be copied into an ordinary SQLite backup.

Restore only after making a separate safety copy of the current database:

```bash
docker compose stop ai-window-manager
container_id="$(docker compose ps -aq ai-window-manager)"
docker cp "$container_id:/data/window-manager.db" "${backup}.pre-restore"
docker cp "$backup" "$container_id:/data/window-manager.db.restore"
docker compose run --rm --no-deps --user 10001:10001 \
  --entrypoint sh ai-window-manager \
  -c 'cat /data/window-manager.db.restore > /data/window-manager.db && rm /data/window-manager.db.restore'
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:${AWM_HOST_PORT:-8787}/healthz
```

After restore, verify the migration version and run the same integrity checks
against the restored file. Keep `window-manager.db.pre-restore` until the
application has been inspected and the rollback decision is no longer needed.
Perform a restore drill before a public release and after migration changes.

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

The server-rendered history view queries events by UTC range in bounded pages
of 20 using the event timestamp index/order; pagination changes the read window
only and does not alter retention or append-only history semantics.
