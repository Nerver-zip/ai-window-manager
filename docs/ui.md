# Web UI

Goal: within seconds answer:

1. which window is active?
2. how much remains?
3. when does it reset, and how confident is that time?
4. what is the next planned/recommended action?
5. why?

## Overview

One provider card per configured provider:

```text
Codex                         ACTIVE
5-hour  ████████████████░░░░  82% remaining
Reset   13:04                 exact · provider
Age     03:52
Weekly  ███████████░░░░░░░░░  56% remaining

Next: trigger candidate 08:00 tomorrow
Why: target reset 13:00 - observed 5h window
```

If data is inferred, render `~13:04` and the evidence/confidence label. If stale, visually say `last observed 12m ago` instead of presenting old data as live.

The overview is backed by persisted `provider_state`, recent scheduler/events,
and action-intent records. Opening `/` or `/api/v1/providers` does not call a
provider adapter. A provider with no persisted observation renders health,
freshness and window facts as `unknown` rather than fabricated zeroes.

## Schedule

- desired reset local time;
- desired work period;
- recommendation explanation;
- manual `Trigger now` only when capability/automation mode permits;
- next action + reason.

The current server-rendered `/schedule` page edits target-reset policy fields,
previews the next IANA occurrence, and labels DST adjustment/ambiguity. `/settings`
edits enabled state, mode and polling interval. Both forms contain a CSRF token;
invalid or unsupported values are rejected before SQLite writes. Secrets and
provider-owned auth state are never editable or rendered.

## Provider settings

- enabled;
- monitor-only / automation (if supported);
- polling interval within validated range;
- auth/setup status (never credential values);
- capability matrix;
- “inspect now”.

## History

The server-rendered `/history` page reads persisted SQLite state and never
inspects a provider. It supports bounded `24h`, `7d` and `30d` ranges plus a
provider filter. Keep it small:

- recent lifecycle/action timeline;
- usage over time per five-hour/weekly bucket;
- compact SVG usage series with explicit unknown values;
- simple day/hour aggregates after sufficient data (deferred).

No enterprise dashboard, no Grafana clone.

## Frontend technology

Server-rendered HTML with a shared dark operations shell and one same-origin
stylesheet at `/assets/app.css`. The current pages use native forms and SVG
history charts without inline styles or scripts, so the CSP remains strict and
the browser does not become another state owner. No React, client router or
large component framework. Add a small chart library only if hand-written SVG
becomes a maintenance burden.
