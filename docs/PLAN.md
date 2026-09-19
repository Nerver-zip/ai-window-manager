# AI Window Manager — implementation plan

Prepared: **2026-09-14**  
Scope: architecture-first repository scaffold; not a full product implementation.

## A. Executive summary

Build AI Window Manager as one small self-hosted TypeScript daemon/container. It polls provider state, normalizes multiple quota windows with explicit evidence/confidence, persists current state + bounded history in SQLite, runs a deterministic periodic reconcile scheduler, and exposes a tiny server-rendered UI, JSON API, `/metrics`, `/healthz`, and structured logs.

The hard boundary is deliberate: this is a usage-window manager, not a general AI platform. The scheduler never knows provider endpoints/auth; adapters never choose schedule policy; the UI never receives credentials.

The primary implementation strategy is to reach a vertical slice early with `FakeProvider → scheduler → SQLite → overview → Docker`, then integrate real providers behind truthful capability flags.

Provider research materially constrains the MVP. OpenAI officially documents that a new five-hour Work/Codex window starts with the first message after the prior window ends, and the official Codex open-source app-server exposes account rate-limit snapshots. A minimal normal Codex request can therefore be an opt-in quota-consuming trigger, but there is no dedicated zero-cost “start window” API. Internal backend `/api/codex/usage` paths are observed in official source but are not treated as stable public APIs.

Antigravity documents Pro/Ultra five-hour quota refresh, `/usage`, headless `agy -p`, and official keyring auth. SPIKE-002 validated a structured official headless JSON/NDJSON usage path for monitor-only parsing, but SPIKE-003 found no supported safe container auth-persistence path. Google also explicitly warns that third-party software using Antigravity login violates its Terms. The design therefore forbids token extraction/direct backend impersonation and considers only the official `agy` executable. Exact inactive-window start semantics and container keyring persistence remain UNKNOWN; Antigravity stays monitor-only/disabled until the auth boundary is resolved.

The stack is Node 24 + TypeScript + Fastify + SQLite (`better-sqlite3`) + server-rendered HTML/tiny JS + `prom-client` + Vitest + pnpm. One service/container; no Redis/Postgres/broker/React/Kubernetes. Environment owns process/bootstrap config; SQLite owns mutable runtime config; secrets live in dedicated provider-owned/mounted storage.

## B. Repository/workflow reconnaissance

Representative repositories inspected through the GitHub connector:

### `Nerver-zip/ghinfo`

Strongest analog for operating style: a tiny self-hosted service with explicit product boundary, authoritative `AGENTS.md`, reusable `.agents/skills`, canonical validation script, Docker/Compose, non-root multi-stage image, healthcheck, `cap_drop: ALL`, `no-new-privileges`, `.env.example`, CI and docs focused on invariants. Its agent instructions strongly prefer correctness, secret safety, resilience, simplicity and evidence before optimization.

### `Nerver-zip/chess-saas`

Shows the more mature agent-native workflow: root `AGENTS.md` entrypoint, `.agents/AGENTS.md`, skills/prompts, implementation plans, ADR-like documentation, pnpm/TypeScript toolchain, format/lint/typecheck/test/build validation and small vertical stories. It also demonstrates that the user's repositories benefit from explicit “stop/reconsider” rules and scope protection.

### `Nerver-zip/fisiotrack`

Shows Docker as a first-class deployment path and CI that validates Compose, builds the image and runs a smoke test in addition to language-level tests.

### Existing workflow conventions adopted

Adopt:

- root `AGENTS.md` with explicit mission/boundaries/invariants;
- `.agents/skills/`, `.agents/prompts/`, reusable conventions;
- documentation before risky provider work;
- small vertical slices and GitHub-style issue acceptance criteria;
- pnpm and a single `validate` gate;
- `.env.example`, Docker Compose, multi-stage non-root image, healthcheck;
- explicit secret/logging rules;
- CI that tests source + Docker/Compose;
- Fake/offline fixtures for external integrations.

Do **not** copy:

