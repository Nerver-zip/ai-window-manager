# SPIKE-007 — Claude Code usage windows, runtime and window starts

**Research checked:** 2026-11-03

**Pinned CLI:** Claude Code `2.1.311` (official `stable` channel). Static
inspection and probes were repeated on `2.1.318` (`latest`) where noted.

**Status:** Monitoring and runtime are implemented. The quota-consuming window
start is implemented, but it stays **off by default** and needs an owner
decision. It has no live acceptance. No prompt was sent with any account, and no
authenticated `/usage` read was run.

**Scope:** Official documentation, release metadata, the signed release
manifest, static string inspection of the official binary, and unauthenticated
probes with an empty, throwaway `CLAUDE_CONFIG_DIR`. Without credentials no
request can be billed to any account. The operator's own `~/.claude` was not
read.

Classifications follow [`docs/providers.md`](../../providers.md): **SUPPORTED**
means publicly documented, **OBSERVED** means verified behaviour without a
stable contract, **INFERRED** means derived with stated assumptions, and
**UNKNOWN** means insufficient evidence.

## Conclusion

The official CLI has an on-demand, machine-readable usage read that sends no
model request. `claude -p /usage --output-format stream-json` runs `/usage` as
a _local command_: the official client fetches the plan's usage and attaches a
structured `usage_report` beside its text. AWM uses this read inside its own
isolated Claude Code runtime. Monitoring and the optional start therefore run as
the same signed-in account by construction, and the operator's workstation is
never involved.

