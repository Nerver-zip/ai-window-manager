# MVP release audit

**Audit date:** 2026-09-19/20  
**Scope:** Docker/runtime, CI, documentation, API contract, backup/restore,
dependency/security posture and release evidence for the monitor MVP with an
opt-in Codex action path.

## Executive status

| Area                               | Status                                     | Evidence                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPS-001 Docker hardening           | **COMPLETE**                               | Compose config/build, healthy runtime, non-root/read-only/cap-drop/no-new-privileges inspection, restart and stop/start smoke passed.                                   |
| OPS-002 Codex runtime              | **COMPLETE**                               | Official `rust-v0.155.1` package, architecture checksum, UID 10001 and unauthenticated app-server initialize probe passed.                                              |
| CI-001 validation and Docker smoke | **COMPLETE locally; remote pending**       | `pnpm validate`, `actionlint`, Gitleaks and Docker checks passed locally; CI workflow now exercises Compose hardening and persistence. No new GitHub run was triggered. |
| DOC-001 documentation              | **COMPLETE**                               | README, plan, backlog, API, deployment, persistence, security, providers, UI, testing and changelog reconciled.                                                         |
| API contract                       | **COMPLETE**                               | Current route inventory is documented; nonexistent `PUT /api/v1/settings` was removed from the current contract; `/history` is implemented.                             |
| Backup/restore                     | **COMPLETE for MVP runbook**               | WAL-safe stop/copy, integrity checks, schema version check and a disposable Compose restore drill passed.                                                               |
| Dependency/security posture        | **PARTIAL**                                | Production audit is clean and Gitleaks passes; two moderate development-tool advisories remain for a future dependency upgrade.                                         |
| MVP release classification         | **MONITOR-ONLY + OPT-IN ACTION CANDIDATE** | No generic reliability blocker remains in the locally validated tree. Codex action is implemented but remains disabled by default pending live acceptance.              |

## Validation evidence

The current local HEAD contains the sprint commits through the runtime,
history, lifecycle research and quality fixes. The pre-existing `.ai-jail`
working-tree change was not staged or modified.

The repository reports Node `v26.9.0` locally, while the project and CI target
Node 24. The Docker build uses Node 24 and passed; local validation uses the
declared pnpm `10.15.0` lockfile.

## OPS-001 and OPS-002

The final image builds from a multi-stage Dockerfile, runs as `10001:10001`,
uses a read-only root filesystem, `/tmp` tmpfs, `cap_drop: ALL`,
`no-new-privileges:true`, a real healthcheck and `restart: unless-stopped` in
Compose. Runtime mounts are limited to `/data` and the separate `/codex-state`
volume.

The official Codex CLI `0.155.1` is packaged from the architecture-specific
`openai/codex` release archive. The Dockerfile verifies the pinned SHA-256 for
amd64 and arm64 and exposes `/opt/codex/bin/codex`. The focused validator ran
inside the image as UID 10001 and proved version output plus app-server
`initialize` with a disposable empty `CODEX_HOME`.

No login, account, token, turn, reset-credit operation or quota-consuming
action was performed during this audit. Codex remains disabled by default; the
opt-in action path is covered offline and awaits live authenticated acceptance.

## CI-001 and security

The workflow keeps `contents: read`, uses frozen pnpm installation, runs
format/lint/typecheck/tests/coverage/build, installs pinned Gitleaks `8.30.1`
with a checksum, and validates Compose plus a hardened Compose runtime smoke.
`actionlint` passed locally. No remote GitHub Actions run was triggered for the
new local commits.

The local canonical gate passed after the opt-in action-path tests were added:

```text
27 test files / 241 tests
Statements: 97.04%
Branches:   90.15%
Functions:  97.00%
Lines:      97.04%
```

`pnpm secret:scan` scanned 30 commits and reported no leaks. Production
dependencies report no known vulnerabilities. A full audit still reports two
moderate advisories in development-only Vitest tooling; they are recorded as a
future upgrade risk and were not hidden or suppressed.

## API and UI

The current routes are:

```text
GET  /healthz
GET  /metrics
GET  /
GET  /settings
GET  /schedule
GET  /history
GET  /api/v1/providers
GET  /api/v1/providers/:id
GET  /api/v1/history
GET  /api/v1/settings
POST /settings/providers/:id
POST /schedule
POST /api/v1/providers/:id/inspect
POST /api/v1/providers/:id/trigger
```

Read paths use persisted repositories and do not call provider inspection. The
history page bounds events and usage samples, supports `24h`/`7d`/`30d` and a
provider filter, escapes event labels/reasons and renders missing values as
`unknown`.

## Backup/restore

`docs/persistence.md` now contains an operator runbook that stops the daemon,
checks for WAL sidecars, copies the SQLite file, verifies
`integrity_check`/`foreign_key_check` and schema version, preserves a
pre-restore copy and restores in place while preserving the runtime file
ownership.

The disposable Compose project `awm-drill` completed this procedure with:

```text
integrity: ok
foreign_key_check: 0 rows
schema version: 2
history events before/after restore: 1/1
/healthz after restore: 200
```

The disposable project and its volumes were removed with `down --volumes`.

## SPIKE-004 and release boundary

The unauthenticated official app-server probe initialized successfully, then
reported `account: null`, `requiresOpenaiAuth: true`, and an authentication
error for `account/rateLimits/read`. No authenticated before/after lifecycle
pair was available and no live turn was performed during this audit. SPIKE-004
remains classified `BLOCKED` as an evidence record, while the separately
authorized opt-in implementation now uses reset-time phase inference and the
official `thread/start`/`turn/start` lifecycle. The trigger gate remains off by
default.

## Remaining risks

- authenticated Codex read acceptance remains a documented manual procedure;
- authenticated Codex action acceptance remains pending;
- two moderate development-only Vitest advisories need a future dependency
  upgrade decision;
- remote GitHub Actions for the new local commits have not been run because the
  commits were not pushed.

This audit does not authorize default-on quota automation or a public release.
It establishes the locally reproducible monitor baseline and the separately
gated Codex action boundary.
