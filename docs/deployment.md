# Docker / deployment

## Target

```bash
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
pnpm auth:hash
# Set AWM_AUTH_USERNAME and paste the generated PHC value into .env,
# wrapped in single quotes. Replace the example placeholder first.
docker compose config --quiet
docker compose up --build -d
```

The password prompt is hidden and asks for confirmation. It prints only an
Argon2id hash; copy that value to `.env` and never commit or share the file. The
application refuses to start with the example placeholder or missing operator
credentials. After startup, sign in through the browser. AWM supports one local
operator account and has no public registration or browser-based password reset.

One application container with separate SQLite, Codex state, Antigravity CLI
state, and Antigravity keyring volumes. No host home, D-Bus socket, or host
keyring is mounted.

## Defaults

- host bind: `0.0.0.0` for trusted-LAN access (override with `AWM_HOST_BIND`);
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

The checked-in `.env.example` deliberately matches the local `awm` profile
rather than these unset-variable Compose defaults: it uses host port `8878`,
binds all host interfaces, requires a locally generated operator hash, enables
both official provider clients and both action capability gates, and sets
action timeouts to 60 seconds. It contains no usable credential or keyring
unlock value. With these trigger gates enabled, a fresh database seeds the
providers in `automation` mode with an enabled `auto` (“Whenever possible”)
policy. After connecting, select the exact usage window (and Antigravity quota
family) to manage; the application does not guess a target. Explicit SQLite
choices remain authoritative; a one-time upgrade changes only legacy defaults
that were never explicitly saved. The base Compose interpolation defaults for
both action gates are enabled; set either gate to `false` in `.env` to opt out.
Provider monitoring itself remains separately opt-in.

At startup the daemon seeds enabled bootstrap providers missing from SQLite and,
with a trigger gate enabled, upgrades only legacy automation defaults that were
never explicitly saved. It performs one reconcile, then uses one coalescing
global reconcile interval. Runtime provider state and planned intents remain in SQLite;
the overview/API only reads that persisted state. The image packages the
official Codex CLI `0.155.1` at `/opt/codex/bin/codex`, verified by
architecture-specific release checksums. The runtime image includes the
system CA bundle required for official Codex HTTPS login and app-server
connections. Codex monitoring uses the dedicated
`AWM_CODEX_HOME=/codex-state` volume and is disabled when its variable is
unset. The image contains no Codex credentials. Codex trigger support is
separately gated by `AWM_CODEX_TRIGGER_ENABLED`; with that gate enabled, a
fresh database seeds automatic mode and policy. Existing SQLite choices are
not changed by the gate, except that a one-time upgrade moves old defaults that
were never explicitly saved to automatic mode. `AWM_CODEX_ACTION_TIMEOUT_SECONDS` bounds each
app-server stage of the quota-consuming heartbeat and defaults to 30 seconds;
it does not turn an ambiguous outcome into a retryable failure.

The image also packages the official Antigravity CLI `1.2.9` with
architecture-specific SHA-256 verification. `AWM_ANTIGRAVITY_ENABLED` defaults
to false when unset. When enabled, the entrypoint starts a private D-Bus session and
GNOME Secret Service as UID 10001, with `XDG_*` paths rooted in the dedicated
provider volumes. It does not copy workstation login state. The Settings
onboarding flow advances the official CLI only after its login-method prompt
shows Google OAuth selected, then presents the CLI's complete authorization
URL and forwards the operator-entered browser code back to that CLI. Normal
inspection runs only the documented headless `/usage` command. Antigravity
trigger capability has an independent `AWM_ANTIGRAVITY_TRIGGER_ENABLED` gate
(false when unset). If enabled, a fresh database seeds automatic mode and
policy. Explicit SQLite provider choices remain authoritative; a one-time
upgrade moves only old defaults that were never explicitly saved. The adapter
still exposes only the four exact Gemini / Claude-and-GPT five-hour or weekly
targets and uses the configured family model. One `Hi!` is a quota-consuming
normal prompt, not a provider start-only operation. A request aimed at one
family may also affect that family's other allowance window. A timeout or other
ambiguous result after spawn must not be retried blindly.

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
other quota-consuming action. Trigger gates may be enabled by the checked-in
local profile. With a fresh database those gates seed automation mode and an
automatic policy, but an exact target window must still be selected; existing
SQLite choices remain authoritative. For Antigravity, configure the optional mounted keyring unlock file only if the
dedicated keyring requires it; never mount host home, keyring, or D-Bus state.
Offline package/runtime probes do not count as authenticated restart acceptance.
For this repository's local operator deployment, existing Codex and
Antigravity sessions were revalidated after forced container recreation and
`docker compose restart` on 2026-09-24: both providers returned to healthy
read-only observation without a new login. No quota-consuming action was
sent. Treat this as deployment-specific evidence, not as acceptance for a
fresh installation or a different account/keyring configuration.

## Optional quota-consuming trigger acceptance

Never run this as an automated smoke test or CI step. For an explicitly
authorized manual acceptance, first confirm that the exact selected provider
window is naturally fresh and eligible, the trigger feature gate is enabled,
provider automation mode is on, and the exact target policy is configured. Use the Overview action for
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

## LAN, HTTPS and optional proxy

Compose binds `0.0.0.0` by default so other devices on a trusted LAN can access
the native login. This exposes the port on **every host interface**, potentially
including a public one. Host firewall rules must restrict who can reach it; do
not create router port-forwarding to AWM. `AWM_HOST_BIND` can be set to a
specific host address or `127.0.0.1` when a local proxy is preferred.

The login page being public does not protect credentials in transit. Direct
HTTP sends the password and bearer session cookie without transport encryption.
Use direct HTTP only on a network you trust. When that is not true, use a TLS
reverse proxy or a private VPN such as Tailscale. These are optional deployment
choices, not prerequisites to running AWM.

Do not trust forwarded headers by default. If using a reverse proxy, configure
`AWM_TRUST_PROXY` with only the proxy's actual source IP/CIDR, so Fastify can
honor the original HTTPS scheme and set `Secure` cookies. Do not set broad
entries such as `0.0.0.0/0` or `::/0`; do not trust headers from arbitrary LAN
clients.

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

Run the disposable authenticated Compose smoke test. It uses a unique Compose
project/port and generated synthetic credentials; cleanup is scoped to that
project and does not touch the normal `awm` stack or its volumes.

```bash
docker compose config --quiet
./scripts/docker_auth_smoke.sh
```

The smoke test proves health readiness, anonymous redirects/401s, login,
session/CSRF enforcement, and SQLite persistence after restart and stop/up. For
the normally deployed service, `/healthz` stays public for Docker healthchecks;
dashboard/API/metrics requests require signing in.

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
