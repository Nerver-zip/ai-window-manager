# AI Window Manager

Self-hosted manager for observing and deliberately positioning AI-provider usage windows.

> Status: MVP release-candidate monitor slice with an explicit, disabled-by-default Codex action path. FakeProvider remains the normal test provider.

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
- SQLite at `/data/window-manager.db`; the optional official Codex state is a separate `/codex-state` volume.
- `better-sqlite3` for a deliberately synchronous, local DB API.
- Zod for boundary/config validation.
- Prometheus text exposition through `prom-client`.
- Vitest for unit/integration tests.
- pnpm.
- one hardened Docker image / one Compose service.

See [`docs/PLAN.md`](docs/PLAN.md) for the full A–Z implementation plan and [`docs/architecture.md`](docs/architecture.md) for the shorter canonical architecture.

## Quick start: scaffold

Prerequisites: Node 24+, pnpm 10+, or Docker.

```bash
cp .env.example .env
pnpm install
pnpm validate
pnpm dev
```

Open `http://127.0.0.1:8787/`.

Docker:

```bash
docker compose up --build -d
docker compose ps
```

The Compose default publishes the service only on `127.0.0.1`. Set `AWM_HOST_BIND` deliberately for LAN/Tailscale access.

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
- Docker/Compose hardening baseline with the official Codex CLI `0.155.1` packaged and trigger execution disabled by default;
- CI/validation scaffolding;
- provider research and compliance classification;
- ADRs, roadmap, backlog and agent skills.

Intentionally **not** implemented yet:

- Antigravity real adapter;
- broad production enablement of the quota-consuming gate; one operator-authorized live `Hi!` heartbeat has been validated, but the action remains opt-in and the bounded timeout/confirmation boundary remains subject to provider-latency review;
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
