# Provider research and adapter policy

Provider research last refreshed: **2026-11-24** (Antigravity); **2026-11-21** (OpenCode Go); **2026-11-04** (Claude Code); **2026-10-20** (Codex).

## Normalized adapter contract

Provider-specific parsing ends at the runtime-validated `ProviderObservationSchema` in `src/domain/schemas.ts`. Adapters preserve provenance and certainty in `Fact<T>` values:

- `EvidenceSource` describes where a normalized value came from (`observed`, `inferred`, `estimated`, and so on);
- `Confidence` describes how actionable or certain that value is;
- `CapabilityContract` separately describes how stable/supportable the mechanism behind a capability is.

These concepts must not be collapsed. For example, an inferred reset can be deterministic and high-confidence, while a trigger mechanism can be `official_client_internal`. Window phase is also a fact, so adapters must return `phase: Fact<WindowPhase>` rather than a bare lifecycle string.

Capabilities remain truthful and explicit. Read capabilities use `supported` plus a `CapabilityContract`; trigger capabilities additionally set `consumesQuota` to `true`, `false`, or `'unknown'`. Unsupported or unaccepted behavior remains monitor-only. Experimental/unversioned paths require explicit project acceptance, truthful classification, and an explicit runtime gate; the application default for an accepted provider can be disabled by the operator. They must not be emulated through undocumented endpoints or credential handling.

The words below are contractual classifications, not rhetorical labels:

- **SUPPORTED**: current official public documentation or documented official client surface.
- **OBSERVED / INTERNAL**: seen in official source/runtime/community evidence but not a stable external contract.
- **INFERRED**: logically derived, not explicitly guaranteed.
- **UNKNOWN**: evidence is insufficient; implementation must fail closed or create a spike.

## OpenAI Codex

### Supported

- Depending on the plan, Work and Codex can have a five-hour usage window plus a weekly window.
- A new five-hour window starts when the user sends the first Work/Codex message after the previous five-hour window ends.
- Current allowance and reset times are surfaced in Settings → Usage; limits vary by plan and workload/model/settings affect consumption.
- The official open-source Codex app-server protocol includes `account/rateLimits/read` and rate-limit update notifications. Its schema represents used percentage, reset time/window duration and multiple quota buckets.
- The official app-server also exposes `thread/start`, `turn/start` and the
  `turn/completed` lifecycle used by the quota-consuming Codex action adapter.
- The official app-server exposes `thread/delete`; AWM durably registers the
  trigger thread ID before `turn/start` and retries deletion independently.
- Codex supports authenticated ChatGPT account flows in its official client; auth ownership should remain with the official client rather than this project reimplementing OAuth.

SPIKE-001 confirmed that the documented app-server stdio/JSONL lifecycle and
`account/rateLimits/read` are suitable for the adapter. The adapter is
implemented in `src/providers/codex/`, requires a dedicated persistent
`CODEX_HOME` and official client-owned authentication. In the application,
the quota-action gate defaults on for an enabled provider; operators can set
`AWM_CODEX_TRIGGER_ENABLED=false` or choose monitoring-only/manual settings to
opt out. Child stdin/stdout errors and early process exit are converted into
sanitized transport failures; a broken pipe cannot escape as an unhandled
daemon exception.

### Observed / internal

- Official Codex source contains backend reads such as `/api/codex/usage` and a ChatGPT-path `.../wham/usage` plus account headers/token handling.
- These URLs are implementation details of the official client. AI Window Manager must **not** treat them as a stable public contract.
- Reset/percentage snapshots may be temporarily absent or inconsistent during backend entitlement/capacity changes; the normalized model must tolerate null/partial windows.

### Inferred, but not automation-proven

- Because OpenAI explicitly defines the first Work/Codex message after expiry as the new window start, one ordinary minimal Codex request may position the start time. It necessarily consumes some included usage and is not a zero-cost “start window” API.
- SPIKE-004 was validated by an operator-authorized AWM `Hi!` heartbeat in the
  dedicated runtime. Before the turn, fresh inspections projected the reset
  forward; after it, the reset stayed anchored and counted down. This validates
  the operational effect, not a new official lifecycle field: reset-time phase
  remains explicitly inferred; the operator can disable automatic starts.

