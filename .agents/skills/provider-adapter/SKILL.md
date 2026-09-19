---
name: provider-adapter
description: Use when adding a provider, changing provider inspection/action behavior, parsing provider output, or changing capability declarations.
---

# Skill: provider-adapter

## Use when

Adding a provider, changing provider inspection/action behavior, parsing provider output, or changing capability declarations.

## Preconditions

- Read `docs/providers.md`, ADR-003, ADR-006 and provider-specific source notes.
- Confirm whether the integration point is official/supportable.
- Know whether the operation consumes quota or mutates provider state.

## Procedure

1. Define capabilities before transport code.
2. Add/adjust a provider-specific observation DTO at the adapter boundary only.
3. Validate untrusted response/CLI output.
4. Normalize into domain `ProviderObservation` + evidence metadata.
5. Keep scheduling policy out of the adapter.
6. For actions, define side effects, expected confirmation signal and uncertainty behavior.
7. Add fixture-based contract tests plus malformed/partial-response tests.
8. Update `docs/providers.md` and source date when behavior changed.

## Files usually involved

`src/providers/**`, `src/domain/**` only if the generic contract truly needs change, `tests/providers/**`, `tests/fixtures/providers/**`, `docs/providers.md`.

## Mandatory validation

`pnpm test`, `pnpm typecheck`, fixture parser tests. No real quota in CI.

## Common errors

- exposing provider-specific fields to scheduler;
- inventing reset timestamps from insufficient data;
- logging raw auth/provider payloads;
- declaring an internal endpoint “official”;
- treating `trigger` as idempotent without proof.

## Done

Capabilities are truthful, partial data is represented explicitly, parser failure fails closed, tests cover malformed/changed payloads, docs/evidence are current.
