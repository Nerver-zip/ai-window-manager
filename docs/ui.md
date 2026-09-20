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
Codex                         Connected
5-hour window  ████████████░░  82% remaining
Reset   13:04 UTC             Reported by provider · High confidence
Updated 03:52 ago             Fresh
Weekly window ████████░░░░░░░  56% remaining

Next: automatic action planned for 08:00 tomorrow
Why: the window can start before the target reset
```

The user-facing vocabulary deliberately hides provider and scheduler identifiers.
For example, `codex_primary` is shown as `5-hour window`, `codex_secondary` as
`Weekly window`, `official_supported` as `Reported by provider`, and inferred
values use `Approximately` plus a plain-language confidence label. Internal
provider ids, window keys, reason codes and evidence enums remain available to
the JSON/API and logs, but are not presented as normal UI copy.

If data is inferred, render `Approximately 13:04` and the evidence/confidence
label. If stale, visually say `last observed 12m ago` and explain that
automatic planning is paused instead of presenting old data as live.

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

The current server-rendered `/schedule` page asks for a provider, a human-readable
usage window, a local reset time, timezone and timing tolerance. It previews the
planned start and explains daylight-saving adjustments without exposing the
stored window key. `/settings` edits monitoring state, automatic-action mode and
refresh interval. Both forms contain a CSRF token; invalid or unsupported values
are rejected before SQLite writes. Secrets and provider-owned auth state are
never editable or rendered.

## Provider settings

- enabled;
- monitoring on/off;
- automatic actions (if supported);
- refresh interval within validated range;
- auth/setup status (never credential values);
- capability matrix;
- “inspect now”.

## History

The server-rendered `/history` page reads persisted SQLite state and never
inspects a provider. It supports bounded `24h`, `7d` and `30d` ranges plus a
provider filter. Timeline events are read in bounded pages of 20, with explicit
previous/next navigation, so a busy daemon does not create an unbounded page.
Keep it small:

- recent lifecycle/action timeline;
- usage over time per five-hour/weekly bucket;
- compact SVG usage series with explicit 0–100% axes, UTC time bounds and unknown values;
- simple day/hour aggregates after sufficient data (deferred).

No enterprise dashboard, no Grafana clone.

## Frontend technology

Server-rendered HTML with a shared dark operations shell and one same-origin
stylesheet at `/assets/app.css`. The current pages use native forms and SVG
history charts without inline styles or scripts, so the CSP remains strict and
the browser does not become another state owner. No React, client router or
large component framework. Add a small chart library only if hand-written SVG
becomes a maintenance burden.