The 2026-09-30 incident exposed two unsafe shortcuts: zero rounded usage was
treated as inactivity, and a completed turn was treated as window confirmation.
Codex now returns unknown phase for a single zero-used/expired snapshot. The
application persists temporal reset evidence to distinguish a rolling
projection from an anchored window, and confirms the effect with a fresh
observation even after `turn/completed`. Automatic dedupe follows the observed
window cycle, not fixed five-hour wall-clock buckets. No new provider endpoint,
credential handling or quota-consuming probe is involved in this correction.

### Unknown

- The exact allowance cost of a minimal trigger across all models/plans/workspaces.
- Whether every future plan will preserve the same five-hour semantics.
- Whether a dedicated supported “start window without a task” operation will ever exist.
- Which official Codex client interface will remain the most stable long-term integration seam.

### Risk / policy

OpenAI Terms of Use prohibit circumventing rate limits/restrictions or bypassing protective measures. This project must not increase quota, rotate accounts, use saved/purchased resets automatically to manufacture extra allowance, or hide traffic. It only schedules a normal request inside quota the user legitimately possesses.

**Implemented MVP capability**

```text
can_query_usage       = true  (official Codex client/app-server surface)
can_query_reset       = true  when returned by provider; nullable otherwise
can_trigger_window    = true only with `AWM_CODEX_TRIGGER_ENABLED=true` and
                         persisted provider mode `automation`
trigger_consumes_quota= true (one ordinary official app-server turn; sends `Hi!`)
public_usage_api      = false
internal_usage_api    = observed but intentionally unused by default
```

The implemented Codex adapter declares the trigger capability only when the
explicit trigger gate is enabled. A live operator acceptance sent exactly one
ordinary `Hi!` turn. At the time, the app-server response exceeded the old
five-second local deadline and was therefore classified as uncertain, while
later observation confirmed the reset transition. The action path now uses a
separate bounded 30-second default controlled by
`AWM_CODEX_ACTION_TIMEOUT_SECONDS`; a timeout after dispatch remains
uncertain and is never retried blindly. It degrades to a bounded
`AUTH_REQUIRED`/`UNAVAILABLE`/`ERROR` observation if the official client cannot
be initialized safely on the server. It never calls `/api/codex/usage` or
`/wham/usage`. A timeout or EOF after `turn/start` is uncertain and is never
blindly retried.

## Google Antigravity

### Supported

- The official Antigravity CLI provides `/usage` (alias `/quota`) to refresh
  quota status and view model groups. AWM reads it through the official
  headless `agy -p /usage --output-format json` command.
