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

Preferred design: a dedicated Codex client home/state area owned by the container user, authenticated through an official Codex login/device/app-server flow. AI Window Manager talks to the official client protocol and does not copy a workstation auth file back and forth. This avoids shared refresh-token races and reduces coupling to raw token formats.

### Antigravity

Official CLI uses OS keyring/Secret Service. A Docker-safe persistent auth approach needs a spike. Do not “solve” this by extracting Google tokens. Until a supported operational pattern is demonstrated, report `AUTH_REQUIRED`/monitor-only.

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
- no inline rendering of provider HTML.
- request body size limits.
- state-changing routes reject unexpected Origins.
- API errors are sanitized; detailed provider errors stay in structured logs/events.
