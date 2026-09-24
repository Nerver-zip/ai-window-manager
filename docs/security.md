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

The image packages the official Codex CLI `0.155.1` with release checksums,
but the runtime keeps `AWM_CODEX_ENABLED=false` by default. A dedicated
`/codex-state` volume is owned by the container user and may be authenticated
only through the official Codex login/device/app-server flow. AI Window
Manager talks to the official client protocol and does not copy a workstation
auth file back and forth. This avoids shared refresh-token races and reduces
coupling to raw token formats. Authentication processes must emit a recognized
sign-in prompt within 60 seconds or are stopped; this is separate from the
bounded overall interactive session deadline.
The Web-assisted login flow has offline process/UI coverage; completing it
with an operator account and verifying the new session after container restart
remain pending acceptance.

The quota-consuming trigger gate defaults to disabled. When an operator enables
`AWM_CODEX_TRIGGER_ENABLED=true` and provider automation, the adapter sends one
fixed `Hi!` turn in an ephemeral read-only workspace. Reset-time phase inference
is explicitly marked inferred; it must not be treated as an official lifecycle
field. Read-only app-server requests retain a short timeout; the quota-consuming
action uses the separately bounded `AWM_CODEX_ACTION_TIMEOUT_SECONDS` setting,
which defaults to 30 seconds. A timeout after dispatch is still uncertain and
cannot be retried blindly.

### Antigravity

The accepted integration invokes only the pinned official `agy` CLI. It is
opt-in (`AWM_ANTIGRAVITY_ENABLED=false` by default), read-only, and always
declares `windowTrigger.supported=false`. Authentication remains owned by the
official CLI and its Secret Service keyring. The container uses separate
Antigravity CLI-state and keyring volumes under UID 10001; it does not mount the
host home, host D-Bus socket, or host keyring. An optional operator-managed
keyring unlock value is read from a mounted file under `/run/secrets`, never
from an environment variable, image, database, browser response, log, or
metric. Live authenticated login/restart acceptance remains pending; do not
represent offline keyring startup as proof that account authentication works.

## Network exposure

MVP has no full user-account system. Safe default:

- Compose publishes `127.0.0.1` only;
- LAN/Tailscale access requires an explicit bind/reverse-proxy decision;
- private reverse proxy/Tailscale auth can be used externally;
- state-changing HTTP routes use CSRF token + same-origin/Origin checks;
- browser pages never contain credentials.

If the service is exposed to an untrusted LAN, authentication becomes a requirement, not a “nice to have”.

## Threat model

| Threat                            | Risk        | MVP mitigation                                                                                                                   |
| --------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| host/volume theft                 | High        | dedicated least-privilege provider state; no whole-home mount; protect host disk/backups; keep secrets outside DB where possible |
| provider token theft              | High        | official client-owned auth, dedicated permissions, redact logs, no browser/API exposure                                          |
| unauthorized LAN UI/action        | Medium-High | loopback default, private VPN/reverse proxy, CSRF + Origin checks; document need for auth on untrusted networks                  |
| CSRF                              | Medium      | per-session CSRF token for state changes, Origin/SameSite checks                                                                 |
| XSS                               | Medium      | server-side escaping, strict CSP, no unsafe HTML from provider payloads                                                          |
| malicious provider response       | Medium      | strict schemas, length bounds, escaped rendering, fail closed                                                                    |
| secrets in logs/crash             | High        | structured allow-list logging, redaction, never log raw payload/auth env                                                         |
| container escape                  | Low-Medium  | non-root, cap_drop ALL, no-new-privileges, read-only rootfs where feasible, no Docker socket                                     |
| dependency/supply-chain           | Medium      | lockfile, minimal dependencies, Dependabot/audit, pin build actions/image bases deliberately                                     |
| SQLite corruption                 | Medium      | WAL, transactional migrations, health check, backups, integrity recovery documentation                                           |
| UI operator error causing trigger | Medium      | explicit provider automation toggle, confirmation/manual controls, explain next action                                           |

## HTTP baseline

- CSP: `default-src 'self'` with the smallest script/style exceptions necessary.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: same-origin` preserves the browser Origin on same-origin form
  submissions while omitting referrers from cross-origin requests.
- no inline rendering of provider HTML.
- request body size limits.
- state-changing routes reject unexpected Origins.
- API errors are sanitized; detailed provider errors stay in structured logs/events.

The current mutation surface is `/settings/providers/:id`, `/schedule`, and the
read/command API endpoints. It accepts only validated non-secret fields; command
handlers create intent/reconcile signals and never call provider adapters. The
executor is the only action dispatch boundary and records ambiguous outcomes as
uncertain.
