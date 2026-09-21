# Development

## Prerequisites

- Node.js 24+
- pnpm 10+
- Docker for image/deployment checks

## Setup

```bash
cp .env.example .env
pnpm install
pnpm dev
```

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
FakeProvider is enabled by default; Codex monitoring is opt-in through
`AWM_CODEX_ENABLED=true`, `AWM_CODEX_HOME=/codex-state` and
`AWM_CODEX_EXECUTABLE=/opt/codex/bin/codex` in the container. The image pins
the official Codex CLI to `0.155.1`. Quota-consuming Codex actions additionally
require `AWM_CODEX_TRIGGER_ENABLED=true` and the persisted provider mode
`automation`; the action sends only the fixed `Hi!` message. Its app-server
stages use `AWM_CODEX_ACTION_TIMEOUT_SECONDS` (default 30 seconds), separate
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

## Provider fixtures

Sanitize real official-client output before committing. Remove account IDs, user IDs, token/profile data, request IDs that could identify an account, workspace names and paths. Parser tests should be fully offline.
