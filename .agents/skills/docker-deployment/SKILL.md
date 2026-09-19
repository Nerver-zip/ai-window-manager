---
name: docker-deployment
description: Use when changing Dockerfile, Compose, ports, volumes, healthchecks, provider CLI packaging, secrets or runtime permissions.
---

# Skill: docker-deployment

## Use when

Changing Dockerfile, Compose, ports, volumes, healthchecks, provider CLI packaging, secrets or runtime permissions.

## Preconditions

Read `docs/deployment.md`, `docs/security.md`, ADR-006.

## Procedure

1. Keep one application service.
2. Use multi-stage image and non-root runtime.
3. Never COPY secrets/auth directories into image layers.
4. Keep persistent writable path constrained to `/data` (and only provider-specific state paths explicitly documented).
5. Drop all Linux capabilities and set `no-new-privileges`.
6. Do not mount Docker socket.
7. Validate healthcheck tests application + DB readiness, not just process existence.
8. Default host publication to loopback.
9. Validate graceful SIGTERM and persistence across restart.

## Files usually involved

`Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`, `docs/deployment.md`.

## Mandatory validation

`docker compose config --quiet`, image build, healthcheck smoke test, restart persistence test.

## Common errors

Embedding `.env`, running as root, binding publicly by default, making root filesystem writable without need, adding a sidecar only to work around an adapter design problem.

## Done

Fresh `docker compose up -d` becomes healthy with no credential in image/config output, restart preserves DB, and default exposure is private.
