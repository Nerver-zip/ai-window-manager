# Development

## Prerequisites

- Node.js 24+
- pnpm 10+
- Docker for image/deployment checks

## Setup

```bash
cp .env.example .env
pnpm install  # first run creates pnpm-lock.yaml
pnpm dev
```

## Validation

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Or:

```bash
pnpm validate
```

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
