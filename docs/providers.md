# Provider research and adapter policy

Research date: **2026-09-14**.

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
- Codex supports authenticated ChatGPT account flows in its official client; auth ownership should remain with the official client rather than this project reimplementing OAuth.

### Observed / internal

- Official Codex source contains backend reads such as `/api/codex/usage` and a ChatGPT-path `.../wham/usage` plus account headers/token handling.
- These URLs are implementation details of the official client. AI Window Manager must **not** treat them as a stable public contract.
- Reset/percentage snapshots may be temporarily absent or inconsistent during backend entitlement/capacity changes; the normalized model must tolerate null/partial windows.

### Inferred

- Because OpenAI explicitly defines the first Work/Codex message after expiry as the new window start, one ordinary minimal Codex request can position the start time. It necessarily consumes some included usage and is not a zero-cost “start window” API.
- The safest automation seam is a normal operation through the official Codex client/app-server, in a dedicated empty workspace with tools disabled/scoped, followed by inspection to confirm the state.

### Unknown

- The exact allowance cost of a minimal trigger across all models/plans/workspaces.
- Whether every future plan will preserve the same five-hour semantics.
- Whether a dedicated supported “start window without a task” operation will ever exist.
- Which official Codex client interface will remain the most stable long-term integration seam.

### Risk / policy

OpenAI Terms of Use prohibit circumventing rate limits/restrictions or bypassing protective measures. This project must not increase quota, rotate accounts, use saved/purchased resets automatically to manufacture extra allowance, or hide traffic. It only schedules a normal request inside quota the user legitimately possesses.

**MVP capability proposal**

```text
can_query_usage       = true  (official Codex client/app-server surface)
can_query_reset       = true  when returned by provider; nullable otherwise
can_trigger_window    = true  opt-in, via normal official-client request only
trigger_consumes_quota= true
public_usage_api      = false
internal_usage_api    = observed but intentionally unused by default
```

The Codex adapter must degrade to monitor-only if the official client cannot be initialized safely on the server.

## Google Antigravity

### Supported

- Google AI Ultra receives its baseline Antigravity quota refreshed every five hours plus weekly limits.
- Google AI Pro receives high baseline quota refreshed every five hours until its weekly limit is reached, plus a higher weekly limit.
- Users outside Pro/Ultra are documented as receiving weekly-refresh baseline quota.
- `/usage` (alias `/quota`) in the official Antigravity CLI refreshes quota status from backend and displays model quota usage.
- Official headless mode `agy -p ...` is designed for scripted/CI use and uses cached official CLI credentials.
- Official auth uses the OS keyring/Secret Service and offers an SSH OAuth flow.

### Observed / internal

- The interactive quota panel and CLI output format are user-facing, not a versioned machine-readable quota API. A text parser is therefore fragile even when invoking a supported official command.
- Community/runtime observations can show model-specific five-hour/weekly countdowns, but those formats must not become domain contracts.

### Inferred

- A normal `agy -p` prompt consumes Antigravity quota. It might also be the event that starts/repositions a five-hour window, but current official quota docs found during this research do **not** define the inactive-window start event as explicitly as OpenAI does.

### Unknown

- The exact event that starts an Antigravity five-hour window after inactivity.
- Whether a machine-readable quota/reset command/API exists that is intended for third-party consumption.
- Whether `agy -p /usage` consistently yields parseable non-interactive quota output in every current release/configuration.
- The simplest secure Linux-container strategy for persisting the official CLI keyring without introducing a desktop/keyring daemon burden.
- Whether any automated quota-positioning request is acceptable under Antigravity terms beyond ordinary documented CLI automation.

### Risk / policy

The official Antigravity FAQ explicitly says using third-party software/tools/services to access Antigravity with an Antigravity login violates their Terms and may lead to suspension/termination. AI Window Manager therefore **must not** extract login tokens, reproduce internal backend calls, or impersonate the client.

The only integration path considered is invoking the **official `agy` CLI itself**. Even that should remain behind a compliance/behavior spike for this product's specific use case. If safe auth/inspection is not feasible, the adapter remains monitor-only/unavailable rather than adding hacks.

**MVP capability proposal**

```text
can_query_usage       = experimental/conditional, official CLI only
can_query_reset       = experimental/conditional, only if CLI exposes it reliably
can_trigger_window    = false (UNKNOWN semantics + policy risk)
trigger_consumes_quota= true if ever enabled
public_usage_api      = false / none found
```

## Provider contract change detection

For both providers:

1. keep sanitized fixtures of official-client output/protocol payloads;
2. validate structure strictly at the adapter boundary;
3. on parse/schema mismatch, return `UNAVAILABLE`/`degraded` and retain last-known-good state;
4. increment a low-cardinality inspection failure metric;
5. emit a structured event `provider_contract_changed` with no raw secrets/payload;
6. never guess missing reset fields;
7. refresh `docs/providers.md` before adapting the parser.
