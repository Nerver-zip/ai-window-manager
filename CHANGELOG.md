# Changelog

## Unreleased

- Architecture-first scaffold created.
- Provider research snapshot dated 2026-09-19.
- FakeProvider/domain/scheduler/storage/web seams added.
- Observation → durable intent reconciliation, last-known-good persistence,
  safe executor recovery and the pre-dispatch retry transition are validated.
- Added a persisted bounded history page with 24h/7d/30d and provider filters.
- Packaged the official Codex CLI `0.155.1` with release checksums in the
  hardened image; Codex remains disabled/read-only by default.
- SPIKE-004 remains blocked pending explicitly authorized authenticated
  lifecycle evidence; no real provider action or quota-consuming turn was run.
