# ADR-007 — Native single-operator authentication and LAN-first Compose

Status: Accepted · 2026-09-25

## Context

AI Window Manager is a self-hosted homelab service with one operator, but its
dashboard, provider state, metrics and mutation routes must not be open to
anonymous LAN clients. A reverse proxy or Tailscale should not be a prerequisite
for a normal installation. This is not a request for public internet exposure,
multi-user accounts or an identity platform.

## Decision

- Require one `AWM_AUTH_USERNAME` and one Argon2id `AWM_AUTH_PASSWORD_HASH` at
  startup. Generate the hash through the local hidden-input `pnpm auth:hash`
  command; never take the raw operator password through an environment value,
  HTTP endpoint, SQLite or logs.
- Store only high-entropy operator session token digests in bounded process
  memory. The session cookie is HttpOnly/SameSite=Strict and Secure when the
  request is HTTPS. Restart invalidates all sessions; no operator credentials
  or sessions are migrated into SQLite.
- Apply a central default-deny HTTP gate before application handlers. Only the
  minimal health endpoint, static assets and login are anonymous; logout,
  dashboard, API and metrics routes require a session. Mutations also require
  same-origin Origin and CSRF validation.
- Compose publishes `0.0.0.0` by default for trusted-LAN use. `AWM_HOST_BIND`
  can narrow the host bind. A login page does not encrypt traffic: direct HTTP
  can expose passwords and session cookies to a network observer. Operators
  must restrict access with a host firewall, avoid router port forwarding, and
  use HTTPS or a private VPN on networks they do not trust.
- Reverse proxies are optional. Forwarded protocol/client information is
  ignored unless `AWM_TRUST_PROXY` lists exact proxy source IP/CIDR entries.
  Never trust arbitrary forwarded authentication headers or all networks.

## Alternatives rejected

- Tailscale/reverse proxy as the only authentication boundary: it makes an
  optional deployment topology a requirement and leaves direct LAN access
  unauthenticated.
- PocketBase or another multi-user identity service: adds account persistence,
  roles, administration and recovery that a single-operator daemon does not
  need.
- HTTP Basic auth: repeated credential transmission, awkward logout/session
  lifecycle and less useful browser interaction than one bounded session.
- `AUTO_LOGIN`, trusted auth headers, signup, OAuth/OIDC, or no-auth mode: they
  broaden trust assumptions and are out of scope.

## Consequences

- A new installation must prepare the username and Argon2id hash before the
  first service start. Changing them requires an environment update and
  restart.
- Session state is intentionally volatile and all clients sign in again after
  restart.
- `0.0.0.0` is a host-interface bind, not a guarantee of LAN-only reachability;
  firewall configuration remains an operator responsibility.
- Direct HTTP remains available for trusted homelab networks, with its lack of
  confidentiality documented prominently.
