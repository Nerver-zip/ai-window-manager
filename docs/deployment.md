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
the overview/API only reads that persisted state. Optional Codex monitoring uses
a dedicated `AWM_CODEX_HOME` under the persistent data volume and is disabled by
default; the image does not provide a Codex credential or provider trigger.

The process also runs one coalescing executor interval and one bounded retention
maintenance interval. Shutdown stops all intervals, waits for in-flight
read-only work, closes the HTTP server, and then closes SQLite. The default
FakeProvider remains monitor-only unless runtime automation is explicitly enabled;
Codex has no trigger capability in this image.

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

## Smoke test checklist

```bash
docker compose config --quiet
docker compose up --build -d
# wait for healthy
docker compose ps
curl --fail http://127.0.0.1:${AWM_HOST_PORT:-8787}/healthz
curl --fail http://127.0.0.1:${AWM_HOST_PORT:-8787}/metrics
```

Then restart:

```bash
docker compose restart ai-window-manager
```

Verify health returns and the same SQLite data remains.
