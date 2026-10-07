# Changelog

## [Unreleased]

### Added

- Optional dedicated read-only Prometheus credential for exact GET/HEAD
  `/metrics`, with local random-token provisioning, server-side digest-only
  configuration and restart-based rotation. Browser/API authorization remains
  session-only; request logs omit query strings and redact credential headers.
- Private loop diagnostics, coalesced inspect hints, persisted shared provider
  read backoff, and audited unknown-outcome closure after fresh observed-cycle
  evidence, without redispatching quota-consuming actions.

### Fixed

- Update the transitive `source-map-js` dependency to `1.2.2` to address
  GHSA-68fv-2mgg-jv7q without suppressing dependency audit findings.
- Drain expired history incrementally with bounded, yielding passes instead of
  one daily batch. Add forward-only retention indexes and cached low-cardinality
  backlog/age, maintenance progress and DB/WAL size metrics. Keep unaggregated
  samples, unresolved intents and cleanup obligations protected; existing TTLs
  and the operator's idle sweep override remain unchanged.
- Revalidate deadlines and automation authorization after preflight and at the
  final Codex/Antigravity send boundary. Slow preparation, operator pause or
  runtime changes cannot authorize a late prompt; registered cleanup remains
  protected and dispatched outcomes retain their real transition timestamps.

- Deduplicate automatic starts by the persisted observed quota cycle, not
  epoch-aligned five-hour buckets. A real expiry can plan the next start without
  allowing another heartbeat inside an already anchored, rounded-zero window.
- Require fresh window evidence after a Codex turn completes; unconfirmed
  effects remain uncertain without retrying the prompt. Surface recorded-cycle
  decisions explicitly in scheduling reads and history.
- Serialize and coalesce overlapping read-only provider inspections; a
  reconciliation read started after an action may satisfy its confirmation,
  while older reads remain behind a fresh post-action barrier and persisted
  bounded confirmation backoff.
- Replace the one-second usage aggregation poll with commit-triggered bounded
  work, startup recovery and a one-minute idle fallback.

## [0.1.0] - 2026-09-27

- Added a single-operator authenticated web console for monitoring Codex and
  Antigravity usage, reviewing bounded history, and configuring exact-window
  start policies.
- Added persisted usage charts and daily weekly-allowance history, separate
  Gemini and Claude/GPT policies for Antigravity, and guided sign-in through the
  official provider clients.
- Added durable, deduplicated start intents. When enabled and configured, AWM
  sends a minimal ordinary provider request that can consume quota; uncertain
  outcomes are not blindly retried. Antigravity's observed reset effect is
  account/client-specific, not a provider guarantee.
- Pinned the official Codex CLI `0.157.1` and Antigravity CLI `1.2.12` with
  architecture-specific SHA-256 digests. Provider clients are downloaded and
  verified during the operator's local Docker build; no prebuilt image or npm
  package is distributed.
- Added bounded provider history and cleanup, in-app provider-client update
  and rollback controls, native operator authentication, and a hardened
  single-service Docker deployment.
- Upgraded Vitest and its coverage provider to patched `4.1.11`, made moderate
  dependency findings fail CI, and prepared Gitleaks, workflow lint, dependency
  review, container scanning, multi-architecture build checks, and CodeQL for
  the public-source phase.
- Licensed AWM source under MIT. Third-party provider clients, names, logos,
  and artwork remain subject to their own terms and are not relicensed by AWM.
