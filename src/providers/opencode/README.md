# OpenCode Go adapter

Decision: [ADR-011](../../../docs/adr/011-opencode-go-provider.md). Evidence:
[SPIKE-008](../../../docs/research/spikes/SPIKE-008-opencode-go.md).

- **Read.** `opencode --standalone api GET /api/experimental/usage/limits`. The
  client starts a private server, uses its own Console login and returns
  `{location, data}`. `data: null` is signed out (`AUTH_REQUIRED`); no `go` object
  is a workspace without a Go subscription (`DEGRADED`). `rolling` maps to
  `opencode_go_five_hour`, `weekly` to `opencode_go_weekly` and `monthly` to
  `opencode_go_monthly`. An HTML response (route gone) or a changed shape is
  `OPENCODE_GO_CONTRACT_CHANGED`.
- **Start** (only when `triggerEnabled`, 5-hour window only). AWM generates the
  exact session ID, persists an `opencode_session` cleanup job, runs the executor
  gate, then
  `opencode --standalone run --format json --session <id> --archived --model <opencode-go/model> "Hi!"`
  (no `--auto`). Event text is never parsed or kept. Ambiguity after spawn is
  `uncertain` and is never retried.
- **Cleanup.** `opencode --standalone session delete <id>` for the exact
  registered ID only. An already-missing session counts as deleted.
- **Environment.** `HOME` and every `XDG_*` directory point to the dedicated home.
  Only an allowlisted environment is passed, with the updater disabled. Nothing
  inherited (API keys, `OPENCODE_*`, AWM secrets) reaches the client.
- **Never.** No reading of `auth.json` or `opencode.db`, no OpenCode HTTP calls
  from AWM, no `--auto`, no TUI automation.

`protocol.ts` parses untrusted client output and never returns conversation text.
The bounded-process runner is shared with the Claude Code adapter
(`../cli-process.ts`).
