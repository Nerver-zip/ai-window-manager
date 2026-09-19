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
  -> pure target-reset decision
  -> deduplicated planned action_intent
  -> persisted overview/API read model
```

The final arrow is read-only. HTTP handlers do not inspect providers and no
planned intent is dispatched in this milestone.

## Reconciler over durable timers

The daemon wakes every configurable interval (default 30 seconds), loads runtime config/current state/open intents, inspects due providers, computes decisions, and advances intents. Scheduling correctness comes from persisted state + current time, not from a `setTimeout` expected to survive restarts.

## Last-known-good behavior

A transient inspection failure updates provider health and writes an event but does not erase a previous normalized snapshot. Staleness is explicit (`observedAt` + `staleAfter`). Scheduler action gates reject stale/insufficient evidence.
