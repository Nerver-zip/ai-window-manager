# AI Window Manager

Self-hosted manager for observing and deliberately positioning AI-provider usage windows.

> Status: self-hosted monitor and scheduler with supervised official-client onboarding. Codex and Antigravity quota-consuming actions are guarded by explicit environment gates; a gate-enabled fresh database defaults to automation and still requires an exact target. Antigravity's window-start effect is experimental and based on one operator-tested account/CLI path.

## Product boundary

AI Window Manager does one thing well:

```text
observe window
    ↓
normalize state
    ↓
calculate timing
    ↓
perform the smallest supported action (when allowed)
    ↓
record result
    ↓
show state, history, metrics, and configuration
```

It is **not** an agent orchestrator, LLM router, prompt manager, universal API proxy, billing platform, task manager, conversation dashboard, or multi-user SaaS.

## Architecture in one screen

```text
                     private LAN / VPN / reverse proxy
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ one Docker service                                          │
│                                                             │
│  Fastify HTTP + SSR UI ──────┐                              │
│                              │                              │
│  reconciler/scheduler ───────┼── normalized domain ─ SQLite │
│             │                │                              │
│             └─ provider adapters                            │
│                  ├─ FakeProvider                            │
│                  ├─ Codex (official client surface)         │
│                  └─ Antigravity (official CLI only; gated)  │
│                                                             │
│  /healthz        /metrics        structured logs            │
└─────────────────────────────────────────────────────────────┘
```

One application process owns state and scheduling. Official provider CLIs/app-server processes may be launched as tightly scoped child processes; they are implementation details, not independent services.

## Chosen stack

- Node.js 24 target + TypeScript.
- Fastify for the small HTTP surface.
- Server-rendered HTML + tiny browser JS; no SPA framework.
- SQLite at `/data/window-manager.db`; Codex state, Antigravity CLI state, and Antigravity keyring data use separate provider-owned volumes.
- `better-sqlite3` for a deliberately synchronous, local DB API.
- Zod for boundary/config validation.
- Prometheus text exposition through `prom-client`.
- Vitest for unit/integration tests.
- pnpm.
- one hardened Docker image / one Compose service.

See [`docs/PLAN.md`](docs/PLAN.md) for the full A–Z implementation plan and [`docs/architecture.md`](docs/architecture.md) for the shorter canonical architecture.

## Quick start: local Compose profile

Prerequisites: Node 24+, pnpm 10+, or Docker.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
pnpm auth:hash
# Paste the generated hash into AWM_AUTH_PASSWORD_HASH in .env,
# keeping it surrounded by single quotes.
docker compose up --build -d
docker compose ps
```

Choose `AWM_AUTH_USERNAME` in `.env`, generate your password hash with
`pnpm auth:hash`, and replace the example placeholder before starting the
container. The command reads the password twice without echoing it and prints
only an Argon2id PHC hash. Sign in at `http://127.0.0.1:8878/` with that
username and password at `http://<server-lan-ip>:8878/`. The host port binds
all interfaces for trusted-LAN use; direct HTTP does not encrypt the password
or session cookie. Restrict it with the server firewall and never port-forward
it from the public Internet. AWM has one local operator account; it has no
public registration or multi-user account management.

The checked-in example mirrors the local `awm` Compose profile: Codex and
Antigravity monitoring and their trigger capability gates are enabled, with
provider state kept in dedicated Docker volumes. It contains no credentials.
With those gates enabled, a fresh database seeds providers in automation mode
with a “Whenever possible” policy. The operator still chooses the exact usage
window to manage; without a target, no action is planned. Existing SQLite
choices, including an explicit monitoring-only setting, are preserved across
restarts. A trigger is a real provider request (`Hi!`) and can consume quota.
The base Compose defaults remain disabled when these variables are absent.

For source development, install dependencies and use `pnpm dev` separately;
the example's provider executable paths are container paths.

