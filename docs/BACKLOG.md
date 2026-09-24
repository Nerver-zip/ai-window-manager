# GitHub-style implementation backlog

Each item is intentionally small enough for one agent. Dependencies are explicit. Items in the same parallel group may run concurrently once their dependencies are met.

## SPIKE-001 — Validate Codex app-server inspection/auth flow

**Context**: official Codex protocol exposes account rate limits; integration details must be proven in the target container model.  
**Scope**: run official Codex app-server/client in a dedicated test home, authenticate through supported flow, read rate limits, document process lifecycle and sanitized schema. No trigger.  
**Files/components**: `docs/providers.md`, `docs/research/`, `tests/fixtures/providers/codex/`, future `src/providers/codex/`.  
**Implementation notes**: do not call `/api/codex/usage` directly from AWM.  
**Acceptance**: documented reproducible read path; no workstation-home mount; exact fields/nullable behavior captured; if infeasible, adapter remains monitor-only/unavailable.  
**Tests**: sanitized offline fixture parser plan.  
**Dependencies**: none.  
**Parallel**: with SPIKE-002/003 and core-domain issues.

## SPIKE-002 — Determine Antigravity quota output contract

**Context**: official `/usage` exists, but machine-readable quota contract is unclear.  
**Scope**: test documented official CLI standalone/headless usage command; capture sanitized outputs across active/inactive/limit states if possible. No token extraction/internal endpoints.  
**Acceptance**: either a robust official-CLI inspection strategy with parser contract, or explicit `UNKNOWN`/monitor-only result.  
**Tests**: fixture parse/malformed cases if parsing is viable.  
**Dependencies**: none.

## SPIKE-003 — Prove safe Antigravity auth persistence in Linux container

**Historical result**: `NO_SUPPORTED_CONTAINER_PATH` at research time; see
`docs/research/spikes/SPIKE-003-antigravity-auth.md`. Its implementation
recommendation is superseded by the explicit project decision recorded in the
Provider Onboarding milestone below; its evidence is preserved.

**Context**: CLI uses OS keyring/DBus.  
**Scope**: determine documented/secure way to persist official CLI auth across container restarts without mounting full host home or extracting tokens.  
**Acceptance**: reproducible secure procedure or explicit decision that real Antigravity adapter cannot run in base container yet.  
**Dependencies**: none.

## Provider onboarding milestone — current implementation status

The following slices are implemented with offline/unit coverage. Live
Web-assisted login and restart reuse for Codex and Antigravity still require an
operator in the intended deployment; no live auth acceptance was run in this
implementation pass.

- **AUTH-001 / CODEX-AUTH-001 / AGY-AUTH-001**: in-memory supervised login
  sessions through official clients, bounded safe status DTOs, code forwarding
  only to the active official process, and provider-read verification. Mutations
  use Origin + CSRF checks.
- **OPS-003**: pinned `agy` runtime with separate CLI/keyring volumes, private
  D-Bus/Secret Service, non-root execution, optional mounted unlock-file secret,
  and Antigravity disabled by default.
- **AGY-001**: official headless `/usage` read-only adapter with strict
  normalization and independent Gemini / Claude-GPT quota windows.
- **WEB-004 / TEST-004**: Settings onboarding UI and offline lifecycle/runtime
  test coverage.

Antigravity quota actions are a separate, experimental, quota-consuming
capability. They remain disabled by default and require both the environment
gate and provider automation mode.

## CORE-001 — Finalize evidence/window domain types

**Scope**: implement validated domain types and invariants for facts, provider health, window phase, observations and capabilities.  
**Files**: `src/domain/**`, unit tests.  
**Acceptance**: partial windows representable; exact vs inferred data preserved; ratios validated.  
**Dependencies**: none.  
**Parallel**: STORAGE-001, OPS-001.

## CORE-002 — Expand FakeProvider scenario engine

**Scope**: configurable duration/usage/state/failures/action outcomes.  
**Files**: `src/providers/fake-provider.ts`, tests/fixtures.  
**Acceptance**: scheduler/UI can simulate inactive → active → reset and uncertain trigger without real quota.  
**Dependencies**: CORE-001.

## STORAGE-001 — Complete DB migration runner and repositories

**Scope**: migration ledger, WAL pragmas, provider state/events/window samples/settings/action-intent repositories.  
**Acceptance**: blank DB migrates; reopen preserves state; transactions cover intent creation.  
**Dependencies**: none for runner; align DTOs with CORE-001.  
**Parallel**: CORE-001.

## STORAGE-002 — Implement retention maintenance

**Status: complete (2026-09-19).**

**Scope**: bounded deletes for samples/events based on documented classes.  
**Acceptance**: current state/open intents preserved; retention test uses FakeClock.  
**Dependencies**: STORAGE-001.

## SCHED-001 — Implement pure target-reset decision engine

**Status: complete (2026-09-19).**

