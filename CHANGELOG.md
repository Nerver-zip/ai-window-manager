# Changelog

## Unreleased

- The local `.env.example` now mirrors the `awm` Compose profile, including
  Codex and Antigravity trigger capability gates; fresh SQLite settings still
  require explicit provider automation and activation-policy configuration.
- Schedule provider selection now loads that provider's saved policy through a
  read-only GET; switching providers does not save changes, and remains usable
  without JavaScript.
- Fixed same-origin form submissions in Chrome sending `Origin: null` by using
  `Referrer-Policy: same-origin` while retaining cross-origin referrer
  suppression and Origin/CSRF enforcement.
- Architecture-first scaffold created.
- Provider research snapshot dated 2026-09-19.
- FakeProvider/domain/scheduler/storage/web seams added.
- Observation → durable intent reconciliation, last-known-good persistence,
  safe executor recovery and the pre-dispatch retry transition are validated.
- Added a persisted bounded history page with 24h/7d/30d and provider filters.
- Packaged the official Codex CLI `0.155.1` with release checksums in the
  hardened image; the base environment default is off and the local example
  explicitly enables monitoring.
- Added the opt-in official Codex app-server action path: ephemeral read-only
  thread, fixed `Hi!` turn, completion confirmation and no blind retry after
  uncertain transport outcomes. The local example enables the capability gate,
  while SQLite automation settings remain a separate requirement. Operator-
  authorized live acceptance is documented in the provider research notes.
