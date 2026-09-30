# Changelog

## [Unreleased]

### Fixed

- Deduplicate automatic starts by the persisted observed quota cycle, not
  epoch-aligned five-hour buckets. A real expiry can plan the next start without
  allowing another heartbeat inside an already anchored, rounded-zero window.
- Require fresh window evidence after a Codex turn completes; unconfirmed
  effects remain uncertain without retrying the prompt. Surface recorded-cycle
  decisions explicitly in scheduling reads and history.

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
