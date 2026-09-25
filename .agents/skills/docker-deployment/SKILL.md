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
8. Keep the container listener on its private Compose network and publish the
   host port on all interfaces only because the native operator login is
   mandatory. Treat this as trusted-LAN exposure: require firewall/no public
   router forwarding and warn that direct HTTP does not encrypt credentials or
   session cookies. Set `AWM_HOST_BIND=127.0.0.1` when a local TLS proxy is used.
9. Honor forwarded headers only when `AWM_TRUST_PROXY` names exact proxy
   source IP/CIDR entries; never trust all sources.
10. Validate graceful SIGTERM and persistence across restart.

## Files usually involved

`Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`, `docs/deployment.md`.

## Mandatory validation

`docker compose config --quiet`, image build, healthcheck smoke test, restart persistence test.

## Common errors

Embedding `.env`, running as root, public internet exposure without transport
protection/firewall restrictions, broad proxy trust, making root filesystem
writable without need, adding a sidecar only to work around an adapter design
problem.

## Done

Fresh `docker compose up -d` becomes healthy with no usable credential in the
image, the app refuses startup without an operator hash, private product routes
require login, restart preserves DB and invalidates sessions, and documented
host firewall/no-public-forwarding guidance matches the all-interface Compose
bind. HTTP confidentiality limits and the optional trusted-proxy configuration
are explicit.