- `chess-saas` monorepo/Turbo structure: only one package/service is needed;
- React/SPA frontend: status/settings UI is too small;
- Redis/Postgres/worker topology: no concurrent workload requires it;
- CMake/C++ conventions from `ghinfo`: relevant design discipline, wrong language/tooling for chosen stack;
- unrelated domain-heavy documentation structure. Keep this repo compact.

## C. Provider research

Canonical detailed classification is in `docs/providers.md`; sources in `docs/research/sources.md`.

### Codex

**Supported**

- plan-dependent five-hour + weekly Work/Codex allowance;
- new five-hour window starts on first Work/Codex message after previous one ends;
- reset/allowance visible to official clients;
- official open-source app-server protocol exposes account rate-limit reads/updates.

**Observed / internal**

- official client code calls backend `/api/codex/usage` or ChatGPT `wham` usage paths and receives window duration/used/reset fields;
- these are implementation details, not a public external API contract.

**Inferred**

- an ordinary minimal official-client request can position an inactive five-hour window; it consumes quota.

**Unknown**

- exact minimum trigger cost across plans/models;
- future plan/window contract stability;
- whether a dedicated start-only operation will exist.

**Risk**

Terms prohibit circumventing rate limits/restrictions. The implementation must never create extra quota, rotate accounts, hide traffic, or auto-spend banked resets to bypass normal limits. The feature is temporal placement of legitimate allowance only.

### Antigravity

**Supported**

- Pro/Ultra five-hour baseline refresh plus weekly constraints; non-Pro/Ultra weekly baseline in current docs;
- official CLI `/usage`/`/quota` refreshes quota state and SPIKE-002 validated headless JSON/NDJSON output with quota buckets, remaining fractions and reset timestamps;
- `agy -p` is documented for non-interactive scripting;
- official auth uses system keyring/Secret Service; SSH OAuth exists.

**Observed / internal**

- quota display format is a user-facing CLI/TUI contract, not a versioned third-party JSON API.

**Inferred**

- normal headless prompts consume quota, but exact first-activity window-start semantics are not documented clearly enough to ship a trigger.

**Unknown**

- inactive-window start event;
- long-term stability of the nested machine-readable quota/reset payload;
- secure/lightweight headless keyring persistence inside this Docker design.

**Risk**

Google's official FAQ explicitly rejects third-party software using Antigravity login. Do not extract tokens or reproduce backend calls. The only considered seam is execution of Google's official CLI; even that requires a product-specific compliance/behavior spike. `canTriggerWindow=false` for MVP unless evidence materially changes.

## D. Product boundaries

Build only observation, normalized state, timing/recommendations, minimal supported actions, history, settings, metrics/health/logs and private-network UI. Explicitly exclude agent orchestration, prompt/task management, LLM routing/proxying, billing, account rotation, quota bypass, generic scheduler, public SaaS, ML/LLM recommendations and observability-platform scope.

## E. Requirements

### Functional

- configure Codex, Antigravity and FakeProvider independently;
- observe one or more quota/window buckets per provider;
- preserve source/confidence for start/reset/usage facts;
- show current state, freshness and next scheduler decision;
- manual trigger where capability permits;
- target-reset schedule;
- desired-work-window recommendation (deterministic/suggestive);
- durable action intents + history;
- small runtime settings UI;
- `/healthz`, `/metrics`, bounded history API;
- survive restart/outage/partial provider data.

### Non-functional

- one easy-to-operate container;
- secure loopback/private-network defaults;
- no secrets in image/DB/browser/logs/metrics;
- all instants UTC; IANA timezone for wall-clock schedules;
- highly deterministic time tests;
- no live quota in CI;
- graceful degradation when provider contracts change;
- low resource usage and limited dependencies;
- explicit ToS/compliance gates.

## F. Architecture alternatives

### Alternative 1 — C++23 daemon + SQLite + server-side HTML