The status-line `rate_limits` bridge named in the goal was evaluated and
rejected (see [Rejected alternatives](#rejected-alternatives)).

The window start is one ordinary `claude -p "Hi!"` request with tools,
slash-commands, MCP servers, settings sources and session persistence disabled.
Anthropic's terms neither clearly permit nor clearly forbid scheduling a request
to position a usage window. AWM therefore ships the start disabled
(`AWM_CLAUDE_CODE_TRIGGER_ENABLED=false`) and records the decision as ADR-009.

## Sources (accessed 2026-11-03)

| Source                                                                                                               | Finding                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| https://code.claude.com/docs/en/setup                                                                                | Native installer, release manifests with platform checksums, detached OpenPGP manifest signatures from 2.1.89 onward, `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`, `autoUpdatesChannel` (`latest`/`stable`).                                                         |
| https://code.claude.com/docs/en/cli-reference                                                                        | `-p`, `--output-format`, `--no-session-persistence`, `--tools ""`, `--strict-mcp-config`, `--setting-sources`, `--disable-slash-commands`, `--model`, `--max-turns`, `auth status [--json\|--text]`, `auth login`, `auth logout`.                                 |
| https://code.claude.com/docs/en/headless                                                                             | `--bare` reads only `ANTHROPIC_API_KEY`/`apiKeyHelper` and never OAuth. Without `--bare`, `-p` loads project hooks and `.mcp.json` from the working directory. Exit code is non-zero on failure. SIGTERM gives exit 143.                                          |
| https://code.claude.com/docs/en/authentication                                                                       | Linux credentials live in `$CLAUDE_CONFIG_DIR/.credentials.json` (mode 0600). `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` is the documented long-lived token path. Login is a browser flow with a pasted code.                                               |
| https://code.claude.com/docs/en/statusline                                                                           | `rate_limits.five_hour/seven_day.{used_percentage,resets_at}`. Only for Claude.ai subscribers, only after the first API response, and each window may be absent.                                                                                                  |
| https://code.claude.com/docs/en/agent-sdk/typescript                                                                 | `SDKRateLimitEvent`; experimental `SDKUsageReport` carried as `usage_report` on the message that delivers a `/usage` result.                                                                                                                                      |
| https://code.claude.com/docs/en/env-vars                                                                             | `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`.                                                                                                                            |
| https://code.claude.com/docs/en/sessions, /data-usage                                                                | Transcripts at `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session>.jsonl`, kept 30 days by default. `--no-session-persistence` suppresses writes for one print-mode run.                                                                                            |
| https://code.claude.com/docs/en/legal-and-compliance                                                                 | OAuth is for subscribers and "ordinary use of Claude Code". Third parties may not offer Claude.ai login or "collect, store, or intermediate Claude.ai credentials or session tokens". End users may sign in to the unmodified binary with their own subscription. |
| https://www.anthropic.com/legal/consumer-terms                                                                       | No automated access "except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it". No bypassing protective measures.                                                                                           |
| https://www.anthropic.com/legal/aup                                                                                  | No reselling or proxying access, including routing requests through consumer subscriptions.                                                                                                                                                                       |
| https://support.claude.com/en/articles/11647753                                                                      | "The period starts when you send your first message, and your limit resets in full five hours later." Weekly limits reset at a fixed time. Claude, Claude Code and Desktop share the limits.                                                                      |
| https://downloads.claude.ai/claude-code-releases/{stable,latest,&lt;v&gt;/manifest.json,&lt;v&gt;/manifest.json.sig} | `stable` = 2.1.311, `latest` = 2.1.318.                                                                                                                                                                                                                           |
| https://downloads.claude.ai/keys/claude-code.asc                                                                     | "Anthropic Claude Code Release Signing", fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`.                                                                                                                                                         |

## Findings

### Distribution and integrity

- **SUPPORTED/OBSERVED:** Each version publishes a single, uncompressed,
  glibc-linked ELF at `<version>/linux-x64/claude` and `<version>/linux-arm64/claude`.
  `manifest.json` carries `platforms[<key>].{binary,checksum,size}` (SHA-256).
  musl builds exist but are not used, because the runtime image is Ubuntu (glibc).
- **OBSERVED:** `gpgv` reports `GOODSIG`/`VALIDSIG …31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`
  for the 2.1.311 and 2.1.318 manifests. The 2.1.311 linux-x64 binary
  (293,776,752 bytes) hashes to the manifest checksum
  `86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada`. Its
  `--version` prints `2.1.311 (Claude Code)`.
- **OBSERVED:** The official bootstrap installer verifies only the SHA-256. AWM
  additionally verifies the manifest signature against the repository-pinned key.

### Authentication

- **SUPPORTED:** `claude auth status --json` exits with 0 when signed in and 1
  when not. **OBSERVED** logged-out keys: `loggedIn`, `authMethod: "none"`,
  `apiProvider: "firstParty"`, `configDirectory`. **OBSERVED** in the binary:
  signed-in Claude.ai sessions add `email`, `orgId`, `orgName` and
  `subscriptionType`.
- **SUPPORTED:** `ANTHROPIC_API_KEY` in the environment overrides subscription
  auth in `-p` mode. AWM builds an allowlisted environment, so the variable can
  never reach the CLI.
- **UNKNOWN:** whether `auth status` makes a network request.

### Usage read (`/usage`)

- **OBSERVED (2.1.311 and 2.1.318, unauthenticated):** `claude -p … "/usage"`
  emits `system/init`, then an assistant message with
  `local_command_run.command = "usage"` and `message.model = "<synthetic>"`,
  then a `result` with `local_command: "usage"`, `num_turns: 0` and
  `duration_api_ms: 0`. It exits 0, and no transcript file is written.
- **SUPPORTED (experimental) + OBSERVED schema:** for Claude.ai subscribers the
  message carries `usage_report.rate_limits.limits[]` rows
  `{kind, group, percent (0–100), resets_at (ISO 8601 | null), scope?, severity, is_active}`.
  The binary describes kinds `session`, `weekly_all` and `weekly_scoped`, and
  says to classify rows by `kind`, never by label. `rate_limits` is null when the
  fetch fails or when there is no plan.
- **INFERRED:** `session` is the five-hour limit and `weekly_all` is the
  seven-day limit. This matches the status-line names and the support article.
- **INFERRED:** the read uses no model allowance, because there is no model
  turn. It is a server read that may itself be rate limited, so AWM polls it at
  most every 120 s by default.
- **UNKNOWN:** the authenticated idle-window shape. The read may report
  `resets_at: null` with 0 % used, or a moving projection. AWM handles both
  conservatively (see Normalization).

### Window start

- **SUPPORTED:** an ordinary first message starts the five-hour period. One
  request counts against both the five-hour and the weekly allowance.
- **OBSERVED (2.1.311, unauthenticated):** with the full argument set,
  `system/init` reports `tools: []`, `mcp_servers: []`, `apiKeySource: "none"`
  and the resolved model (`haiku` resolves to `claude-haiku-5-5`). Missing
  credentials produce an assistant `error: "authentication_failed"` with a
  synthetic model, then `result.is_error = true` and `duration_api_ms: 0`, and
  exit 1.
- **OBSERVED:** unknown options are rejected (`error: unknown option`), so the
  hidden-from-help `--max-turns` is a recognised flag.
- **OBSERVED:** `system/init` is not emitted before input in
  `--input-format stream-json` mode. A stream handshake therefore gives no
  pre-dispatch boundary, and AWM gates dispatch immediately before spawning the
  process.
- **OBSERVED:** with `--no-session-persistence` and
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` the run leaves only CLI-owned
  `.claude.json`/`backups/` in the config directory. There is no
  `projects/…/<session>.jsonl` and no `memory/` directory. This was verified on
  the auth-failure path only.
- **UNKNOWN:** whether an authenticated `Hi!` anchors the window on every plan,
  and its exact allowance cost.

### Read-only commands executed

```text
claude --version | --help | auth --help | auth status --help | auth login --help
claude setup-token --help | update --help | install --help
env -i … CLAUDE_CONFIG_DIR=<empty tmp> claude auth status --json         # exit 1, logged out
env -i … CLAUDE_CONFIG_DIR=<empty tmp> claude -p --zz-unknown-flag …      # rejected
env -i … CLAUDE_CONFIG_DIR=<empty tmp> claude -p <isolation flags> /usage  # local command, num_turns 0
env -i … CLAUDE_CONFIG_DIR=<empty tmp> claude -p <isolation flags> --max-turns 1 \
        --disable-slash-commands --model haiku "Hi!"                       # authentication_failed, no API call
gpgv --status-fd 1 --keyring <dearmored pinned key> manifest.json.sig manifest.json
sha256sum claude
```

Sanitized structural fixtures are in `tests/providers/claude-code/support.ts`.
They use synthetic values only; no account output was captured.

## Normalization

| Server meter                                               | Window identity                | Cadence                                |
| ---------------------------------------------------------- | ------------------------------ | -------------------------------------- |
| `session`                                                  | `claude_code_five_hour`        | 18,000 s (`official_supported`, high)  |
| `weekly_all`                                               | `claude_code_seven_day`        | 604,800 s (`official_supported`, high) |
| any other kind (for example `weekly_scoped` + model scope) | `claude_code_<kind>[_<scope>]` | none; phase `UNKNOWN`, never a target  |

The phase is computed at the completion time of the official read:

- future reset and `percent > 0`: `ACTIVE` (inferred, high). At ≥ 100 %:
  `EXHAUSTED`;
- future reset and `percent = 0`: `UNKNOWN`. It may be a rolling projection, and
  the existing temporal-evidence tracker decides;
- no reset and `percent = 0`: `INACTIVE` at **medium** confidence. This is never
  actionable by itself. The cycle tracker raises it to high only after the
  window's previously anchored reset has passed;
- reset at or before the read: `RESET_DUE`, with no usage facts;
- duplicate identities, out-of-range values, a reset beyond duration plus slack,
  or envelope drift: the read is rejected and last-known-good is kept.

## Feasibility gate

1. **Genuine five-hour/weekly observations without quota?** Yes, through the
   official `/usage` local command. This is inferred from `num_turns: 0`. An
   authenticated confirmation is still pending.
2. **Transported safely to the Docker daemon?** Yes. The read runs inside the
   container, nothing crosses a host boundary, and no credentials reach AWM.
3. **Associated with the correct account?** Yes, by construction: reads and
   starts use the same isolated `CLAUDE_CONFIG_DIR`.
4. **One bounded ordinary request?** Yes: `-p`, one turn, no tools, no MCP, no
   slash commands, a fixed `Hi!`, an explicit model and a 60 s bound.
5. **No persistent conversation?** Yes, via `--no-session-persistence` and
   `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`. This is observed on the auth-failure
   path only. No cleanup job is needed.
6. **Independent confirmation?** Yes. The executor confirms with a fresh
   `/usage` read; the process exit alone never confirms.
7. **Acceptable under the terms?** **Undetermined.** Usage reads are ordinary
   use of the unmodified CLI. Scheduled starts are not addressed by the terms.
   They are default-off and need an owner decision (ADR-009).

## Rejected alternatives

- **Passive status-line bridge.** Its data exists only after quota-consuming
  activity. Idle refreshes do not fetch new data. It needs a host helper, a bind
  mount and file-permission coordination. Host and container accounts cannot be
  associated without extra identity plumbing. A usable start would still need a
  fresh read. The official `/usage` read removes all of these problems.
- **`rate_limit_event` from stream-json.** It is documented only as "emitted
  when the session encounters a rate limit", its per-window detail is marked
  internal, and it is available only during a quota-consuming request.
- **Calling Claude's usage HTTP endpoint directly.** That is a private endpoint
  and requires token handling, so it is prohibited by AGENTS.md.
- **`--bare`.** It never reads subscription credentials.
- **`claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`.** AWM would have to store
  and inject a long-lived credential.
- **Browser-mediated sign-in (the Antigravity pattern).** Relaying the Claude.ai
  authorization code through AWM conflicts with the "may not … intermediate
  Claude.ai credentials" clause. Sign-in therefore happens only in the official
  CLI terminal (`docker compose exec … claude-code-cli auth login`).
- **musl binaries.** The runtime image is glibc, and the manifest-verified glibc
  build is the default the installer selects.

## Open items requiring owner action

- Authorize one authenticated `/usage` read to confirm the `usage_report` rows
  and the idle shape. It is believed non-consuming but unverified.
- Decide whether to enable the start (see ADR-009). If enabled, authorize one
  live `Hi!` acceptance to observe anchoring and the confirmation path.
