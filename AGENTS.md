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
- Normalized facts use explicit `EvidenceSource` and `Confidence`; `WindowSnapshot.phase` is a `Fact<WindowPhase>`, not a bare phase string.
- Capability descriptors use the separate `CapabilityContract`; trigger capabilities must explicitly declare `consumesQuota` as `true`, `false`, or `unknown`.
- Provider observations must cross the canonical `ProviderObservationSchema` boundary before downstream consumers use them.
- Never call undocumented/internal provider endpoints unless an ADR explicitly accepts the risk. The MVP should prefer official client surfaces.
- Never use extracted Antigravity credentials from a third-party client. The official Antigravity FAQ explicitly rejects third-party access with Antigravity login.
- Quota-consuming trigger gates default to enabled for configured providers; operators must be able to explicitly opt out with the environment gate or persisted monitoring-only/manual settings. Every action remains provider-capability-gated and exact-target-gated. Unsupported/unknown providers are monitor-only.
- A trigger whose outcome is uncertain must **not** be blindly retried.
- Every trigger attempt must have a persisted idempotency/dedupe key before execution.
- Only the application action executor may dispatch a provider action; HTTP handlers may create intents or reconcile hints but must never call provider actions directly.
- Action execution must atomically claim an intent, persist the result, confirm success with fresh observation when required, and classify ambiguous outcomes as `uncertain` without blind retry.
- A persisted `executing` intent recovered after restart becomes `uncertain` before any new scheduling decision.
- `succeeded` is not terminal until confirmation; retention must preserve intents that still require confirmation.
- Antigravity model-family policies are independent configuration, but trigger actions remain serialized provider-wide across scopes until prior action confirmation or safe terminal resolution.
- Provider conversations created only for AWM triggers are disposable. Persist the exact artifact ID as a cleanup job before dispatch where the protocol exposes it; retry deletion independently and never repeat a quota-consuming action because cleanup failed. Never persist transcript/response text or touch unrelated provider IDs.
- Antigravity cleanup may remove only the authorized exact conversation-ID artifacts under the isolated AWM CLI home; do not inspect/edit shared SQLite indexes, auth, keyring, or unrelated conversations, and do not automate the provider TUI.
- Provider-client updates are limited to the repository's fixed official releases, trusted published SHA-256 digests, bounded archive checks and read-only/no-quota compatibility probes. Never accept a URL/version/command from browser input or weaken the packaged fallback/rollback path.
- Runtime settings are SQLite-authoritative after bootstrap; settings forms may persist non-secret fields only and must enforce Origin plus CSRF checks.
- Interactive UI enhancements may fetch server-rendered HTML and replace explicitly marked regions, but native forms/links, server-side validation, authorization and PRG remain canonical; never add a client-side shadow of application state or retry an uncertain mutation.
- The web UI is protected by mandatory, native single-operator authentication. Do not expand this into signup, roles, public multi-user management, OAuth/OIDC, trusted-header auth or a password-reset service without a separate scope decision.
- `AWM_AUTH_USERNAME` and a validated Argon2id `AWM_AUTH_PASSWORD_HASH` are required bootstrap configuration. Generate hashes only with `pnpm auth:hash`; never accept/store raw operator passwords in env, SQLite, browser output, Git or logs.
- Keep operator sessions opaque, bounded, in-memory and invalidated on restart. Central route auth must be default-deny before page/API handlers; only the minimal health endpoint, static assets and login are public. Logout, application pages and APIs require a session. Only exact GET/HEAD `/metrics` may alternatively accept the optional dedicated technical Bearer credential, with a validated server-side digest and constant-time comparison; it grants no other authority.
- Bound operator login attempts both per source (5 failures / 5 minutes) and globally (60 failures / 5 minutes); both limiters must remain in-memory, bounded and clock-testable.
- `AWM_TRUST_PROXY` stays empty unless exact proxy source IP/CIDR entries are configured. Never trust arbitrary forwarded auth/protocol/client headers. Direct HTTP on a `0.0.0.0` LAN bind does not encrypt passwords or cookies; document host firewall/no-public-port-forwarding and recommend TLS/VPN on untrusted networks.
- Store instants in UTC. Interpret user schedules with an IANA timezone.
- Inject clocks into scheduling logic. Do not scatter `Date.now()`/`setTimeout()` through domain code.
- Reconcile state periodically instead of persisting fragile long-lived timers.
- Keep append-only history events separate from current normalized state; this is not event sourcing.
- Never log tokens, refresh tokens, cookies, authorization headers, secret paths containing secret values, or raw provider payloads by default.
- Normal tests must never spend real provider quota. Use FakeProvider and sanitized fixtures.
- Schema migrations are forward-only and must be tested on a blank DB and previous schema fixture when applicable.
- Do not weaken lint/typecheck/tests/security settings to pass validation.
- Coverage is a permanent quality gate: global lines, statements, functions, and branches must each remain at or above 90%. Do not lower thresholds, exclude relevant production code, remove tests, or skip tests to make a change pass.
- Gitleaks is a mandatory secret-scanning gate. Never disable it to accommodate a finding; fixtures and examples must use clearly synthetic values and never real credentials.
- Do not claim provider behavior, tests, CI, or deployment success without evidence.
- Authentication tests must cover anonymous route denial, same-origin/CSRF login/logout, expiry/throttling, safe post-login redirects, and restart invalidation; do not add a production auth bypass to simplify test setup.

## Canonical validation

```bash
pnpm validate
```

`pnpm validate` is the local completion gate and includes formatting, lint, strict typechecking, the 90% coverage-enforced test suite, the production build, and Gitleaks secret scanning. CI runs the equivalent quality, security, and Docker gates.

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
