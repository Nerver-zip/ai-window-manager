# ADR-009 — Claude Code provider: official `/usage` read and default-off start

Status: Accepted for monitoring. The window start awaits an owner decision.

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
   - zero use without a reset is `INACTIVE` at medium confidence;
   - an expired reset is `RESET_DUE`.

   One generic tracker rule raises a medium `INACTIVE` with zero use and no
   reset to high confidence, and only after that window's previously anchored
   reset has passed. No existing adapter emits medium `INACTIVE`, so Codex and
   Antigravity are unaffected.

4. **Authentication.** Sign-in, status and sign-out use only the official CLI in
   a terminal:
   `docker compose exec ai-window-manager claude-code-cli auth {login|status|logout}`.
   The wrapper allows only these account commands. The web UI shows
   instructions and connection health. It never accepts, stores or forwards
   authorization codes or tokens. Credentials stay in the CLI-owned
   `/claude-state` volume. `setup-token`, `--bare` and API keys are not used.
5. **Window start.** `AWM_CLAUDE_CODE_TRIGGER_ENABLED` defaults to **false**. This
   deliberately departs from the Codex/Antigravity default, as allowed by the
   goal's D5 and by the Argon precedent. When the gate is enabled, the
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
  anchored and then ended, and only when the owner enables the gate.
- The `usage_report` shape is experimental. Schema drift pauses readings with
  `CLAUDE_CODE_CONTRACT_CHANGED` and keeps last-known-good state.
- The image grows by about 300 MB per architecture for the official binary.

## Owner decision required

Before setting `AWM_CLAUDE_CODE_TRIGGER_ENABLED=true`, the owner must accept that
a scheduled ordinary request is acceptable for their own subscription under
Anthropic's Consumer Terms and Usage Policy. This is project authorization, not
Anthropic approval. The owner should also authorize one live acceptance
(`/usage` plus one `Hi!`) to confirm the inferred semantics.
