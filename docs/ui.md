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

## Provider settings

- enabled;
- monitor-only / automation (if supported);
- polling interval within validated range;
- auth/setup status (never credential values);
- capability matrix;
- “inspect now”.

## History

Keep it small:

- recent lifecycle/action timeline;
- usage over time per five-hour/weekly bucket;
- simple day/hour aggregates after sufficient data.

No enterprise dashboard, no Grafana clone.

## Frontend technology

Server-rendered HTML/CSS with a tiny local browser script for periodic refresh/forms. No React, client router or large component framework. Charts can start as compact SVG/HTML; add a small chart library only if hand-written SVG becomes a maintenance burden.
