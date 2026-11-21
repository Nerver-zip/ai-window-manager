# ADR-011 — OpenCode Go provider: official-client usage read and gated 5-hour window start

Status: Accepted. The owner authorized the quota-consuming window start for their own OpenCode Go subscription on 2026-11-21.

## Context

OpenCode Go is a subscription with a shared dollar allowance and three limits:
a 5-hour limit (20% of the monthly allowance), a weekly limit (50%, resetting
Monday 00:00 UTC) and a monthly limit that resets when the paid period starts.
[SPIKE-008](../research/spikes/SPIKE-008-opencode-go.md) found:

- Only the 5-hour window needs to be started. The official Go docs say it
  "starts when you first use your allowance and lasts five hours". The weekly and
  monthly windows start by themselves and are never targets.
- The official OpenCode client can read the signed-in workspace's Go meters
  itself, so AWM does not need to hold an API key. A third-party widget
  (`ai-usagebar`) reads the same data by calling the Console endpoint with a
  Bearer key it takes from the operator's environment or from OpenCode's own
  credential files. AWM must not do either.

## Decision

1. **Identity.** The provider ID and kind are `opencode_go`. The canonical
   windows are `opencode_go_five_hour` (server meter `rolling`),
   `opencode_go_weekly` (`weekly`) and `opencode_go_monthly` (`monthly`). Only
   `opencode_go_five_hour` is a trigger target.
2. **Runtime.** AWM runs the unmodified official `opencode` binary with
   `--standalone` (a private, per-invocation server) in a dedicated home
   directory that is also every XDG base directory, an empty private working
   directory, and an allowlisted environment. Nothing inherited (API keys,
   `OPENCODE_*`, AWM secrets) reaches the client. The updater is disabled with
   `OPENCODE_DISABLE_AUTOUPDATE=1`. AWM never reads `auth.json`, `opencode.db`
   or any credential file, and never calls an OpenCode HTTP endpoint itself.
3. **Monitoring.** `opencode --standalone api GET /api/experimental/usage/limits`
   returns `{location, data}`. `data` is `null` when the home is not signed in to
   an OpenCode Console workspace; otherwise it holds `go: {rolling, weekly,
monthly}` with `percent` (0–100), `limited` and `resetsAt` (epoch ms), plus
   workspace and budget fields that AWM ignores. The read sends no model
   request. The route is experimental and internal to the client, so its
   contract class is `official_client_internal`. AWM validates it strictly:
   - an HTML response (the client's web-app fallback for an unknown route) or an
     envelope that no longer matches is `OPENCODE_GO_CONTRACT_CHANGED` and keeps
     last-known-good state;
   - `data: null` is `AUTH_REQUIRED` (`OPENCODE_GO_AUTH_REQUIRED`). A bare
     provider API key has no Console workspace and reads as signed out;
   - a workspace without `go` is `DEGRADED` (`OPENCODE_GO_NOT_SUBSCRIBED`).
     The default poll interval is 120 s.
4. **Phase semantics.** These follow the Claude Code and Codex lessons:
   - a future reset with consumption is `ACTIVE` at high confidence;
   - a future reset with zero consumption is `UNKNOWN`. Before the first request
     the server reports the rolling reset five hours out, which looks like an
     anchored window in a single snapshot, so the temporal tracker decides;
   - `limited` or 100% is `EXHAUSTED`;
   - a reset at or before the read is `RESET_DUE`, never a new allowance;
   - a reset implausibly far beyond the window (5 h + 1 h, 7 d + 1 d, 35 d) is a
     contract change.
     The monthly window claims no fixed duration because it follows the paid
     period.
5. **Allowance sharing.** A start counts against one shared allowance, so the
   scheduler's allowance gate treats all three canonical windows as consumed
   together. An exhausted weekly or monthly window blocks a 5-hour start.
6. **Window start.** `AWM_OPENCODE_GO_TRIGGER_ENABLED` defaults to **true**, like
   the other configured providers (AGENTS.md). Operators opt out with `false` or
   with persisted monitoring-only/manual settings. When enabled, the capability
   advertises only `opencode_go_five_hour`, with `consumesQuota: true`. The
   action:
   - generates the exact session ID (`ses_` + 26 alphanumerics) and persists an
     `opencode_session` cleanup job **before** any process exists;
   - passes the executor's final dispatch gate immediately before spawning;
   - runs `opencode --standalone run --format json --session <id> --archived
--model <approved> "Hi!"` with a bounded runtime and bounded output, and
     without `--auto`, so any permission request is rejected;
   - discards every event's text. Only the event type, the session ID and the
     provider error class are read.
7. **Outcome classification.** A `provider.no-route` error before any step began
   means no model request was made, so the start is `failed`. A session ID that
   does not match, a timeout or cancellation after spawn, malformed or oversized
   output, any other error event, or a clean exit without a completed step is
   `uncertain` and is never retried. `succeeded` needs exit 0, a `step_finish`
   event and no error. Confirmation requires a fresh, independent usage read that
   shows the target `ACTIVE` in the bound cycle.
8. **Cleanup.** The trigger session is disposable. The retryable cleanup worker
   runs `opencode --standalone session delete <id>` for the exact registered ID
   only. An already-missing session ("Session not found: <id>" for that same ID)
   counts as deleted. Any other failure leaves the job retryable. A failed
   cleanup never repeats the quota-consuming action. The schema gains the
   `opencode_session` artifact kind (migration 015).
9. **Model.** `AWM_OPENCODE_GO_TRIGGER_MODEL` must be `opencode-go/<model>`; the
   default is `opencode-go/deepseek-v4.1-flash`, a low-price paid Go model.
   Free models are not used: whether they draw Go allowance is unverified, so
   they cannot be assumed to start the window.
10. **Authentication.** The operator signs in once with the unmodified official
    CLI in the dedicated home (`opencode auth login opencode`, the Console
    login), from a terminal. AWM relays no codes or keys. A guided browser flow
    in Settings and a packaged, pinned client are deferred (see below).

## Consequences

- Monitoring needs only a Console sign-in in AWM's isolated home. A Go-only API
  key is not sufficient and is reported as `OPENCODE_GO_AUTH_REQUIRED`.
- The usage route is experimental. Schema drift pauses readings with
  `OPENCODE_GO_CONTRACT_CHANGED` and keeps last-known-good state; the documented
  `/inference/go/v1/usage` Bearer endpoint is a possible fallback that would
  need its own credential-handling decision.
- A start is one ordinary request on a paid Go model. It creates a disposable
  archived session that AWM deletes by exact ID.
- OpenCode's terms prohibit processes that run while the user is logged out and
  automated extraction. The owner accepted the scheduled start for their own
  subscription; other operators can opt out.

## Deferred

- A pinned, checksum-verified OpenCode release in the container image, the
  provider-client updater integration, and a Settings-guided PTY sign-in driver.
  Until then `AWM_OPENCODE_GO_EXECUTABLE` points at an operator-supplied official
  binary and sign-in is done from a terminal.
- A live acceptance of the start (one `Hi!` on the owner's account). Everything
  above about the success path is derived from the client source and fakes; only
  the signed-out failure path and the usage route were exercised against the
  real binary.
