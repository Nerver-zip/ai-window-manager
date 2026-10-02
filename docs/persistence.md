# Persistence

## Decision

SQLite at `/data/window-manager.db`, with WAL enabled, foreign keys on, a bounded busy timeout, and forward-only SQL migrations.

SQLite fits because there is one owning daemon, low write concurrency, modest history volume, simple backup/restore, and no need for a network database. Postgres/Redis add operational failure modes without solving an MVP requirement.

## Current state vs history

- `provider_state`: one current last-known normalized state per provider.
- `provider_read_backoff`: at most six fixed-purpose current failure records per
  configured provider, with a shared normal-read deadline/streak and separate
  explicit-login purposes. Migration 012 creates this state without rewriting
  intents, cycle evidence, cleanup or operator preferences. Successful verified
  reads clear it; deleting a provider cascades it. It has no history TTL and holds
  no payloads, credentials or conversation content. Ephemeral single-probe login
  permits are not persisted or restored after restart.
- `observed_window_cycles`: one durable lifecycle/evidence baseline per exact
  provider window, with availability identity, last anchored reset and temporal
  comparison facts. This is current state (no TTL), independent of history
  retention and epoch-aligned scheduling timers.
- `window_samples`: normalized historical measurements.
- `usage_aggregation_checkpoint` and `usage_series_state`: incremental processing
  cursor and last-known cumulative weekly-usage baseline/high-water per provider
  window.
- `usage_intervals`: derived UTC contribution/quality intervals used to project
  daily usage in the saved timezone.
- `events`: append-only human/metric history, not the source of truth for reconstructing all state.
- `action_intents`: durable side-effect state and duplicate prevention.
  Confirmation attempts and their next eligible timestamps are persisted on the
  intent so an unresolved result is not inspected on every executor tick or
  reset to an immediate retry after restart.
- `action_resolution_requests`: one coalesced manual review request per intent,
  persisted across restart. The executor records a bounded reason and checked
  timestamp; another explicit review after failure has a 30-second cooldown.
- `observed_cycle_closures`: exact lifecycle closure evidence linked to the
  unresolved intent that needs it. This does not assert a prompt outcome;
  terminal intent retention cascades requests and closure evidence.
- `provider_cleanup_jobs`: durable deletion obligations for disposable provider
  artifacts created by AWM actions. An opaque external ID remains only until
  cleanup succeeds; it is not exposed in ordinary history, metrics or read APIs.
- `settings`/`providers`/`schedule_policies`: current runtime config.

Codex retains the canonical `activation-codex` policy. Antigravity stores two
independent policies: `activation-antigravity-gemini` and
`activation-antigravity-claude-gpt`. Each row records a family scope, an exact
normalized `windowKind`, and whether an operator review is required. Manual
action requests persist their exact target in the action intent. Changing a
saved policy changes future planning only and does not rewrite previous intents
or history.

This is **not event sourcing**.

## Retention

MVP defaults:

- `window_samples`: 90 days;
- derived `usage_intervals`: 400 days, so the annual local-calendar view survives
  the shorter raw-sample retention;
- ordinary `usage_sampled` events: 90 days;
- lifecycle/action/config/security-relevant events: 365 days;
- action intents required for current dedupe/recovery are retained at least 365 days;
- current state/config: no TTL.

Low-priority maintenance starts at bootstrap and deletes eligible rows in batches
of at most 500 per table/event class. Each pass yields between transactions and
stops after 32 batches or a 25 ms monotonic work budget. Remaining work continues
after one second; `AWM_RETENTION_INTERVAL_SECONDS` controls the idle sweep only,
so an existing daily override cannot limit backlog removal to 500 rows a day.
Concurrent requests share the active pass; shutdown stops between batches, and
restart resumes from the remaining SQL rows without a separate cleanup cursor.
After each pass, bounded index probes cache eligible backlog (up to 1,000 per
class, with a saturation flag), oldest eligible age and available DB/WAL sizes
for metrics. Scraping never starts retention or runs backlog queries.
The TTL is eligibility, not a promise of immediate deletion: cleanup can lag
during downtime or a backlog. DELETE frees reusable SQLite pages but need not
shrink the database file; no automatic blocking VACUUM is performed.

Routine `provider_inspected` events remain lifecycle history retained for 365
days. Migration 010 adds an indexed derived class without changing event data
or reducing the existing retention promise.
It will not delete a window sample until the aggregation checkpoint has passed
that sample. Adjacent equivalent zero/unknown intervals are coalesced while
preserving their covered UTC span, limiting idle-poll storage growth. Derived
intervals have no cascading foreign key to raw samples and are pruned separately
after 400 days. No downsampling/OLAP platform is used.