**Scope**: candidate trigger, confidence/staleness gates, explanation object, tolerance window.  
**Acceptance**: table tests around 07:59/08:00/08:01 example and unknown duration/reset.  
**Dependencies**: CORE-001.

## SCHED-002 — Implement durable reconcile loop

**Status: complete (2026-09-19).**

**Scope**: polling due calculation, inspections, decision call, event persistence; no real triggers yet.  
**Acceptance**: restart-safe; no `sleep` in tests; duplicate ticks produce one intent.  
**Dependencies**: STORAGE-001, SCHED-001, CORE-002.

## SCHED-003 — Implement action-intent execution/recovery

**Status: complete (2026-09-19) for the generic safe executor boundary; Antigravity's official-CLI action is tracked separately under AGY-TRIGGER-001.**

**Scope**: claim, dispatch, confirm, uncertain recovery, retry classes, missed-action skip.  
**Acceptance**: DB unique dedupe protects duplicate trigger; crash-at-each-stage integration tests.  
**Dependencies**: SCHED-002.

## WINDOW-001 — Scope an activation policy to exactly one observed window

**Status: complete.**

Each provider has one canonical `activation-${providerId}` policy. When usage
windows are available, every policy selects exactly one reported
`windowKind`; a legacy targetless manual policy remains compatible only until
the first observation, then is flagged for review. Changing the selected target
invalidates earlier open intents before dispatch. Antigravity targets
include both model family and cadence, so Gemini five-hour and Gemini weekly
are distinct from Claude/GPT five-hour and Claude/GPT weekly.

## AGY-TRIGGER-001 — Implement durable target-specific Antigravity actions

**Status: implemented with offline tests; integrated live action acceptance is pending.**

Use only the pinned official `agy` CLI with one fixed `Hi!`, the model mapped
to the exact selected quota family, a durable intent, fresh target-window
preflight/confirmation, and no blind retry after any ambiguous post-spawn
result. `AWM_ANTIGRAVITY_TRIGGER_ENABLED` defaults to false. CI uses synthetic
processes and never spends quota.

## WEB-005 — Add safe manual start controls to Overview

**Status: implemented with offline tests.**

Show a CSRF/Origin-protected form on each exact supported window only when the
provider is enabled, in automation mode, and advertises that target. Display
the selected Antigravity model and a quota warning. The form queues an intent;
the HTTP handler never inspects or dispatches a provider action.

## TIME-001 — Implement IANA local schedule conversion

**Status: complete (2026-09-19).**

**Scope**: wall-clock target occurrence, DST nonexistent/ambiguous rules, monotonic jump detection seam.  
**Acceptance**: tested on at least one spring-forward and fall-back zone plus America/Sao_Paulo normal day.  
**Dependencies**: SCHED-001.  
**Parallel**: SCHED-002 after stable interface.

## CODEX-001 — Implement Codex read-only adapter

**Status: complete (2026-09-20); offline and operator-authorized live acceptance complete.**

**Scope**: official client/app-server only, lifecycle, timeout, validated rate-limit response, normalized multi-window observation.  
**Acceptance**: monitor-only real provider works; partial/null fields degrade safely; offline contract tests.  
**Dependencies**: SPIKE-001, CORE-001.

## CODEX-002 — Implement opt-in Codex trigger

**Status: implementation and one operator-authorized live heartbeat complete (2026-09-20); read/action timeout separation and uncertain-outcome confirmation are enforced.**

**Context**: official docs say first message after prior 5h window ends starts a new window.  
**Scope**: minimal ordinary official-client turn, empty workspace/scoped permissions, persisted intent, confirmation read.  
**Acceptance**: explicit quota-consuming flag; never uses banked reset; uncertain transport result cannot blind-retry; manual live acceptance procedure documented.  
**Dependencies**: CODEX-001, SCHED-003, explicit operator enablement and live acceptance.

## ANT-001 — Implement Antigravity read-only adapter if spikes pass

**Status: adapter/runtime implementation present; offline tests pass; live authenticated restart acceptance pending.**

**Scope**: official `agy` CLI only; parser based on documented/proven output; no extracted tokens.  
**Acceptance**: health/auth states clear, parser fails closed, monitor-only.  
**Dependencies**: SPIKE-002, SPIKE-003, CORE-001.

## ANT-002 — Reassess Antigravity trigger semantics

**Status: complete with account-specific operator evidence; not a universal provider guarantee.**

An operator observed that one official `agy -p "Hi!"` turn with each family’s
configured model anchored that family’s five-hour reset. See
[`SPIKE-005`](research/spikes/SPIKE-005-antigravity-window-trigger.md). This
supports an experimental opt-in implementation, but does not establish a
dedicated start API or generalize to all accounts/versions. The capability is
`observed_undocumented`, quota-consuming, and off by default.

**Dependencies**: ANT-001. No undocumented provider endpoint or token handling.

## WEB-001 — Implement overview SSR

**Status: complete (2026-09-19).**

