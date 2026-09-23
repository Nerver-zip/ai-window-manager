# Changelog

## Unreleased

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
  hardened image; Codex remains disabled/read-only by default.
- Added the opt-in official Codex app-server action path: ephemeral read-only
  thread, fixed `Hi!` turn, completion confirmation and no blind retry after
  uncertain transport outcomes. The trigger gate remains disabled by default;
  authenticated live acceptance is still pending.