Pros: tiny memory/image, excellent deterministic ownership/RAII, mirrors `ghinfo`, native SQLite. Cons: more integration code for JSON-RPC/CLI schemas, subprocess management, evolving external JSON, form/HTML work and rapid contract iteration. Better for a stable protocol service than a provider-adaptation-heavy early MVP.

### Alternative 2 — TypeScript/Node single daemon + Fastify + SQLite + SSR

Pros: excellent JSON/schema tooling, subprocess/API integration, time-test ergonomics, small web UI, fast agent implementation, aligns with pnpm/TypeScript conventions. One package avoids frontend/backend split. Runtime overhead is immaterial on a homelab.

### Rejected variation — TS API + React SPA + separate worker

Adds process/build/state boundaries without a requirement. A small private status/settings page does not justify it.

**Choose Alternative 2.**

## G. Architecture decision

- TypeScript, Node 24, pnpm.
- Fastify HTTP server.
- SSR HTML + small local JS; no SPA.
- `better-sqlite3` SQLite file `/data/window-manager.db`.
- Zod at configuration/provider boundaries.
- `@js-temporal/polyfill` for explicit zoned-time conversion until target Node runtime's Temporal support is intentionally adopted.
- Pino through Fastify for structured logs.
- `prom-client` for Prometheus exposition.
- Vitest.
- one service/container, one owning daemon process; official provider CLI/app-server child processes as implementation details only.

## H. Domain model

Use separate `ProviderHealth` and `WindowPhase`. A provider can be unreachable while retaining a stale last-known active window. Window phase, timestamps and ratios are `Fact<T>` values carrying evidence source + confidence + observedAt. `EvidenceSource` and `CapabilityContract` are separate concepts. Multiple window kinds are first-class; do not collapse five-hour and weekly quotas.

Key invariants are in `docs/domain.md`. Most important: persist an action intent before side effect; unique dedupe key; uncertain trigger is not retried blindly; stale/low-confidence data cannot silently authorize automation.

## I. Provider adapter design

Concrete direction:

```ts
interface ProviderAdapter {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  health(ctx: ProviderContext): Promise<ProviderHealth>;
  inspect(ctx: ProviderContext): Promise<ProviderObservation>;
  triggerWindow?(
    ctx: ProviderContext,
    request: TriggerWindowRequest,
  ): Promise<ProviderActionResult>;
}
```

Capabilities are richer than booleans:

```ts
interface ProviderCapabilities {
  usageRead: ReadCapability;
  resetRead: ReadCapability;
  windowTrigger: TriggerCapability;
}

interface ReadCapability {
  supported: boolean;
  contract: 'official_supported' | 'official_client_internal' | 'observed_undocumented' | 'unknown';
  notes?: string;
}

interface TriggerCapability extends ReadCapability {
  consumesQuota: boolean | 'unknown';
}
```

Adapter responsibilities: auth/client lifecycle, bounded transport, parsing/validation, normalization, action execution and confirmation signal description. Not scheduler policy.

Third provider procedure: add adapter + capability map + fixtures + docs/research classification + registration; no scheduler/UI special-case should be needed.

## J. Scheduler design

Periodic reconciler (default 30s) instead of durable timers. Pure `decideSchedule()` consumes `now`, policy, capabilities, current normalized observation, staleness and existing intents, then returns `noop/recommend/create_intent` plus reason object.

Target reset calculation: local desired reset occurrence → UTC instant; subtract trusted window duration. A candidate entering tolerance can create a durable intent. Execution requires a fresh preflight observation.

Duplicate prevention: unique dedupe key based on provider/action/policy/target cycle. DB transaction inserts before side effect. Repeated ticks get existing intent.

Post-dispatch timeout is `uncertain`, never a normal retry. Reconcile with provider state first.

After restart, old `executing` becomes recovery/uncertain and is inspected. A trigger missed while offline is recorded/skipped by default; no surprise late spend.

## K. Persistence

SQLite WAL, foreign keys and migrations. Concrete initial schema is `migrations/001_initial.sql`.

Tables:

- `schema_migrations`;
- `settings`;
- `providers`;
- `schedule_policies`;
- `provider_state`;
- `window_samples`;
- `events`;
- `action_intents`.

