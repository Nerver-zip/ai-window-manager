# OPS-002 — Codex runtime packaging

> Historical runtime investigation for Codex 0.155.1. The current source pin is
> recorded in `provider-clients.lock.json`; retain this report for its original
> evidence rather than treating its version/default statements as current.

## Scope

This report validates the official Codex executable in the Linux container
runtime. It does not change the Codex provider, enable authentication, or
enable quota-affecting actions.

## Distribution decision

The floating official installer (`curl .../install.sh`) is not used in the
Dockerfile. The reproducible path is the official `rust-v0.155.1` GitHub
release package published by `openai/codex`:

```text
codex-package-x86_64-unknown-linux-musl.tar.gz
codex-package-aarch64-unknown-linux-musl.tar.gz
```

The Dockerfile selects the package from BuildKit's target architecture and
verifies the pinned SHA-256 before extraction:

```text
x86_64: a65b895c6ac1a73629bbe4b864640c86133e94a43b4d67b3103044e1a306d5a2
arm64:  71857dbc9bea3613410e8a69cfb46b07c0402d6d20fec18843dbaffd757634bd
```

The release's `codex-package_SHA256SUMS` was used to obtain these values.
The extracted package reports `codex-cli 0.155.1` and contains the official
`bin/codex`, resources, and `codex-package.json` metadata. The package binary
is a static PIE Linux executable.

The official npm package `@openai/codex@0.155.1` was also inspected locally
and reports the same CLI version, but the release package was selected for the
image because it is a self-contained, architecture-specific artifact with an
explicit release checksum and no dependency-resolution step in the runtime
image.

## Runtime layout

```text
/opt/codex/bin/codex  pinned executable, image-owned and non-writable
/data                AWM SQLite volume
/codex-state         dedicated official Codex state volume
```

The Compose default is:

```text
AWM_CODEX_ENABLED=false
AWM_CODEX_EXECUTABLE=/opt/codex/bin/codex
AWM_CODEX_HOME=/codex-state
```

The image remains non-root (`10001:10001`), uses a read-only root filesystem,
and only `/data`, `/codex-state`, and `/tmp` are writable. No auth file, token,
cookie, or workstation home is copied into the image. Authentication remains
owned by the official Codex client and must be performed separately by an
operator using the dedicated state volume.

## Validation procedure

The dedicated `scripts/validate-ops-002-codex-runtime.mjs` validator checks:

1. `AWM_CODEX_EXECUTABLE` exists and returns exactly `codex-cli 0.155.1`;
2. the executable starts `codex app-server`;
3. an isolated temporary `CODEX_HOME` receives a successful `initialize`
   response;
4. no account read, login, thread, turn, or quota-consuming operation is run.

The Compose smoke run additionally checks the executable as UID 10001, the
dedicated state volume, health, and restart behavior.

## Authentication status

No authenticated Codex state was added or mounted during this validation.
Therefore this report proves packaging and unauthenticated app-server startup,
not `account/rateLimits/read` against a real account. A future authorized
operator run must perform official login into `/codex-state` and then validate
the existing read-only adapter. `AWM_CODEX_ENABLED` stays disabled by default.

## Evidence

The focused commands and their actual results are recorded in the task report:

```text
official release: rust-v0.155.1
version: codex-cli 0.155.1
architecture: x86_64-unknown-linux-musl (local Docker host)
initialize: successful without credentials
quota action: not run
```