Action intents use conditional SQL transitions for claim, success, uncertainty,
retryable failure, confirmation and terminal recovery. `executing` intents are
recovered as uncertain on startup; an uncertain result is never blindly retried.
The retention pass protects current state, settings, policies, unresolved
provider-artifact cleanup jobs and open/recovery states while pruning bounded
historical classes. Cleanup jobs have no age-based expiry: the worker retries
idempotent deletion with bounded backoff and deletes a job immediately after
success. A provider row cannot be deleted while a cleanup obligation refers to
it. Unsupported provider cleanup is not reported as success.
Settings displays these configured defaults in a read-only summary so operators
can see how long detailed updates, daily usage history, routine and important
activity, and completed starts remain. Retention runs for paused or disconnected
providers too; it is not a per-provider TTL control.

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
- `migrations/003_activation_policies.sql` for the explicit manual/auto/fixed/
  custom-schedule/active-hours policy model and its compatibility migration.
- `migrations/004_usage_aggregation.sql` for the durable usage checkpoint,
  per-window baseline and reset-safe UTC contribution intervals.
- `migrations/005_explicit_automation_preferences.sql` for explicit opt-out
  markers, restoring the latest audited provider/schedule preference, and
  distinguishing operator choices from old bootstrap defaults.
- `migrations/006_antigravity_policy_scopes.sql` for family-scoped Antigravity
  schedules. It preserves the former row as a disabled tombstone, creates
  disabled review-gated family rows, and copies a legacy target only when its
  exact family is provable.
- `migrations/007_provider_cleanup_jobs.sql` for bounded, durable deletion
  obligations for AWM-created provider artifacts.
- `migrations/008_observed_window_cycles.sql` for observed-cycle deduplication
  and restart-safe reset evidence. Existing intents, keys and provider state
  are preserved; fresh inspections populate the new table. Back up before
  upgrading; migrations remain forward-only.
- `migrations/009_action_confirmation_backoff.sql` for per-intent confirmation
  attempt counts and restart-safe confirmation deadlines. Existing action
  outcomes and dedupe keys are preserved; prior intents begin with no recorded
  confirmation backoff.
- `migrations/010_retention_indexes.sql` for indexed event class/age, sample age
  and terminal-intent age queries. The event class is derived from its existing
  type; original payloads, intents, dedupe, cleanup and preferences are unchanged.
  Index creation runs transactionally during upgrade and may take time on large
  histories. Back up first; schema rollback requires restoring a compatible backup,
  not deleting migration records or editing shipped SQL.
- `migrations/011_unknown_action_resolution.sql` expands the intent state CHECK
  with `resolved_unknown` while preserving all existing rows and unique dedupe.
  Closure evidence is linked to an unresolved intent and survives raw-history
  pruning; terminal intent deletion cascades that evidence. It does not invent
  closure evidence for pre-migration cycles. See [ADR-008](adr/008-unknown-action-resolution.md).
- `migrations/012_provider_read_backoff.sql` for six bounded read-purpose rows
  per provider. Existing intents, cleanup, observations and preferences are
  unchanged. Normal read purposes share persisted protection across restart;
  ephemeral explicit-login probe permits are not restored.

`src/storage/database.ts` applies numbered migrations transactionally, records the
applied version and timestamp in `schema_migrations`, enables WAL, foreign keys
and a bounded busy timeout, and resolves migrations from the packaged application
path rather than relying only on the process working directory.

`src/storage/repositories.ts` provides repositories for providers, current
provider state, window samples, usage aggregation, events, settings, schedule
policies, action intents and provider cleanup jobs. Provider observations are
validated at the persistence boundary, window samples round-trip
evidence/source/confidence metadata, and action-intent creation uses a
transaction plus the database `UNIQUE(dedupe_key)` constraint.

The reconciler writes a successful normalized observation, all of its window
samples and a bounded inspection event together. Inspection failures update
health/error metadata while retaining the previous normalized observation; no
fabricated empty observation replaces last-known-good state. Policy updates are
append-audited separately and do not rewrite observation history.

The server-rendered History view queries events by UTC range in bounded pages
of 20 using the event timestamp index/order; pagination changes the read window
only and does not alter retention or append-only history semantics. A separate
Usage read service projects persisted contribution intervals into at most 365
local days and bounds chart queries to 30 days with time-bucket downsampling.
Neither page performs provider I/O or backfills during an HTTP request.