Indexes target provider/time history and open-intent queries. UTC milliseconds are used for persisted instants. JSON columns are for bounded metadata/explanation, not a substitute for queryable core fields.

Retention: raw samples/ordinary sampling events 90d, action/lifecycle/config events 365d, current state/config no TTL. Prune daily in bounded batches.

## L. Configuration model

No mutable YAML + DB conflict. Environment only owns process/bootstrap values and seeds mutable defaults once on a fresh DB. SQLite becomes authoritative for runtime/UI settings. Secrets are referenced, not stored as UI settings/DB plaintext.

Restart-required: bind/port, DB/data paths, low-level logging/startup provider executable paths. Runtime: timezone, enable/mode, polling, schedule, retention.

## M. Credentials/security

Codex: prefer dedicated official-client home/auth lifecycle. Do not mount whole `$HOME`; do not continuously copy auth files between workstation/server.

Antigravity: keyring is a blocker/spike. Do not replace secure keyring integration with token scraping. Real adapter remains unavailable if a supported container flow cannot be proven.

Threat model and HTTP mitigations are detailed in `docs/security.md`. Loopback is default. No full app auth in MVP under private-network assumption, but untrusted LAN exposure requires upstream auth or a future native auth feature. Mutations still require CSRF/Origin checks.

## N. API

Use a small `/api/v1` for UI/local inspection. Read providers/history/settings; write settings; trigger/inspect commands. Trigger handler creates a durable intent, not direct provider side effect. `/healthz` and `/metrics` stay unversioned operational endpoints.

## O. Web UI

Three small areas: Overview, Schedule, Settings/History. SSR + tiny JS. Cards show each window separately, evidence/confidence, freshness and next action explanation. No React/router/state framework. Render inferred times with `~` and labels rather than false precision.

## P. Metrics + statistics

Prometheus gauges/counters use only provider/window/bounded enum labels. No account IDs, model prompts, errors or request IDs as labels. Statistics are deterministic SQLite aggregates: per-window/day/hour consumption, window count/lifetime, trigger reliability and simple high-usage interval heuristics. No ML/LLM.

## Q. Docker/deployment

Multi-stage image, non-root UID 10001, read-only rootfs where feasible, `/tmp` tmpfs, named `/data` volume, `cap_drop: ALL`, `no-new-privileges`, healthcheck, graceful SIGTERM, `restart: unless-stopped`. Compose default publishes loopback only and remains Dockge-compatible without Dockge-specific dependencies.

## R. Repository layout

```text
ai-window-manager/
├── .agents/
│   ├── conventions/
│   ├── prompts/
│   └── skills/
├── .github/workflows/ci.yml
├── docs/
│   ├── adr/
│   ├── research/
│   ├── PLAN.md
│   ├── BACKLOG.md
│   ├── architecture.md
│   ├── providers.md
│   ├── domain.md
│   ├── scheduling.md
│   ├── persistence.md
│   ├── configuration.md
│   ├── security.md
│   ├── api.md
│   ├── ui.md
│   ├── metrics.md
│   ├── deployment.md
│   └── development.md
├── migrations/
├── src/
│   ├── domain/
│   ├── providers/
│   ├── scheduler/
│   ├── storage/
│   ├── metrics/
│   └── web/
├── tests/
├── scripts/
├── Dockerfile
├── compose.yaml
├── AGENTS.md
├── package.json
└── README.md
```

## S. Testing strategy

### Unit

- Fact/domain validation;
- pure schedule decisions;
- timezone/DST conversion;
- retry classification;
- dedupe-key generation;
- statistics.

### Storage integration

- blank migrations;
- migration from prior fixture;
- WAL/reopen/restart;
- unique dedupe under repeated insert;
- retention preserving open intents/current state.

### Provider contract

- sanitized official-client fixtures;
- partial/null/malformed/schema-changed outputs;
- auth required/429/timeout;
- no network in normal tests.

### Reconciler integration

