# Docker / deployment

## Target

```bash
docker compose up -d
```

One application container with separate SQLite, Codex state, Antigravity CLI
state, and Antigravity keyring volumes. No host home, D-Bus socket, or host
keyring is mounted.

## Defaults

- host bind: `127.0.0.1`;
- container port: `8787`;
- data: named volume at `/data`;
- optional Codex state: separate named volume at `/codex-state`;
- Antigravity CLI state: separate named volume at `/antigravity-state`;
- Antigravity keyring backing data: separate named volume at `/antigravity-keyring`;
- non-root UID 10001;
- `restart: unless-stopped`;
- `cap_drop: ALL`;
- `no-new-privileges:true`;
- read-only root filesystem with `/tmp` tmpfs;
- healthcheck against `/healthz`;
- Tini provides PID 1 signal handling; the Antigravity entrypoint forwards
  SIGTERM to the app and waits for it to close HTTP/SQLite before D-Bus exits;
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

The image also packages the official Antigravity CLI `1.2.9` with
architecture-specific SHA-256 verification. `AWM_ANTIGRAVITY_ENABLED=false` is
the default. When enabled, the entrypoint starts a private D-Bus session and
GNOME Secret Service as UID 10001, with `XDG_*` paths rooted in the dedicated
provider volumes. It does not copy workstation login state. The Settings
onboarding flow advances the official CLI only after its login-method prompt
shows Google OAuth selected, then presents the CLI's complete authorization
URL and forwards the operator-entered browser code back to that CLI. Normal
inspection runs only the documented headless `/usage` command. Antigravity
trigger capability remains disabled by default through the independent
`AWM_ANTIGRAVITY_TRIGGER_ENABLED=false` gate. If deliberately enabled, provider
automation mode must also be selected in the UI; the adapter then exposes only
the four exact Gemini / Claude-and-GPT five-hour or weekly targets and uses the
configured family model. One `Hi!` is a quota-consuming normal prompt, not a
provider start-only operation. A request aimed at one family may also affect
that family's other allowance window. A timeout or other ambiguous result after
spawn must not be retried blindly.

## Web-assisted provider sign-in acceptance

Authentication sessions are temporary and reset to idle if the daemon restarts;
the official provider clients persist credentials in their separate state
volumes. A login process must emit its first recognized progress within 60
seconds; the overall interactive session defaults to 900 seconds and can be
adjusted with `AWM_AUTH_SESSION_TIMEOUT_SECONDS`. For an operator-authorized acceptance, enable the provider in `.env`
(`AWM_CODEX_ENABLED=true` or `AWM_ANTIGRAVITY_ENABLED=true`), start the
container, then use **Settings → Connect** for that provider and complete only
the official sign-in flow. Confirm that the UI reports **Connected** and that
read-only usage observation succeeds. Restart the container and verify the
provider reconnects without asking for sign-in again.

This acceptance does not require sending a Codex or Antigravity turn or any
other quota-consuming action. Both trigger paths remain separately gated. For
Antigravity, configure the optional mounted keyring unlock file only if the
dedicated keyring requires it; never mount host home, keyring, or D-Bus state.
Offline package/runtime probes do not count as authenticated restart acceptance.

## Optional quota-consuming trigger acceptance

Never run this as an automated smoke test or CI step. For an explicitly
authorized manual acceptance, first confirm that the exact selected provider
window is naturally fresh and eligible, the trigger feature gate is enabled,
and provider automation mode is deliberately on. Use the Overview action for
that exact target once. Verify the durable intent and its fresh target-window
confirmation in persisted state/history. A timeout or `uncertain` result is not
permission to click again; wait for new observations to resolve it. If the
selected window is not naturally eligible, skip the live test rather than
spending quota to manufacture eligibility.

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

Do not mount `$HOME`. Each provider gets only the exact official-client state
it needs. Codex and Antigravity runtime state volumes are isolated from the
SQLite volume; Antigravity remains disabled by default.

For Codex, an explicitly authorized operator may authenticate the official CLI
into the dedicated `awm-codex-state` volume. AWM does not copy `auth.json`,
browser cookies, JWTs or refresh tokens. `AWM_CODEX_ENABLED=false` remains the
safe default, and a successful unauthenticated runtime probe proves packaging
and process startup only, not account access.

Antigravity authentication is explicit operator setup. If an encrypted GNOME
keyring needs a startup unlock, create the ignored local override from
`compose.antigravity-secret.example.yaml` and set
`AWM_ANTIGRAVITY_KEYRING_SECRET_SOURCE` to a protected host file path. The file
must be readable by container UID 10001; its contents are never placed in
`.env`, Compose environment, application storage, or logs. Do not use a host
home/keyring/D-Bus mount. If no unlock file is provided, the keyring must be
available unlocked through the isolated runtime; otherwise the provider safely
reports unavailable/auth-required. Authenticated login and reuse after restart
must be verified by an operator before relying on the integration.

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

The Antigravity image check, without credentials or a provider request, is:

```bash
docker run --rm --read-only --tmpfs /tmp:size=32m,mode=1777 \
  --user 10001:10001 --entrypoint node \
  -v "$PWD/scripts/validate-antigravity-runtime.mjs:/tmp/validate.mjs:ro" \
  ai-window-manager:dev /tmp/validate.mjs
```

It verifies the pinned CLI version and starts an isolated D-Bus/Secret-Service
session. It does not authenticate, read quota, or prove restart reuse of a real
Antigravity account.
