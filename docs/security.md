# Security and threat model

## Credential principles

- never mount the workstation's entire `$HOME`;
- prefer official provider clients to own OAuth/refresh logic;
- give each provider a dedicated writable state/home directory if required;
- secret material never enters the image, DB, browser, metrics, logs, fixtures or crash reports;
- mounts are read-only when the official client does not need refresh writes;
- no Docker socket;
- no account rotation or token scraping.

## Secret scanning

Gitleaks uses its upstream default rules through `.gitleaks.toml`. The local `pnpm secret:scan` command and the GitHub Actions security job scan repository content and available history; a finding fails the gate. Do not add real credentials to source, fixtures, examples, `.env` files, logs, or documentation. Synthetic test values must be unmistakably non-secret.

### Codex

The image packages the official Codex CLI `0.155.1` with release checksums.
`AWM_CODEX_ENABLED` is false when unset; the checked-in `.env.example`
explicitly enables the local profile without containing credentials. A dedicated
`/codex-state` volume is owned by the container user and may be authenticated
only through the official Codex login/device/app-server flow. AI Window
Manager talks to the official client protocol and does not copy a workstation
auth file back and forth. This avoids shared refresh-token races and reduces
coupling to raw token formats. Authentication processes must emit a recognized
sign-in prompt within 60 seconds or are stopped; this is separate from the
bounded overall interactive session deadline. The web flow captures only the
short-lived device code and official sign-in URL from the CLI's interactive
terminal; it never reads, parses, or returns OAuth/access/refresh tokens. The
official Codex CLI alone persists authentication in `/codex-state`.
The Web-assisted login flow has offline process/UI coverage. Existing Codex
and Antigravity sessions in the local operator deployment survived container
recreation/restart and resumed read-only observations on 2026-09-24. This does
not validate a fresh Web-assisted sign-in or keyring setup in another
deployment; operators must verify those there.

Quota-consuming trigger gates default to enabled for configured providers;
set the relevant gate to `false` to opt out. With a gate enabled, a fresh
database uses automation mode and an automatic policy unless the operator
explicitly chooses Off or “Only when I ask”; dispatch still requires a
supported exact target. The adapter then sends one fixed `Hi!` turn in an
ephemeral read-only workspace. Reset-time phase inference
is explicitly marked inferred; it must not be treated as an official lifecycle
field. Read-only app-server requests retain a short timeout; the quota-consuming
action uses the separately bounded `AWM_CODEX_ACTION_TIMEOUT_SECONDS` setting,
which defaults to 30 seconds. A timeout after dispatch is still uncertain and
cannot be retried blindly.

### Antigravity

The accepted integration invokes only the pinned official `agy` CLI.
Monitoring is disabled when `AWM_ANTIGRAVITY_ENABLED` is unset; the checked-in
`.env.example` explicitly enables it for the local profile. Its experimental,
quota-consuming trigger has a separate environment gate, also enabled by the
local example, and still requires the persisted provider mode `automation` and
an automatic policy. The adapter uses only official headless `agy -p`
with one fixed `Hi!`, and only for one exact supported quota-window target and
its configured model. This is a normal provider request, not a start-only API;
the Overview start button is explicit and does not display an additional quota
warning.
Operator-provided observations support the reset-anchoring effect for one
account and pinned client, but this is not a universal provider guarantee.
Timeout, EOF, malformed output or other ambiguity after spawn becomes
`uncertain`; it is never blindly retried.

Authentication remains owned by the official CLI and its Secret Service
keyring. The container uses separate Antigravity CLI-state and keyring volumes
under UID 10001; it does not mount the host home, host D-Bus socket, or host
keyring. An optional operator-managed keyring unlock value is read from a
mounted file under `/run/secrets`, never from an environment variable, image,
database, browser response, log, or metric. On sign-in, AWM waits for the
official CLI's `Select login method` screen and sends one Enter only when
`1. Google OAuth` is explicitly selected; it never selects the Google Cloud
project option. It then captures the complete official Google sign-in URL and
forwards only the browser-issued code entered by the operator to the waiting
CLI process. AWM never reads or returns Antigravity tokens. The existing
authenticated local deployment resumed usage reads after recreation/restart on
2026-09-24; this does not prove fresh account/keyring setup elsewhere. Do not
represent offline keyring startup as proof that account authentication works.

## Native operator authentication

AWM has one local operator account, not a multi-user system. Configure
`AWM_AUTH_USERNAME` and `AWM_AUTH_PASSWORD_HASH` in the ignored `.env` file.
Generate the hash locally with `pnpm auth:hash`; the password is entered twice
without terminal echo and is never accepted as an environment variable. The
hash is Argon2id (`m=19456,t=2,p=1`) and should be treated as sensitive because
it permits offline password guessing if copied. Keep `.env` mode `0600`, out of
Git and backups that are not protected. Startup fails closed if either value is
missing or invalid. Changing the hash and restarting changes the one operator
credential and invalidates all existing sessions.