- FakeClock + FakeProvider;
- duplicate poll;
- restart at planned/executing/post-dispatch stages;
- outage then recovery;
- delayed provider response;
- missed target;
- clock jump.

### HTTP/E2E

- overview with active/stale/unavailable states;
- settings validation;
- CSRF/cross-origin rejection;
- trigger capability denial;
- metrics labels;
- Docker smoke.

Key matrix:

| Case                           | Expected                                                            |
| ------------------------------ | ------------------------------------------------------------------- |
| 07:59, trigger target 08:00    | no action, next action explained                                    |
| 08:00 exact/high confidence    | one durable intent                                                  |
| repeated tick 08:00            | same intent, no duplicate                                           |
| trigger timeout after dispatch | uncertain, no retry                                                 |
| restart with executing trigger | inspect/recover before any new trigger                              |
| server offline 07:50–08:20     | `schedule_missed`, skip by default                                  |
| provider reset missing         | show unknown; automatic action blocked if required fact unavailable |
| DST gap                        | documented next-valid instant + adjustment event                    |
| parser format changed          | adapter degraded/unavailable, last-good retained                    |

## T. Agent workflow

Root `AGENTS.md` is authoritative. `.agents/skills` contains only repetitive project knowledge that changes execution quality: provider adapter, scheduler, time testing, Docker deployment, DB migration and release. Each specifies use case, prerequisites, procedure, files, validation, errors and DoD.

Prompts exist for one backlog issue and provider-research refresh. Do not add a skill for generic TypeScript coding; agents already know that. Skills are for project-specific invariants.

## U. ADR list

1. ADR-001 TypeScript monolith.
2. ADR-002 SQLite persistence.
3. ADR-003 capability-based provider adapter model.
4. ADR-004 periodic reconciler + persisted action intents.
5. ADR-005 configuration ownership.
6. ADR-006 official client-owned credential handling.

Six is enough; smaller implementation details belong near code/docs.

## V. Implementation roadmap

### Phase 0 — Research spikes

**Goal**: settle provider seams before real integration.  
**Components**: SPIKE-001/002/003, provider docs/fixtures.  
**Tests**: offline fixture feasibility.  
**Acceptance**: truthful capability matrices; unresolved items explicitly remain disabled.  
**Risk**: provider behavior/ToS blocks desired action. Mitigation: monitor-only is a valid product mode.

### Phase 1 — Core domain + storage foundation

**Goal**: evidence/window/capability types and durable schema.  
**Components**: domain, migrations, repositories, clock.  
**Tests**: invariants, migrations/reopen, dedupe uniqueness.  
**Acceptance**: can persist normalized fake observations/intents without HTTP.

### Phase 2 — First vertical slice with FakeProvider

**Goal**: earliest useful running daemon.  
**Components**: FakeProvider, reconcile loop read path, SQLite, overview, health/metrics, Docker.  
**Tests**: integration + container smoke.  
**Acceptance**: `docker compose up -d` displays fake active/resetting window and persists history across restart.

### Phase 3 — Scheduler/intents

**Goal**: deterministic target-reset recommendations and safe manual fake trigger.  
**Components**: decision engine, action lifecycle, time conversion/recovery.  
**Tests**: time matrix, crashes/uncertain/duplicate.  
**Acceptance**: exactly one trigger intent per target cycle; explanations persisted.

### Phase 4 — Codex monitor

**Goal**: real read-only Codex state through official client surface.  
**Components**: dedicated client state, adapter, parser/schema validation.  
**Tests**: fixture contract; optional manual live acceptance.  
**Acceptance**: current multi-window state visible; no direct internal API call from AWM.

### Phase 5 — Codex opt-in action

**Goal**: position inactive Codex window using one minimal legitimate normal request.  
**Tests**: fake unit/integration; manual live test is explicit and quota-consuming.  
**Acceptance**: persisted intent → one action → confirmation; uncertainty cannot duplicate.  
**Risk**: ToS interpretation/usage cost. Keep monitor-only toggle and document.

