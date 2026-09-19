---
name: release
description: Use when preparing a tagged release or deployment artifact.
---

# Skill: release

## Use when

Preparing a tagged release or deployment artifact.

## Preconditions

All release-target issues complete; provider research dates reviewed if provider adapters changed.

## Procedure

1. Run `pnpm validate`.
2. Build and smoke-test Docker image.
3. Verify Compose config and clean-volume bootstrap.
4. Verify upgrade from previous supported DB schema.
5. Review secrets/logging and dependency audit results.
6. Update changelog/release notes, including provider-contract risk changes.
7. Tag only after checks pass.

## Files usually involved

`CHANGELOG.md`, package metadata, docs, CI/release workflow.

## Mandatory validation

Validation + Docker smoke + migration upgrade.

## Common errors

Claiming provider support not covered by current evidence, shipping credentials/fixtures with tokens, skipping upgrade test.

## Done

Reproducible artifact, documented config/migration changes, no secrets, all release gates recorded.
