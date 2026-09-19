# ADR-001 — TypeScript monolith

Status: Accepted for MVP

## Context

The service is integration/time-policy heavy, not compute heavy. The owner uses both C++ and TypeScript and has mature patterns for each.

## Decision

Use Node.js 24 + TypeScript + Fastify in one package/process/container. Use SSR/tiny JS rather than a SPA framework.

## Alternatives

- C++23 + httplib/crow/sqlite: excellent footprint, but more ceremony for changing external schemas, CLI subprocess integration and web forms.
- TypeScript API + React SPA: familiar but unnecessary frontend boundary/build complexity.

## Consequences

Fast provider adaptation and tests; larger runtime than C++ but still trivial for a homelab. No monorepo/turbo until the repository actually has multiple packages.
