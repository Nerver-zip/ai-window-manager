# Development

## Prerequisites

- Node.js 24+
- pnpm 10+
- Docker for image/deployment checks

## Setup

```bash
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
pnpm auth:hash
# Replace the placeholder AWM_AUTH_PASSWORD_HASH value in .env with the
# generated PHC value, surrounded by single quotes.
```

`.env.example` mirrors the local Docker profile and uses container-only
provider executable paths. For the application in Docker, run
`docker compose up --build -d` and sign in at `http://127.0.0.1:8878/`. The
Compose port binds all host interfaces by default; use it only on a trusted LAN,
restrict access with a firewall, and do not forward it from your router. Direct
HTTP does not encrypt passwords or session cookies. For source
development with `pnpm dev`, use the host's installed provider CLI paths and
explicitly configure the provider environment as needed; do not assume the
container paths in `.env.example` exist on the host.

## Validation

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm secret:scan
```

Or:

```bash
pnpm validate
```

`pnpm validate` is the canonical completion gate. It runs format checking, lint, strict typechecking, the coverage-enforced test suite, the build, and Gitleaks. Install Gitleaks before running it locally. `pnpm test:coverage` requires at least 90% global lines, statements, functions, and branches and writes text/LCOV reports under the ignored `coverage/` directory.

The daemon performs one initial reconcile and then one coalescing global tick.
FakeProvider is disabled in the checked-in local profile. Codex monitoring uses
`AWM_CODEX_ENABLED=true`, `AWM_CODEX_HOME=/codex-state` and
`AWM_CODEX_EXECUTABLE=/opt/codex/bin/codex` in the container. The image pins
the official Codex CLI to `0.155.1`. Quota-consuming Codex actions additionally
use the enabled `AWM_CODEX_TRIGGER_ENABLED` gate and the persisted provider mode
`automation` plus an enabled automatic policy; the action sends only the fixed
`Hi!` message. With the trigger gate enabled, a fresh database seeds automation
mode and a “Whenever possible” policy; the exact target window still must be
selected. Existing SQLite choices remain authoritative. Its app-server stages
use `AWM_CODEX_ACTION_TIMEOUT_SECONDS` (default
30 seconds; the local example sets 60), separate
from the short timeout used by read-only inspection. A post-dispatch timeout
remains uncertain and is never retried automatically.

## Development provider

Use FakeProvider. Never require a live Codex/Antigravity account for normal development or CI.

The FakeProvider supports deterministic scenario fixtures:

- configurable window duration;
- configurable inactive/active/exhausted states;
- usage progression;
- read failures and auth/unavailable states;
- succeeded/rejected/failed/uncertain trigger responses;
- reset transitions.

The FakeProvider is opt-in for manual UI development (`AWM_FAKE_PROVIDER_ENABLED=true`). Keep it disabled in a normal workspace; tests should use FakeClock and advance instantly.

Usage aggregation tests use synthetic weekly snapshots and a temporary SQLite
database. They verify positive cumulative deltas across proven weekly resets,
UTC interval persistence, saved-timezone day projection, partial-data labeling,
idempotent batch/reopen behavior, and retention beyond raw-sample expiry. The
heatmap must never derive weekly consumption from a five-hour window, call a
provider, or consume quota.

## Provider fixtures

Sanitize real official-client output before committing. Remove account IDs, user IDs, token/profile data, request IDs that could identify an account, workspace names and paths. Parser tests should be fully offline.
