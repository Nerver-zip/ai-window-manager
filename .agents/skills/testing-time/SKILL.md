---
name: testing-time
description: Use when testing schedules, timers, reset inference, DST, clock jumps, downtime, backoff, or time-based retention.
---

# Skill: testing-time

## Use when

Testing schedules, timers, reset inference, DST, clock jumps, downtime, backoff, or time-based retention.

## Preconditions

Use `Clock`; never wait real minutes/hours in tests.

## Procedure

1. Use `FakeClock` with explicit UTC instants.
2. Separate wall time from monotonic elapsed time.
3. Table-test boundaries just before/at/after target.
4. Test ambiguous/nonexistent local times for an IANA zone.
5. Simulate restart by reloading persisted state in a fresh application instance.
6. Simulate provider latency/outage via FakeProvider responses.

## Files usually involved

`src/scheduler/clock.ts`, `tests/scheduler/**`, relevant storage integration tests.

## Mandatory validation

No `sleep()`/long timers in unit tests; all expected instants asserted in UTC.

## Common errors

Assuming 24h local days, hardcoding UTC offset, relying on host timezone, using `Date.now()` inside pure logic.

## Done

Boundary, DST, restart and outage cases are deterministic and fast.
