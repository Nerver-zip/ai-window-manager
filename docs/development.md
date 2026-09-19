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

## Development provider

Use FakeProvider. Never require a live Codex/Antigravity account for normal development or CI.

The fake should eventually support scenario fixtures:

- configurable window duration;
- inactive/active/exhausted states;
- usage progression;
- read failures/429/auth expiry;
- delayed/uncertain trigger responses;
- reset transitions.

A 30-second fake window is appropriate for manual UI development, while tests should use FakeClock and advance instantly.

## Provider fixtures

Sanitize real official-client output before committing. Remove account IDs, user IDs, token/profile data, request IDs that could identify an account, workspace names and paths. Parser tests should be fully offline.
