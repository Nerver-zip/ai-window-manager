# Docker / deployment

## Target

```bash
docker compose up -d
```

One container, one data volume, optional dedicated provider credential/state mounts as provider spikes prove safe patterns.

## Defaults

- host bind: `127.0.0.1`;
- container port: `8787`;
- data: named volume at `/data`;
- optional Codex state: separate named volume at `/codex-state`;
- non-root UID 10001;
- `restart: unless-stopped`;
- `cap_drop: ALL`;
- `no-new-privileges:true`;
- read-only root filesystem with `/tmp` tmpfs;
- healthcheck against `/healthz`;
- graceful SIGTERM;
- no Docker socket.

At startup the daemon seeds only enabled bootstrap providers when their DB record
does not already exist, performs one reconcile, then uses one coalescing global
reconcile interval. Runtime provider state and planned intents remain in SQLite;
the overview/API only reads that persisted state. The image packages the
official Codex CLI `0.155.1` at `/opt/codex/bin/codex`, verified by
architecture-specific release checksums. The runtime image includes the
system CA bundle required for official Codex HTTPS login and app-server
connections. Optional Codex monitoring uses the dedicated
`AWM_CODEX_HOME=/codex-state` volume and is disabled by default. The
image contains no Codex credentials. Codex trigger support is separately gated
by `AWM_CODEX_TRIGGER_ENABLED=false` and the persisted provider mode remains
`monitor_only` until an operator explicitly changes it.
When enabled deliberately, `AWM_CODEX_ACTION_TIMEOUT_SECONDS` bounds each
app-server stage of the quota-consuming heartbeat and defaults to 30 seconds;
it does not turn an ambiguous outcome into a retryable failure.

The process also runs one coalescing executor interval and one bounded retention
maintenance interval. Shutdown stops all intervals, waits for in-flight
read-only work, closes the HTTP server, and then closes SQLite. FakeProvider is
opt-in through `AWM_FAKE_PROVIDER_ENABLED=true`. When false, any previously
persisted FakeProvider is hidden from HTML, JSON read/command routes, history,
and Prometheus metrics; its SQLite state and history are retained. Set it true to
enable and show the deterministic provider for local development. Codex has no
trigger capability unless the explicit trigger gate is enabled.

## Dockge

`compose.yaml` is ordinary Docker Compose and needs no Dockge-specific keys. Point Dockge at the repository/stack directory and configure `.env`/mount paths there.

## LAN/Tailscale

Default is intentionally loopback-only. Examples:

```env
# all host interfaces; use only on a trusted network / protected reverse proxy
AWM_HOST_BIND=0.0.0.0

# or bind directly to a specific host/Tailscale address if Compose/runtime supports the host address
```

Prefer a private reverse proxy or Tailscale ACL/auth over building user management into the MVP.

## Provider homes/secrets

Do not mount `$HOME`. Each provider gets only the exact official-client state it needs. Codex/Antigravity mounts are **not enabled by default** in the base Compose file until their implementation spikes settle the secure path.

For Codex, an explicitly authorized operator may authenticate the official CLI
into the dedicated `awm-codex-state` volume. AWM does not copy `auth.json`,
browser cookies, JWTs or refresh tokens. `AWM_CODEX_ENABLED=false` remains the
safe default, and a successful unauthenticated runtime probe proves packaging
and process startup only, not account access.

## Smoke test checklist

```bash
docker compose config --quiet
docker compose up --build -d
# wait for healthy
docker compose ps
curl --fail http://127.0.0.1:${AWM_HOST_PORT:-8787}/healthz
curl --fail http://127.0.0.1:${AWM_HOST_PORT:-8787}/metrics
curl --fail http://127.0.0.1:${AWM_HOST_PORT:-8787}/
curl --fail http://127.0.0.1:${AWM_HOST_PORT:-8787}/usage
curl --fail http://127.0.0.1:${AWM_HOST_PORT:-8787}/logs
# Legacy HTML alias redirects while preserving query parameters.
curl --fail --location http://127.0.0.1:${AWM_HOST_PORT:-8787}/history?range=24h
curl --fail http://127.0.0.1:${AWM_HOST_PORT:-8787}/api/v1/usage
```

Then restart:

```bash
docker compose restart ai-window-manager
```

Verify health returns and the same SQLite data remains.

The focused Codex runtime check, without credentials or a turn, is:

```bash
docker run --rm --read-only --tmpfs /tmp:size=32m,mode=1777 \
  --user 10001:10001 --entrypoint node \
  -e AWM_CODEX_EXECUTABLE=/opt/codex/bin/codex \
  -e CODEX_HOME=/tmp/awm-ops-002-codex-home \
  -e AWM_DB_PATH=/tmp/awm.db \
  -v "$PWD/scripts/validate-ops-002-codex-runtime.mjs:/tmp/validate.mjs:ro" \
  ai-window-manager:dev /tmp/validate.mjs
```

The command must report `codex-cli 0.155.1` and a successful app-server
`initialize`. It deliberately does not log in or call `account/rateLimits/read`.