Passwords are compared with a bounded Argon2id verifier. Five failed attempts
per source address or 60 failed attempts across all sources in five minutes
trigger a temporary throttle; the verifier also caps concurrent work. Both
failure windows use bounded in-memory state. A
successful login receives a cryptographically random opaque session token. The
server stores only its SHA-256 digest in memory, not SQLite. The cookie is
`HttpOnly`, `SameSite=Strict`, path-wide, and has a bounded lifetime (12 hours
by default, configurable from 15 minutes to seven days); it is `Secure` when
the request is HTTPS. Restarting AWM invalidates all sessions.
Mutation routes still require same-origin `Origin` plus the existing
double-submit CSRF token.

Only `GET /healthz`, static assets, and the login page are anonymous. The
logout confirmation and logout mutation both require a valid operator session;
the mutation additionally requires same-origin Origin and CSRF validation.
Every dashboard route, API endpoint, and `/metrics` requires a session. HTML
navigation redirects to login; APIs and metrics return `401 AUTH_REQUIRED`.
No account signup, password reset page, roles, OAuth or trusted-auth-header
bypass is implemented. There is no password-setting endpoint in the browser.

## Network exposure

Compose publishes `0.0.0.0` by default for a trusted local network, and the
native login is mandatory even when used only at home. This does **not** encrypt
traffic: direct HTTP sends the password and session cookie unencrypted across
the LAN. Restrict access with host firewall rules and do not forward the app
port from a router to the public internet. For a network that cannot be trusted,
use an HTTPS reverse proxy or private VPN. Tailscale is an option, not a
prerequisite. Never use HTTP on a hostile/shared network.

Forwarded protocol/client information is ignored unless `AWM_TRUST_PROXY`
explicitly lists the reverse proxy's source IP/CIDR. Configure only the actual
proxy hop; never trust all networks. When no proxy is configured, HTTP headers
cannot mark cookies secure or influence source-based throttling.

## Threat model

| Threat                            | Risk       | MVP mitigation                                                                                                                   |
| --------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| host/volume theft                 | High       | dedicated least-privilege provider state; no whole-home mount; protect host disk/backups; keep secrets outside DB where possible |
| provider token theft              | High       | official client-owned auth, dedicated permissions, redact logs, no browser/API exposure                                          |
| unauthorized LAN UI/action        | High       | required single-operator login, bounded sessions, throttling, CSRF + Origin checks; restrict LAN with firewall                   |
| password/session sniffing on LAN  | High       | HTTPS/VPN recommended; direct HTTP is supported only on a trusted network and is not confidential                                |
| CSRF                              | Medium     | per-session CSRF token for state changes, Origin/SameSite checks                                                                 |
| XSS                               | Medium     | server-side escaping, strict CSP, no unsafe HTML from provider payloads                                                          |
| malicious provider response       | Medium     | strict schemas, length bounds, escaped rendering, fail closed                                                                    |
| secrets in logs/crash             | High       | structured allow-list logging, redaction, never log raw payload/auth env                                                         |
| container escape                  | Low-Medium | non-root, cap_drop ALL, no-new-privileges, read-only rootfs where feasible, no Docker socket                                     |
| dependency/supply-chain           | Medium     | lockfile, minimal dependencies, Dependabot/audit, pin build actions/image bases deliberately                                     |
| SQLite corruption                 | Medium     | WAL, transactional migrations, health check, backups, integrity recovery documentation                                           |
| UI operator error causing trigger | Medium     | explicit opt-out gates, persisted monitoring-only/manual controls, exact-window checks, durable intent and fresh preflight       |

## HTTP baseline

- CSP: `default-src 'self'` with the smallest script/style exceptions necessary.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: same-origin` preserves the browser Origin on same-origin form
  submissions while omitting referrers from cross-origin requests.
- no inline rendering of provider HTML.
- request body size limits.
- state-changing routes reject unexpected Origins.
- all dynamic HTML, JSON, and metrics responses use `Cache-Control: no-store`;
- private pages/API/metrics are gated centrally before application handlers;
- the only anonymous application-data route is the minimal database health
  result; static assets and the login page are public, while logout requires a
  session.
- API errors are sanitized; detailed provider errors stay in structured logs/events.

The login mutation at `POST /login` is Origin + CSRF protected; `POST /logout`
is also protected and invalidates the presented session. The current product
mutation surface is `/settings/providers/:id`, `/schedule`,
`/providers/:id/trigger`, and the read/command API endpoints. It accepts only
validated non-secret fields; command
handlers create intent/reconcile signals and never call provider adapters. The
executor is the only action dispatch boundary and records ambiguous outcomes as
uncertain.
