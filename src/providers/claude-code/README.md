# Claude Code adapter

Decision: [ADR-009](../../../docs/adr/009-claude-code-provider.md). Evidence:
[SPIKE-007](../../../docs/research/spikes/SPIKE-007-claude-code.md).

- **Read.** `claude -p --output-format stream-json --verbose --no-session-persistence --tools "" --strict-mcp-config --setting-sources "" /usage`.
  The read is accepted only when the result is the local `usage` command with
  `num_turns: 0`. The experimental `usage_report.rate_limits.limits[]` rows are
  validated: `session` maps to `claude_code_five_hour`, `weekly_all` maps to
  `claude_code_seven_day`, and other meters become observed-only windows. A
  missing report is classified through `claude auth status --json`.
- **Start** (only when `triggerEnabled`). The executor gate runs, then
  `claude -p <same flags> --max-turns 1 --disable-slash-commands --model <approved> "Hi!"`.
  `system/init` must report no tools, no MCP servers, `apiKeySource: "none"` and
  the approved model. Text is discarded. Ambiguity after spawn is `uncertain`.
- **Environment.** `HOME` and `CLAUDE_CONFIG_DIR` both point to the dedicated
  state directory. Only an allowlisted environment is passed, with the updater,
  auto-memory and prompt history disabled. Nothing inherited (API keys, OAuth
  tokens, AWM secrets) reaches the CLI.
- **Never.** No `--bare`, no `setup-token`, no private HTTP endpoints, no
  reading of `.credentials.json`, no browser-relayed sign-in codes.

`protocol.ts` parses untrusted CLI output and never returns conversation text.
`transport.ts` bounds runtime, stdout, line length and stderr.
