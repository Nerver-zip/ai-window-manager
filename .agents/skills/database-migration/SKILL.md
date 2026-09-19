---
name: database-migration
description: Use when changing SQLite schema, settings ownership, history retention, indexes or action-intent persistence.
---

# Skill: database-migration

## Use when

Changing SQLite schema, settings ownership, history retention, indexes or action-intent persistence.

## Preconditions

Read `docs/persistence.md` and ADR-002/ADR-005.

## Procedure

1. Add a new numbered forward-only SQL migration; never rewrite an already-shipped migration.
2. Keep current state separate from append-only history.
3. Use UTC integer milliseconds or ISO instants consistently per schema contract.
4. Add only query-driven indexes.
5. Preserve the action-intent dedupe uniqueness invariant.
6. Test migration on blank DB and previous schema fixture.
7. Update retention/query docs if history semantics change.

## Files usually involved

`migrations/**`, `src/storage/**`, `tests/storage/**`, `docs/persistence.md`.

## Mandatory validation

Migration integration tests + restart/reopen test.

## Common errors

Storing secrets in DB, deleting history needed to reconcile an uncertain action, schema-as-event-sourcing overdesign, local-time timestamps.

## Done

Migration is forward-only, transactional where SQLite permits, tested from supported prior state, and rollback/backup implications are documented.
