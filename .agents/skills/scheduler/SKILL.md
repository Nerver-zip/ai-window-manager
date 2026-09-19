---
name: scheduler
description: Use when changing target-reset calculations, work-window recommendations, reconcile behavior, action-intent state, missed actions, retries or duplicate prevention.
---

# Skill: scheduler

## Use when

Changing target-reset calculations, work-window recommendations, reconcile behavior, action-intent state, missed actions, retries or duplicate prevention.

## Preconditions

Read `docs/scheduling.md`, ADR-004 and current migration/schema for action intents.

## Procedure

1. Express the policy as a pure decision function first.
2. Use injected wall + monotonic clocks.
3. Model unknown/low-confidence inputs explicitly.
4. Produce an explainable decision (`reason_code` + structured inputs).
5. Persist a unique action intent before any side effect.
6. Re-inspect immediately before executing a trigger.
7. On uncertain outcome, mark `uncertain` and reconcile; do not blind-retry.
8. Add tests for restart, duplicate tick, outage, missed action and relevant DST edge.

## Files usually involved

`src/scheduler/**`, `src/domain/**`, `src/storage/**`, `tests/scheduler/**`, `docs/scheduling.md`.

## Mandatory validation

Deterministic tests with FakeClock; no sleeps. Confirm unique dedupe constraint still blocks duplicate trigger intents.

## Common errors

Using `setTimeout` as durable state, comparing local time strings directly, retrying unknown trigger outcomes, making a low-confidence estimate actionable.

## Done

Same inputs produce same decision, reason is logged/persisted, restart is safe, duplicates are impossible under repeated reconcile ticks.