### Phase 6 — Antigravity monitor if feasible

**Goal**: official-CLI-only read path.  
**Acceptance**: safe auth persistence + stable parser or deliberate disabled adapter.  
**Trigger**: remains out unless separate spike succeeds.

### Phase 7 — Settings/history/stats polish

**Goal**: complete small UI/API and useful deterministic history.  
**Acceptance**: user understands current window/remaining/reset/next action/reason in seconds.

### Phase 8 — Hardening/acceptance

**Goal**: CI, Docker security, retention, docs/skills, clean install/upgrade.  
**Acceptance**: global DoD below.

Vertical-slice ordering is intentional: FakeProvider proves architecture before any quota/auth complexity.

## W. GitHub-style backlog

Canonical implementable issue bodies are in `docs/BACKLOG.md`. High-level dependency graph:

```text
CORE-001 ─┬─ CORE-002 ─┐
          ├─ SCHED-001 ├─ SCHED-002 ─ SCHED-003 ─ CODEX-002
          └─ provider adapters        │
STORAGE-001 ──────────────────────────┘

SPIKE-001 ─ CODEX-001 ─ CODEX-002
SPIKE-002 ─┐
SPIKE-003 ─┴─ ANT-001 ─ ANT-002(research only / may remain unsupported)

CORE/STORAGE/OPS/research spikes can start in parallel.
```

## X. MVP Definition of Done

- [ ] `docker compose up -d` reaches healthy state from a clean checkout/config.
- [ ] SQLite initializes/migrates automatically and survives container/host restart.
- [ ] FakeProvider exercises active/inactive/reset/failure/action-uncertain flows.
- [ ] Codex real adapter can at least monitor through an official client surface, or the exact blocking spike is documented if provider changed.
- [ ] Codex automation, if enabled, is explicit opt-in and performs only one persisted/confirmed minimal ordinary action per target cycle.
- [ ] Antigravity is available as monitor-only **only if** official-CLI auth/inspection is proven; otherwise it is explicitly `UNAVAILABLE/AUTH_REQUIRED` with no hack.
- [ ] no Antigravity trigger ships without resolved semantics/compliance evidence.
- [ ] overview shows phase, freshness, usage/remaining when known, reset with confidence, next decision and reason.
- [ ] target-reset schedule works; work-period recommendation is simple/deterministic or clearly deferred to v1.x.
- [ ] duplicate trigger protection is enforced by DB uniqueness + action lifecycle tests.
- [ ] restart/uncertain trigger recovery is tested.
- [ ] missed action during downtime is skipped/recorded by default.
- [ ] UTC/IANA/DST rules are tested.
- [ ] `/metrics` and `/healthz` work with bounded labels/no secrets.
- [ ] runtime config authority is SQLite after bootstrap; UI never exposes secrets.
- [ ] image runs non-root with hardening, no Docker socket, no whole-home mount.
- [ ] CI runs format/lint/typecheck/tests/build + Docker/Compose smoke.
- [ ] ordinary tests make no real provider requests/spend no quota.
- [ ] documentation and agent skills are consistent with code.

## Y. Risks / unknowns / spikes

### P0

- **Antigravity Terms**: third-party access warning can invalidate direct integration. Mitigation: official CLI only, monitor-only/default disabled, SPIKE-002/003; no extracted tokens.
- **Duplicate quota-affecting actions**: mitigation is durable intent + unique dedupe + uncertain state + confirmation before any retry.
- **Provider contract churn**: strict boundary validation, sanitized fixtures, last-known-good/staleness, fail closed, research refresh.

### P1

- **Codex official-client integration lifecycle/auth in headless container**: SPIKE-001.
- **Antigravity keyring/DBus in container**: SPIKE-003; don't add heavy sidecar until proven necessary and worth it.
- **Exact Antigravity window-start semantics**: ANT-002; default false.
- **Clock/DST mis-scheduling**: dedicated temporal tests + skip missed actions.

### P2

