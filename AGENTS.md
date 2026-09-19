# Project Instructions for Agents

## Mission

Build `ai-window-manager` as a tiny, self-hosted daemon that understands AI usage windows extremely well. It observes provider quota state, normalizes uncertain timing information, makes deterministic scheduling decisions, performs only explicitly supported/minimal actions, records history, and exposes a small private-network UI plus metrics.

## Product boundary

This repository is **not** an agent orchestrator, prompt manager, LLM router/proxy, conversation dashboard, generic task scheduler, billing system, account rotator, anti-rate-limit tool, or multi-user SaaS.

If a proposed change broadens the product beyond usage-window observation/timing, stop and require an explicit scope decision.

## Priority order

1. Provider/account safety and Terms-of-Service compliance.
2. Correctness of window state and timing.
3. Duplicate-action prevention.
4. Secret safety.
5. Explainability of scheduler decisions.
6. Testability and resilience.
7. Operational simplicity.
8. UI polish.

## Before changing files

1. Read `README.md`.
2. Read `docs/product-boundaries.md`, `docs/architecture.md`, `docs/providers.md`, and the relevant ADRs.
3. Read the issue/backlog item being implemented.
4. Read the smallest applicable `.agents/skills/<skill>/SKILL.md` set.
5. Inspect code, tests, migrations, and provider fixtures before assuming behavior.
6. State observable acceptance criteria before non-trivial changes.

## Mandatory engineering rules

- Target Node.js 24 and TypeScript; use pnpm.
- Keep a single deployable service/container.
- The scheduler must never know provider-specific HTTP endpoints, token formats, or CLI flags.
- The UI must never receive provider credentials.
- Provider adapters normalize observations; they do not choose scheduling policy.
- External-provider responses are untrusted input and must be validated.
- Never call undocumented/internal provider endpoints unless an ADR explicitly accepts the risk. The MVP should prefer official client surfaces.
- Never use extracted Antigravity credentials from a third-party client. The official Antigravity FAQ explicitly rejects third-party access with Antigravity login.
- `trigger` is opt-in and provider-capability-gated. Unsupported/unknown providers are monitor-only.
- A trigger whose outcome is uncertain must **not** be blindly retried.
- Every trigger attempt must have a persisted idempotency/dedupe key before execution.
- Store instants in UTC. Interpret user schedules with an IANA timezone.
- Inject clocks into scheduling logic. Do not scatter `Date.now()`/`setTimeout()` through domain code.
- Reconcile state periodically instead of persisting fragile long-lived timers.
- Keep append-only history events separate from current normalized state; this is not event sourcing.
- Never log tokens, refresh tokens, cookies, authorization headers, secret paths containing secret values, or raw provider payloads by default.
- Normal tests must never spend real provider quota. Use FakeProvider and sanitized fixtures.
- Schema migrations are forward-only and must be tested on a blank DB and previous schema fixture when applicable.
- Do not weaken lint/typecheck/tests/security settings to pass validation.
- Do not claim provider behavior, tests, CI, or deployment success without evidence.

## Canonical validation

```bash
pnpm validate
```

Container changes additionally require:

```bash
docker compose config --quiet
docker build -t ai-window-manager:dev .
```

For runtime/Compose work, run the smoke test described in `docs/deployment.md`.

## Skills

Use the smallest relevant set:

- `provider-adapter`: adding/changing a provider adapter or provider capabilities.
- `scheduler`: timing semantics, dedupe, missed actions, confidence gating.
- `testing-time`: clocks, DST, restart, outage and deterministic time tests.
- `docker-deployment`: image, Compose, persistence, health, secrets, hardening.
- `database-migration`: schema/config/history changes.
- `release`: release readiness and changelog/versioning.

## Completion format

Report:

- summary and files changed;
- acceptance criteria satisfied;
- commands executed and actual outcomes;
- DB/config/public-API impact;
- provider/TOS implications;
- secret/security impact;
- remaining risks and intentionally deferred work.

## Stop and reconsider when

- a provider integration needs token scraping, account rotation, rate-limit bypass, or undocumented auth replay;
- an adapter starts choosing schedule policy;
- a handler synchronously performs an expensive provider action without a persisted intent;
- a transient failure would erase last-known-good state;
- a trigger might be repeated because confirmation failed;
- a wall-clock/DST assumption is not explicit;
- a secret could enter logs, metrics, browser responses, Git, image layers, or crash diagnostics;
- Redis/Postgres/message broker/microservices/React/Kubernetes are proposed without a new requirement that justifies them;
- a quality gate must be weakened to finish the task.
