# ADR-009 — Claude Code provider: official `/usage` read and gated window start

Status: Accepted. The owner accepted the window start for their own subscription on 2026-11-03.

## Context

The goal is to add Anthropic Claude Code to AWM alongside Codex and Antigravity.
[SPIKE-007](../research/spikes/SPIKE-007-claude-code.md) found an official,
on-demand usage read. It is the `/usage` local command, which carries an
experimental structured `usage_report` and makes no model request. SPIKE-007
also found that Anthropic's terms do not address scheduling an ordinary request
to position a usage window, and that third parties must not "intermediate
Claude.ai credentials".

## Decision

1. **Identity.** The provider ID and kind are `claude_code`. The canonical
   windows are `claude_code_five_hour` (server meter `session`) and
   `claude_code_seven_day` (`weekly_all`). Other server meters keep an
   observed-only identity, with phase `UNKNOWN` and no cadence. They are never a
   trigger target.
2. **Monitoring.** The adapter runs the pinned official CLI as
   `claude -p --output-format stream-json --verbose --no-session-persistence --tools "" --strict-mcp-config --setting-sources "" /usage`.
   It runs in a dedicated `CLAUDE_CONFIG_DIR` (`/claude-state`) and an empty
   private working directory, with an allowlisted environment. That environment
   has no inherited credentials or `ANTHROPIC_API_KEY`, and Claude Code's
   updater, auto-memory and prompt history are disabled. A read is accepted only
   if all of these hold:
   - the result is a local `usage` command;
   - `num_turns` is 0;
   - exactly one `usage` message arrived;
   - the meter rows validate.

   A model-produced message makes the read fail closed. The default poll
   interval is 120 s.

3. **Phase semantics.** These are conservative, and the zero-use rules prevent a
   repeat of the Codex incident:
   - zero use with a future reset is `UNKNOWN`, and the temporal tracker
     decides;
   - the unscoped canonical `session` meter at exact zero use with no reset is
     `INACTIVE` at high confidence. The owner confirmed from the official CLI
     usage screen that this is the not-yet-started five-hour session state;
   - other zero-use meters without a reset remain `INACTIVE` at medium
     confidence;
   - an expired reset is `RESET_DUE`.

   A generic tracker rule may raise medium `INACTIVE` with zero use and no
   reset to high confidence only after that window's previously anchored reset
   has passed. The `session` bootstrap rule is specific to Claude Code's
   official meter; it does not change Codex or Antigravity inference. A start
   still requires the enabled exact-target policy, fresh observations, a
   persisted intent and the provider's normal preflight. A previously anchored
   future reset takes precedence over a later missing-reset reading, which
   remains `UNKNOWN` until that anchor passes.

4. **Authentication.** The original implementation used only the official CLI
   in a terminal; the follow-up uses AWM's shared `AuthSessionManager` to run
   the unmodified `claude auth login` in a bounded PTY and guide the browser
   flow in Settings. Only HTTPS URLs from the exact observed host `claude.com`
   are exposed. The CLI-emitted bootstrap URL is allowed only at
   `/cai/oauth/authorize` with exactly one of each observed parameter:
   `code`, `client_id`, `response_type`, `redirect_uri`, `scope`,
   `code_challenge`, `code_challenge_method` and `state`. Values are bounded;
   the code is nonempty and printable within the 2,048-character URL limit,
   `response_type` must be `code`, the
   PKCE method must be `S256`, and the callback must be
   `https://platform.claude.com/oauth/code/callback`. Unknown
   or duplicate parameters and other callbacks are rejected. The complete URL
   is sent only to the authenticated browser session and remains in memory.
   When the CLI requests a browser-returned one-time code, the authenticated UI
   forwards it to the active CLI process in memory; AWM does not persist or log
   either value. The official `claude auth status --json` command independently
   verifies sign-in, without a model request. The CLI-owned `/claude-state`
   volume remains dedicated and unchanged. Manual recovery remains available through
   `docker compose exec ai-window-manager claude-code-cli auth
{login|status|logout}`. `setup-token`, `--bare` and API keys are not used.

   Anthropic's current guidance permits an end user to sign into the unmodified
   CLI with their own subscription, including where a platform hosts it, and
   separately bars developers from collecting, storing or intermediating
   credentials. It does not clearly determine whether a self-hosted,
   single-operator AWM instance forwarding a one-time code is credential
   intermediation. This remains an operator risk decision. The terminal fallback
   keeps the code outside AWM.

5. **Window start.** `AWM_CLAUDE_CODE_TRIGGER_ENABLED` defaults to **true**, like
   the other configured providers (AGENTS.md). Operators opt out with `false` or
   with persisted monitoring-only/manual settings. When the gate is enabled, the
   capability advertises only `claude_code_five_hour`, with
   `consumesQuota: true`. The action:
   - passes the executor's final dispatch gate immediately before spawning;
   - runs `claude -p <isolation flags> --max-turns 1 --disable-slash-commands --model <approved> "Hi!"`
     with a bounded runtime and bounded output;
   - before using the run, requires `system/init` to report no tools, no MCP
     servers, `apiKeySource: "none"` and the configured model.

   Response text is discarded. A missing sign-in counts as a pre-dispatch
   failure. Any other ambiguity, including a timeout or cancellation after
   spawn, is `uncertain` and is never retried. Confirmation requires a fresh,
   independent `/usage` read that shows the target `ACTIVE` in the bound cycle.
   No cleanup job exists, because no session is persisted.

6. **Runtime.** The official binary is pinned in `provider-clients.lock.json`
   (`claude_code`, stable channel). Its integrity rests on the detached OpenPGP
   signature of the Anthropic release manifest, verified with `gpgv` against
   the repository-pinned key `provider-keys/claude-code-release.asc`
   (fingerprint `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`), and on the binary's
   SHA-256 from that manifest. The provider-client store gains a single-binary
   artifact format: the binary is staged without extraction, version-checked
   (`<v> (Claude Code)`), probed read-only (`/usage`, no model turn), then
   activated atomically with a rollback copy. Claude Code's own updater is
   disabled.

## Consequences

- Monitoring needs only a container sign-in; no host integration is required.
- Automatic starts only become possible after a window has been observed
  anchored and then ended, and only while the gate is enabled.
- The `usage_report` shape is experimental. Schema drift pauses readings with
  `CLAUDE_CODE_CONTRACT_CHANGED` and keeps last-known-good state.
- The image grows by about 300 MB per architecture for the official binary.
- Settings uses the shared authentication routes and state machine; its
  optional one-time code is transient process input and never a durable AWM
  record. AWM supports manual CLI recovery for operators who choose not to relay
  the code through the app.
- The supplied provider mark is used only as a provider-identification icon,
  displayed larger with no background or border to preserve visibility.

## Owner decision (2026-11-03)

The owner accepted that scheduled ordinary requests are acceptable for their own
subscription under Anthropic's Consumer Terms and Usage Policy. This is project
authorization, not Anthropic approval. Other operators must make their own
assessment and can opt out. The owner also authorized one live acceptance, a
`/usage` read plus one `Hi!`; SPIKE-007 records the results.