Compose publishes on `0.0.0.0` by default so trusted devices on the local
network can reach the login page. This is not a substitute for transport
encryption: direct HTTP exposes the password and session cookie to anyone able
to observe that network. Use a trusted LAN with host firewall rules, or put a
TLS reverse proxy/VPN in front; do not forward the service port from your
router to the public internet. See [deployment](docs/deployment.md) for the
network boundary and optional trusted-proxy configuration.

Keep `pnpm-lock.yaml` synchronized with `package.json`; CI and Docker builds use frozen-lockfile installation.

`pnpm validate` is the canonical local quality gate. It checks formatting, lint, type safety, tests with minimum global coverage of 90% for lines, statements, functions, and branches, the production build, and Gitleaks secret scanning. Install Gitleaks locally; CI runs the security gate on pushes and pull requests.

## Current implementation status

Included now:

- domain contracts for evidence, windows, capabilities, and provider actions;
- injectable clock;
- pure target-reset scheduler decision engine with freshness/confidence gates and explanations;
- IANA local-time occurrence resolution with deterministic DST rules and a wall/monotonic clock-jump seam;
- FakeProvider for deterministic tests and optional local UI development (`AWM_FAKE_PROVIDER_ENABLED=true`);
- SQLite schema and migration runner;
- durable provider reconciliation with last-known-good state, samples, events and deduplicated planned intents;
- safe action-intent executor with atomic claims, preflight checks, confirmation, uncertainty and restart recovery;
- health, metrics, and persisted provider overview/API (HTTP reads do not inspect providers);
- Usage page with a reset-safe daily weekly-allowance heatmap and independent
  1h/3h/6h/12h/24h/7d/30d charts;
- paginated History timeline with filters, independent of Usage visualization;
- incremental SQLite contribution intervals retained for 400 days, even though
  detailed provider samples are retained for 90 days;
- read-only command endpoints plus CSRF/Origin-protected settings and target-reset schedule forms;
- bounded retention maintenance for samples, events and terminal intent history;
- official Codex app-server adapter with offline protocol fixtures and an opt-in
  fixed `Hi!` turn;
- target-specific Antigravity `Hi!` actions through the official `agy`
  CLI, with separate Gemini and Claude/GPT model selection, fresh target-window
  confirmation, and no blind retry after ambiguous dispatch;
- supervised, in-memory Codex and Antigravity login sessions through their
  official clients, with same-origin/CSRF-protected onboarding in Settings;
- Antigravity usage adapter using the pinned official `agy` CLI; its action is
  experimental and separately gated;
- Docker/Compose hardening with pinned Codex and Antigravity clients and
  isolated state/keyring volumes;
- CI/validation scaffolding;
- provider research and compliance classification;
- ADRs, roadmap, backlog and agent skills.

Still requires separate runtime configuration or remains out of scope:

- automatic targeting on a fresh SQLite database: the enabled local profile
  starts in automation mode, but each provider still requires an exact usage
  window selection before any action can be planned;
- fresh sign-in and authenticated-state acceptance in each new deployment are
  operator-run. Existing Codex and Antigravity sessions in the local `awm`
  deployment survived container recreation/restart and resumed read-only
  observations on 2026-09-24; this is instance-specific, not a CI guarantee;
- universal guarantees about Antigravity's window-start behavior; the
  operator-tested one-account/CLI experiment is documented in
  [`SPIKE-005`](docs/research/spikes/SPIKE-005-antigravity-window-trigger.md);
- aggregate statistics and richer charting.

Those are implementation-roadmap work, not omissions from the planning deliverable.

## First commands for an implementation agent

1. Read `AGENTS.md`.
2. Read `docs/product-boundaries.md` and `docs/PLAN.md`.
3. Read the applicable `.agents/skills/*/SKILL.md`.
4. Pick one issue from `docs/BACKLOG.md` and implement the smallest vertical slice.
5. Run `pnpm validate` before completion.

## Research snapshot

Provider research was refreshed on **2026-09-19**. Provider behavior is intentionally treated as a changing external contract; see `docs/providers.md` and `docs/research/sources.md`.
