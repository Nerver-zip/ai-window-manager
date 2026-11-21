# SPIKE-008 — OpenCode Go usage windows, usage read and window starts

**Research checked:** 2026-11-21

**Client probed:** official `opencode` `v2.3.2` (a local install), run only under
a throwaway `HOME` and `XDG_*` tree with no credentials. Nothing was billed to any
account and the operator's own OpenCode state was not read.

**Status:** Monitoring, the gated 5-hour start and exact-ID cleanup are implemented
([ADR-011](../../adr/011-opencode-go-provider.md)) and tested against fakes and
sanitized fixtures. The success path of the start has **not** been exercised live.

Classifications follow [`docs/providers.md`](../../providers.md).

## Conclusion

Only the 5-hour window must be started. The weekly and monthly windows start by
themselves. The official client can report all three meters without a model
request, inside an isolated home, so AWM does not need an API key.

## Window semantics

**SUPPORTED** (official Go docs, https://opencode.ai/docs/go/):

- "The 5-hour limit is 20% of your monthly allowance. The window starts when you
  first use your allowance and lasts five hours."
- "The weekly limit is 50% of your monthly allowance. It resets on Monday at
  00:00 UTC."
- "Your monthly allowance resets when a new paid period starts."
- Models draw from one shared allowance ("Switching models draws from the same
  allowance"); each model's dollar limit is shown in the Console.
- At a limit, free models keep working; "Extra Usage" falls back to Console
  credits instead of blocking.

**OBSERVED** (OpenCode source, `anomalyco/opencode`, default branch `dev`): the
repo only passes the server's `resetsAt` through. Before the 5-hour window starts,
the documentation says `rolling` resets five hours from now (a moving projection).
The monthly bounds follow the subscriber's start time, so the monthly length
varies.

**UNKNOWN:**

- Whether the 5-hour window restarts at the first request after it expires. The
  docs describe the window start only for "first use". Third-party guides call it
  "rolling", and the FAQ says "enforced across rolling windows". The logic runs
  server-side and is not visible in the client.
- Whether free models draw Go allowance (the docs imply they do not, unverified).
- Whether any usage endpoint is rate limited.

## Usage read surfaces

| Surface                                                                                                  | Contract                                 | Credential                 | Used by AWM   |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------- | ------------- |
| `opencode --standalone api GET /api/experimental/usage/limits` (client's private server)                 | `official_client_internal`, experimental | Client's own Console login | **Yes**       |
| `GET https://opencode.ai/inference/go/v1/usage` (documented in the repo docs, not in the published page) | documented Bearer endpoint               | API key in AWM             | No (fallback) |
| `GET https://opencode.ai/zen/go/v1/usage` (what the client and `ai-usagebar` call)                       | internal path of the same data           | API key in AWM             | No            |
| `opencode stats`                                                                                         | local session tokens and cost only       | n/a                        | No            |

Both HTTP paths returned `401 AuthError` without a key (unauthenticated, no quota).

**Third-party comparison.** `ai-usagebar` (`akitaonrails/ai-usagebar`) polls the
`/zen/go/v1/usage` endpoint read-only. It takes the Bearer key from an env var or
config, or reads it from OpenCode's `auth.json` / `opencode.db`. AWM's rules forbid
reading credential files, so it follows the Claude Code / Antigravity pattern of an
isolated client home instead.

## Probes (signed out, throwaway home)

- `opencode --standalone api GET /api/experimental/usage/limits` exits 0 and prints
  `{"location":{"directory":…},"data":null}`. `data` is `null` when no Console
  workspace is signed in. The client source requires a stored credential with
  `metadata.orgID`, so a bare provider API key is expected to read as signed out
  (not verified live).
- An unknown route (`GET /nope`) exits 0 with the client's web-app HTML. The parser
  treats HTML as a contract change.
- Shape of a signed-in response, from the client schema
  (`packages/schema/src/usage-limits.ts`): `data.workspace.{id,name?,usageURL}`,
  `data.go?.{rolling,weekly,monthly}` where each meter is `{percent: 0..100,
limited: boolean, resetsAt: epoch ms}`, and `data.budgets[]`. `go` is absent when
  the member does not subscribe to Go (the client gets a 403).
- `opencode --standalone auth list --format json` prints `[]` signed out.
- `opencode auth login opencode-go` needs an interactive terminal for its API-key
  method; `opencode auth login opencode` offers several methods (the Console login).
- `opencode --standalone run --format json --session <id> --archived --model
opencode-go/<model> "Hi!"` signed out emits one NDJSON line,
  `{"type":"error","sessionID":"<id>","error":{"type":"provider.no-route",…}}`, exits
  1, and still creates the session. Session ID must start with `ses` (`ses_` plus
  26 alphanumerics: 12 hex and 14 base62). An AWM-chosen ID is accepted, so cleanup
  can be registered before dispatch.
- `opencode --standalone session delete <id>` prints `Session <id> deleted` and exits
  0; a missing ID exits 1 with `Session not found: <id>` on stderr.
- Success-path event types (from `packages/cli/src/run/noninteractive.ts`):
  `step_start`, `text`, `reasoning`, `tool_use`, `step_finish`, `error`, `retry`,
  `background_wait`, each as `{type, timestamp, sessionID, …}`. These were **not**
  observed live.

## Terms and automation

The repository copy of OpenCode's terms prohibits "any processes that run or are
activated while you are not logged into the Services" and automated extraction, and
says Go traffic is monitored for abuse. Read-only usage polling is the best-supported
case. A scheduled `Hi!` is a gray area. The owner authorized it for their own
subscription (ADR-011). This is project authorization, not provider approval.

## Live-acceptance checklist (not yet done)

1. Sign in with `opencode auth login opencode` in the AWM home; confirm a signed-in
   `/api/experimental/usage/limits` returns `go` with three meters, and note whether
   a Go-only API key yields `data: null`.
2. Record an idle snapshot: confirm the `rolling` reset is about five hours out at
   0% (moving projection) and what the weekly and monthly meters report.
3. Send one `Hi!` through the adapter. Confirm the event types, that the 5-hour
   reset then stays anchored, that the session is deleted, and what one start costs
   in `percent`.
4. Confirm whether the window restarts at the first request after it expires.