**Scope**: provider cards, stale/evidence labels, reset/remaining/next-decision explanation.  
**Acceptance**: works with FakeProvider and unavailable provider; no secret fields.  
**Dependencies**: CORE-001, STORAGE-001.  
**Parallel**: SCHED-001.

## WEB-002 — Implement settings/schedule forms

**Status: complete (2026-09-19).**

**Scope**: runtime DB config, validated intervals/timezone, CSRF/Origin protection.  
**Acceptance**: env does not silently override DB after bootstrap; secrets absent.  
**Dependencies**: STORAGE-001, TIME-001, SEC-001.

## WEB-003 — Implement small history view

**Status: complete (2026-09-19).**

**Scope**: bounded timeline + usage series; server-rendered/simple SVG.  
**Acceptance**: useful on mobile/desktop without SPA dependency.  
**Dependencies**: STORAGE-001.

## API-001 — Complete `/api/v1` read endpoints

**Status: complete (2026-09-19).**

**Scope**: providers/history/settings schemas and bounds.  
**Acceptance**: deterministic JSON, no secret/raw provider payload exposure.  
**Dependencies**: STORAGE-001, CORE-001.

## API-002 — Implement trigger/inspect command endpoints

**Status: complete (2026-09-19).**

**Scope**: create intent/reconcile hint; no hidden direct side effect in handler.  
**Acceptance**: CSRF/origin, capability checks, auditable event.  
**Dependencies**: SCHED-003, SEC-001.

## METRICS-001 — Complete Prometheus metrics

**Status: complete (2026-09-19).**

**Scope**: documented gauges/counters, stale behavior, bounded labels.  
**Acceptance**: no account IDs/error strings/dedupe keys as labels.  
**Dependencies**: CORE-001.  
**Parallel**: WEB work.

## STATS-001 — Deterministic usage aggregates/recommendation

**Status: partial — reset-safe weekly-allowance daily projection and Usage
heatmap delivered; recommendation analytics remain open.**

**Delivered**: persisted UTC contribution intervals, local-day projection,
quality/coverage indicators, independent history charts and 365-day Usage UI.
**Remaining scope**: per-hour aggregates and simple work-window
recommendations with explanations. No ML/LLM.
**Dependencies**: enough history schema + TIME-001 (satisfied for remaining
work).
**MVP priority**: low; recommendations may be v1.x.

## SEC-001 — HTTP hardening and CSRF

**Status: complete (2026-09-19).**

**Scope**: CSP/security headers, escaped rendering, Origin+CSRF for mutations, request limits.  
**Acceptance**: state-changing route rejects cross-origin request; provider text cannot inject HTML.  
**Dependencies**: web server baseline.

## OPS-001 — Finish production Docker hardening

**Status: complete (2026-09-19).**

**Scope**: multi-stage image, non-root, read-only rootfs, tmpfs, healthcheck, graceful shutdown, Compose loopback default.  
**Acceptance**: clean build/up healthy; restart persistence; no secret in image.  
**Dependencies**: scaffold baseline.  
**Parallel**: core domain.

## CI-001 — Complete validation + Docker smoke workflow

**Status: complete (2026-09-19).**

**Scope**: format/lint/type/test/build; Compose config; image build; health smoke.  
**Acceptance**: one canonical CI gate matches `pnpm validate`.  
**Dependencies**: OPS-001.

## DOC-001 — Reconcile docs after first vertical slice

**Status: complete (2026-09-19).**

**Scope**: architecture/provider/scheduling/deployment docs, screenshots optional.  
**Acceptance**: no plan claim contradicts code; research dates current.  
**Dependencies**: first FakeProvider vertical slice.

## OPS-002 — Package the official Codex CLI runtime

**Status: complete (2026-09-20); runtime and operator-authorized Codex acceptance complete.**

**Scope**: package a pinned official Codex release with architecture checksums,
an isolated persistent state volume and an unauthenticated app-server startup
probe. Keep Codex disabled by default and do not add trigger capability.  
**Acceptance**: runtime reports `codex-cli 0.155.1`, initializes as UID 10001,
and does not copy workstation credentials.  
**Dependencies**: SPIKE-001, Docker hardening.

## SPIKE-004 — Validate Codex window lifecycle semantics

**Status: validated with an uncertain transport boundary (2026-09-20); see `docs/research/spikes/SPIKE-004-codex-window-lifecycle.md`.**

**Scope**: determine whether official observations can distinguish an eligible
expired window and confirm a new window after one ordinary turn.  
**Result**: an operator-authorized AWM `Hi!` turn anchored the five-hour reset
in the real Codex account. AWM recorded `action_uncertain` because the response
arrived after the five-second deadline, while subsequent persisted observations
confirmed the reset remained anchored. Automatic action stays explicit opt-in;
no blind retry is allowed.
**Dependencies**: satisfied for the current explicitly authorized account;
repeat only as a controlled manual acceptance when provider behavior changes.
