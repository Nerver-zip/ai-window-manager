# Architecture

## Decision

Use a small TypeScript monolith packaged as one Docker service.

```text
HTTP/UI ─┐
         ├─ application services ─ normalized domain ─ SQLite
reconciler┘         │
                    └─ provider adapters ─ official provider clients

metrics + health + structured logs are in the same process.
```

Provider onboarding is a separate application boundary: a small in-memory
`AuthSessionManager` supervises one official-client sign-in process per
provider, enforces bounded output/time, exposes only a safe session DTO, and
verifies completion through the provider adapter. Credentials remain in the
official client's dedicated state/keyring; auth sessions and submitted codes
are not stored in SQLite.

### Why TypeScript rather than C++ for this project

Both are viable given the existing repositories. C++ would produce a lean runtime and matches `ghinfo`, but this product's hardest work is external-client orchestration, JSON/schema evolution, time-policy tests, a tiny web UI and rapid provider adaptation—not compute. TypeScript reduces implementation surface for those concerns and aligns with the user's current pnpm/TypeScript agent workflow without requiring a frontend framework.

### Why not a TypeScript SPA + API split

It would add a build/application boundary with little user value. Server-rendered HTML and a tiny browser script are enough for a private status page and settings forms.

### One process or multiple?

One deployable service and one owning Node daemon process. When integration requires an official provider executable, the daemon may spawn/supervise a narrowly scoped child process (for example Codex app-server or a one-shot CLI command). These are not separately deployed services and own no scheduling state.

## Critical separation

```text
Provider observation
        │
        ▼
Normalized WindowSnapshot
        │
        ▼
Scheduler Decision
        │
        ▼
Persisted ActionIntent
        │
        ▼
Provider Action
        │
        ▼
Confirmation observation / result
```

The scheduler cannot import provider-specific transports. The provider adapter cannot choose when a trigger is desirable. The UI cannot know auth implementation details.

The current runtime implements the observation-to-intent planning path:

```text
reconciler tick
  -> due adapter inspection
  -> canonical observation validation
  -> provider_state + window_samples + event
  -> pure activation-policy decision
  -> deduplicated planned action_intent
  -> persisted overview/API read model
```

The application executor then handles only due, eligible intents:

```text
planned intent
  -> atomic claim
  -> capability/mode/preflight guard
  -> one provider dispatch through its official-client adapter
  -> persisted result
  -> fresh inspection confirmation or uncertain state
```

For Codex the action is one `turn/start` through the official app-server. For
Antigravity the opt-in experimental action is one fixed `Hi!` invocation through
the official headless `agy -p` CLI. The scheduler and generic executor contain
no provider endpoint, token format, CLI model semantics, or credential parsing.
Each intent stores one exact normalized window target; changing the canonical
provider policy replaces that target for future planning.

HTTP handlers do not inspect providers or dispatch actions. Settings and
activation-policy forms validate non-secret values and persist them in SQLite; all
mutations require same-origin Origin and double-submit CSRF proof.

The server-rendered Overview may create a manual intent for an exact normalized
window using a protected form. That command path persists the intent and asks
the executor/reconciler to wake; it does not call an adapter or dispatch an
action synchronously.

## Reconciler over durable timers

The daemon wakes every configurable interval (default 30 seconds), loads runtime config/current state/open intents, inspects due providers, computes decisions, and advances intents. Scheduling correctness comes from persisted state + current time, not from a `setTimeout` expected to survive restarts.

## Last-known-good behavior

A transient inspection failure updates provider health and writes an event but does not erase a previous normalized snapshot. Staleness is explicit (`observedAt` + `staleAfter`). Scheduler action gates reject stale/insufficient evidence.