- Google's [CLI usage documentation](https://antigravity.google/docs/cli/commands/usage/)
  says models within each group share that group's five-hour and weekly limits.
  Its [plans page](https://antigravity.google/docs/plans) places Gemini 4 Argon
  within the shared Gemini quota for paid Google AI Pro. As checked on
  2026-11-24, the [models page](https://antigravity.google/docs/models) listed
  Gemini 4 Argon as leaving on November 30, 2026; availability remains plan-
  and time-dependent.
- The official CLI headless mode and OS keyring/Secret Service authentication
  are used. These facts do not establish that a third-party application may
  wrap the CLI under every account's plan terms.

### Evidence and limits

The public documentation establishes the shared Gemini and Claude/GPT quota
families and the model-to-family relationship. It does not publish a stable
machine-readable bucket ID or versioned nested `/usage` JSON contract. AWM has
not performed a current authenticated `/usage` read for this refactor, so no
current bucket ID or live account state is claimed. The existing adapter still
validates the official CLI's bounded JSON and treats nested output as an
`observed_undocumented` client contract that can drift.

Historical AWM versions represented Gemini 4 Argon as a separate weekly quota
using the observed bucket ID `gemini-argon-wtu-weekly`. That independent target
is retired. The ID and old fixture remain only as migration/regression history;
the adapter ignores that bucket and Argon-like transitional rows so they cannot
mask current canonical Gemini or Claude/GPT windows. Other current windows
still pass through the canonical `ProviderObservationSchema` boundary.

One operator-provided 2026-11-14 run sent a prompt using
`gemini-4-argon-low` and observed the then-separate Argon weekly row become
active. This is historical account/client evidence only. It does not show that
an independent Argon allowance exists now, identify a current bucket, or
establish universal start behavior. The Argon model remains selectable under
the Gemini model setting while the official CLI offers it. AWM verifies the
selected model using the action stream's `init.model` before prompt dispatch and
retains the short tool-free model-specific prompt based on that prior evidence.
A post-dispatch mismatch remains uncertain and is never retried.

The adapter's normalized `INACTIVE`, `ACTIVE` and `EXHAUSTED` phase is inferred
from remaining fraction using a bounded `0.00001` endpoint tolerance; Google
does not report those lifecycle values. A `99.95%` remaining window stays
active. Successful usage reads use the CLI completion time, avoiding a stale
pre-command observation timestamp when inferring rolling resets.

### Risk and policy

The [Antigravity FAQ](https://antigravity.google/docs/faq/) cautions that
third-party access may violate its terms and that wrapping headless `agy -p`
is unsupported under consumer plans. Project authorization is not Google
approval. AWM uses the official CLI and does not extract credentials or
reproduce internal endpoints. A normal prompt can consume quota; it is not a
dedicated window-start operation.

The capability remains `observed_undocumented` and quota-consuming. One global
Antigravity gate controls both configured families. Trigger requests are exact
window-targeted, require provider automation mode and durable intent, and stay
serialized provider-wide until confirmation or safe terminal resolution. An
uncertain result is never blindly retried. Trigger conversations are registered
for exact-ID cleanup before dispatch; cleanup failure does not repeat the
prompt.

```text
can_query_usage       = official CLI `/usage` read; nested JSON is unversioned
can_query_reset       = only when a validated current bucket includes reset time
can_trigger_window    = Gemini / Claude-GPT exact targets, observed_undocumented
trigger_consumes_quota= true
argon quota target    = none; Gemini 4 Argon is a model in the Gemini family
consumer_quota_api    = none documented
enterprise_quota_api  = backend details not used by this adapter
```

The CLI trigger protocol verifies the selected model from the stream's
`init.model`, durably registers the exact conversation UUID, then sends one
fixed ordinary prompt. For the three Gemini 4 Argon model slugs, AWM uses the
short tool-free `ANTIGRAVITY_ARGON_MODEL_TRIGGER_MESSAGE`; for other models it
uses `Hi!`. The model check and prompt are compatibility safeguards grounded in
historical client evidence, not proof of the present quota bucket identity.
Timeout, EOF, malformed output or auth-looking output after a prompt may have
been sent is ambiguous and remains `uncertain`.

No machine-usable Antigravity conversation-delete command is used. With the
operator's authorization for exact-ID cleanup, AWM removes only the matching
UUID-named conversation database and its SQLite sidecars, plus that UUID's
`brain/` directory, under the dedicated CLI home. It does not open or edit
shared indexes, auth, keyring, or unrelated conversation data, traverse
symlinks, or automate the provider TUI. If the observed local storage layout
changes, cleanup fails safely and the durable job remains pending.

## Anthropic Claude Code

Details, sources and probe evidence: [SPIKE-007](research/spikes/SPIKE-007-claude-code.md).
Decision: [ADR-009](adr/009-claude-code-provider.md). Pinned client: `2.1.311`
(stable channel).

### Supported

- Pro, Max and other subscription plans have a five-hour session limit plus a
  weekly limit. "The period starts when you send your first message, and your
  limit resets in full five hours later." Claude, Claude Code and Desktop share
  these limits.
- Headless `claude -p` with `--output-format stream-json`,
  `--no-session-persistence`, `--tools ""`, `--strict-mcp-config`,
  `--setting-sources`, `--disable-slash-commands`, `--model` and `--max-turns`.
- `claude auth status --json` (exit 0 when signed in, 1 when not) and the
  browser-plus-pasted-code `claude auth login`.
- AWM Settings can guide the official `claude auth login` flow through the
  shared authentication session. It accepts HTTPS URLs only from the exact
  observed host `claude.com`; the CLI's one-time bootstrap URL is allowed only
  at `/cai/oauth/authorize` with the observed OAuth parameter names, each once:
  `code`, `client_id`, `response_type`, `redirect_uri`, `scope`,
  `code_challenge`, `code_challenge_method` and `state`. Values are bounded;
  the code is nonempty and printable within the 2,048-character URL limit,
  `response_type` must be `code`, the
  PKCE method must be `S256`, and the callback must be
  `https://platform.claude.com/oauth/code/callback`. Unknown
  or duplicate parameters and other callbacks are rejected. That URL is exposed
  only through the authenticated, in-memory sign-in session, is never
  persisted or logged, and the operator opens it explicitly; AWM does not open
  browser tabs on its own. PTY parsing accepts visible URLs and OSC 8
  terminal-link targets, and reassembles the bootstrap URL if terminal width
  wraps it across lines. A browser-returned code is forwarded directly to the
  active CLI process and is not retained. The dedicated Claude state volume
  remains isolated. See [ADR-009](adr/009-claude-code-provider.md) for the
  contractual interpretation risk and terminal fallback.
- An experimental `usage_report` (SDK `SDKUsageReport`) on the message that
  delivers a `/usage` result.
- Signed release manifests: an OpenPGP detached signature over per-platform
  SHA-256 checksums.

### Observed

- `claude -p /usage` runs as a local command: a synthetic model, `num_turns: 0`
  and `duration_api_ms: 0`. This was checked on 2.1.311 and 2.1.318 without
  credentials. Rows are `{kind, group, percent, resets_at, scope?, severity, is_active}`
  with kinds `session`, `weekly_all` and `weekly_scoped`.
- With the trigger flags, `system/init` reports no tools, no MCP servers and
  `apiKeySource: "none"`. A missing login is reported as
  `authentication_failed` before any API call.
- `--no-session-persistence` with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` writes no
  transcript. This was checked on the auth-failure path only.

### Inferred

- `session` is the five-hour window and `weekly_all` is the weekly window.
- `/usage` consumes no model allowance; it is still a server read and is
  polled at most every 120 s by default.
- Operator-provided official CLI evidence (2026-11-04) showed that an
  unstarted current session reports 0% used without a reset. AWM therefore
  treats only the unscoped canonical `session` meter with exact zero use and no
  reset as `INACTIVE`/high, allowing an explicitly enabled auto policy to
  bootstrap its first five-hour window. Nonzero use without a reset and
  zero-use future resets remain non-actionable. This interpretation should be
  rechecked if the CLI changes its `/usage` output.
- One ordinary `Hi!` anchors the five-hour window and also counts against the
  weekly allowance.

- Live acceptance (owner-authorized, 2026-11-03, host CLI 2.1.318): an
  authenticated `/usage` read returned `session` and `weekly_all` rows
  (integer `percent`, ISO resets) with `num_turns: 0`. One `Hi!` through the
  adapter succeeded (`haiku`, no tools or MCP, `apiKeySource: none`), and a
  fresh `/usage` read confirmed the five-hour window `ACTIVE`. No session file
  was written. See SPIKE-007.

### Unknown

- The idle-window `/usage` shape, and whether a `Hi!` from an idle state anchors
  a new window on every plan. The live test ran inside an already active window.
- Whether scheduled starts are acceptable under Anthropic's Consumer Terms in
  general. The owner accepted this for their own subscription (ADR-009); other
  operators can opt out.

### Risk / policy

Anthropic's [current guidance](https://code.claude.com/docs/en/legal-and-compliance)
says an end user may sign in to the unmodified Claude Code binary with their own
subscription, including on a hosted platform, and also says developers may not
collect, store or intermediate Claude.ai credentials or session tokens. AWM is
self-hosted and single-operator, but the Settings flow briefly forwards an
operator-entered one-time code to the official CLI. The guidance does not
clearly settle whether that handoff is considered credential intermediation in
this deployment. AWM keeps the code only in the active process session and
offers a terminal fallback for operators who want the code to stay entirely
between their browser and the official CLI. AWM never reads credential files,
calls private Anthropic endpoints, or modifies the binary.

The trigger still uses the `haiku` alias and does not set an effort flag. The
pinned CLI probe resolved `haiku` to `claude-haiku-5-5`; AWM passes an explicit
`--model` and disables user/project/local settings sources for the isolated
trigger, so saved settings do not override model or effort selection. No
`--effort` argument is passed; the CLI default applies, and the probe did not
measure the effective effort. A model-ID or effort change is a separate
operator decision.

**Implemented capability**

```text
usageRead / resetRead = official_supported; official /usage local command, experimental report
windowTrigger         = enabled by default; AWM_CLAUDE_CODE_TRIGGER_ENABLED=false opts out;
                        claude_code_five_hour only; consumesQuota=true
weekly / scoped meters= monitored only, never targets
confirmation          = fresh independent /usage read; process exit never confirms
cleanup               = none required (--no-session-persistence)
```

## OpenCode Go

Details, sources and probe evidence: [SPIKE-008](research/spikes/SPIKE-008-opencode-go.md).
Decision: [ADR-011](adr/011-opencode-go-provider.md).

### Supported

- Go has a 5-hour limit (20% of the monthly allowance), a weekly limit (50%,
  "resets on Monday at 00:00 UTC") and a monthly limit that resets "when a new
  paid period starts". Models share one dollar allowance.
- "The window starts when you first use your allowance and lasts five hours."
  Only the 5-hour window therefore needs a start; the weekly and monthly windows
  start by themselves and are never trigger targets.
- At a limit, free models keep working, and "Extra Usage" can fall back to
  Console credits.
- The official headless `opencode run`, `--format json`, `--session`, `--archived`,
  `opencode session delete` and `opencode api` commands.

### Observed / internal

- The official client's private server (`opencode --standalone api GET
/api/experimental/usage/limits`) returns the signed-in Console workspace's Go
  meters: `percent`, `limited` and `resetsAt` (epoch ms) for `rolling`, `weekly`
  and `monthly`. It sends no model request. The route is experimental; the client
  returns `data: null` when no Console workspace is signed in.
- A documented Bearer endpoint, `GET /inference/go/v1/usage`, returns the same
  three meters. AWM does not use it because that needs an API key held by AWM.

### Inferred

- Before the 5-hour window starts, the rolling reset is five hours from now (a
  moving projection). One ordinary request anchors it. The adapter therefore reports
  zero use with a future reset as `UNKNOWN` and lets the temporal tracker decide.
- A start counts against the shared allowance, so an exhausted weekly or monthly
  window blocks a 5-hour start.

### Unknown

- Whether the 5-hour window restarts at the first request after it expires.
- Whether free models draw Go allowance, and the exact cost of one `Hi!`.
- Whether a Go-only API key (no Console workspace) can be read through the client.
- The success-path event stream of `opencode run --format json` and a live start;
  only the signed-out path and the usage route were run against the real binary.

### Risk / policy

OpenCode's terms prohibit processes that run while the user is logged out and
automated extraction. AWM uses the unmodified official client in an isolated home,
never reads credential files, and sends one ordinary `Hi!` that it deletes by exact
session ID. The owner authorized the start for their own subscription; that is
project authorization, not provider approval.

**Implemented capability**

```text
usageRead / resetRead = official_client_internal; opencode api GET /api/experimental/usage/limits
windowTrigger         = enabled by default; AWM_OPENCODE_GO_TRIGGER_ENABLED=false opts out;
                        opencode_go_five_hour only; consumesQuota=true
weekly / monthly      = monitored only, never targets
confirmation          = fresh independent usage read; process exit never confirms
cleanup               = exact session ID registered before dispatch; `session delete`
credentials           = client-owned Console login in AWM's isolated home, guided in AWM Settings
                        (OAuth device flow, `--method device`); AWM never reads them
```

## Provider contract change detection

For all providers:

1. keep sanitized fixtures of official-client output/protocol payloads;
2. validate structure strictly at the adapter boundary;
3. on parse/schema mismatch, return `UNAVAILABLE`/`degraded` and retain last-known-good state;
4. increment a low-cardinality inspection failure metric;
5. emit a structured event `provider_contract_changed` with no raw secrets/payload;
6. never guess missing reset fields;
7. refresh `docs/providers.md` before adapting the parser.