- SQLite corruption/backup errors: WAL-safe backup docs and integrity checks.
- Private-network unauthorized access: loopback default + proxy/VPN + CSRF; add native auth only if deployment threat model changes.

## Z. Future work

Natural post-MVP only:

- bounded catch-up policy for missed actions;
- third provider using the same adapter contract;
- richer deterministic usage recommendations after enough history;
- lightweight native auth if untrusted-LAN exposure becomes common;
- backup/export/import UI;
- chart polish;
- optional notification when a target is missed/provider auth expires;
- provider contract self-diagnostics/version reporting.

Explicitly still not future goals: agent orchestration, prompt management, account rotation, quota bypass, generic LLM proxy, microservices or ML.

---

## Explicit answers to the 30 required decisions

1. **Stack**: Node 24 + TypeScript + Fastify + SSR/tiny JS + SQLite + Vitest + Prometheus client; best fit for changing integrations/time tests and existing workflow.
2. **Processes**: one service/owning daemon; official provider executable child processes only as implementation details.
3. **Persistence**: SQLite, no Postgres/Redis.
4. **Window**: normalized per-provider/per-window-kind snapshot with phase and evidence-bearing facts.
5. **Estimated vs observed**: every nontrivial fact carries `source`, `confidence`, `observedAt`.
6. **State machine**: separate provider health from window phase.
7. **Scheduler**: 30s reconciler + pure decision function + durable action intents.
8. **Trigger meaning**: Codex = one minimal normal official-client request after eligibility; Antigravity = unsupported/UNKNOWN in MVP; Fake = deterministic state transition.
9. **Duplicate prevention**: DB `UNIQUE(dedupe_key)` + intent lifecycle + fresh preflight.
10. **Persist jobs/intentions**: `action_intents` table, not cron/in-memory timers.
11. **Restart**: reload state/intents, mark interrupted executing triggers uncertain, inspect before decisions.
12. **Missed trigger**: record/skip by default, expose manual trigger.
13. **Timezone/DST**: UTC instants + IANA wall schedules + explicit gap/ambiguity semantics.
14. **Credentials into container**: dedicated secret/provider-state mounts/official-client auth, never whole home/image.
15. **Credential update**: official provider login/refresh lifecycle; AWM stores references/status, not raw secret values.
16. **Official APIs**: no public Codex quota REST contract assumed; official Codex app-server/client surface is preferred. Antigravity has official CLI commands, no stable third-party quota API found.
17. **Internal behavior**: Codex `/api/codex/usage`/`wham` paths are internal/observed and avoided by default; Antigravity backend is not reverse-engineered.
18. **Detect changes**: strict parsers/schemas, fixtures, fail-closed health, `provider_contract_changed` event, research refresh.
19. **Testing without quota**: FakeProvider + FakeClock + sanitized fixtures; live tests separate/manual.
20. **Adapter interface**: capabilities + health + inspect + optional trigger action; partial normalized observations allowed.
21. **Third provider**: adapter + capabilities + fixtures + research classification + registration, no scheduler special-case.
22. **Metrics**: provider up, usage/remaining, reset seconds, age, inspect/trigger counters, decisions, intent states, last success timestamp.
23. **History**: window samples, lifecycle/action/config/provider events, intent outcomes.
24. **Retention**: samples/ordinary usage 90d; lifecycle/action/config 365d; current state no TTL.
25. **UI config**: validated forms write DB runtime settings.
26. **File + UI config**: not as competing mutable sources; env is bootstrap/process only.
27. **Authority**: SQLite after initialization.
28. **Threat model**: token/volume theft, LAN access, CSRF/XSS, container escape, supply-chain, malicious response, logs/crashes, Docker permissions; mitigations documented.
29. **Skills**: provider-adapter, scheduler, testing-time, docker-deployment, database-migration, release. Generic coding skill intentionally omitted.
30. **MVP scope**: Fake vertical slice, Codex monitor + safe opt-in trigger if spike passes, Antigravity monitor-only if official CLI path is viable, scheduler/config/history/metrics/private UI/Docker; everything broader remains out.
