# Web UI

The deterministic FakeProvider is shown only when
`AWM_FAKE_PROVIDER_ENABLED=true`. With the setting false, previously persisted
fake state is omitted from the overview, provider settings, schedule, history,
JSON read/command routes, Usage, and metrics; SQLite history is preserved.

The overview should answer at a glance:

1. which usage windows are available?
2. how much has been used and how much remains?
3. when does each window reset in my local time and in UTC?
4. which start policy is selected, and is it enabled?
5. is the provider information current?

## Overview

When more than one provider is available, compact logo cards select which
provider to inspect. Only the selected provider's full overview is shown, so
usage windows and policy details stay focused instead of competing side by
side. The same selector indicates connection status; providers that still need
setup appear muted. With one provider, the selector is omitted.

```text
Codex                         Connected
5-hour window  25% used · 75% left
Resets Sep 23, 7:00 PM · in about 5 hours
UTC Sep 23, 10:00 PM
Weekly window  56% used · 44% left

Selected start policy: Whenever possible
5-hour window · starts after a fresh check confirms availability
Active · each start still requires a fresh provider check
```

The user-facing vocabulary deliberately hides provider and scheduler identifiers.
For example, `codex_primary` is shown as `5-hour window` and `codex_secondary`
as `Weekly window`. Estimated values are prefixed with `About`; confidence,
evidence enums, and provider transport details are not part of the main view.
Internal provider ids, window keys and reason codes remain available to the
JSON/API and logs, but are not presented as normal UI copy.

If data is estimated, render `About 7:00 PM` and the corresponding UTC time.
If stale, say `Last checked 12 min ago`, make that information visibly out of
date, and explain that automatic starts wait for a fresh update.

The overview is backed by persisted `provider_state`, saved activation policies,
and provider capability declarations. Opening `/` or `/api/v1/providers` does
not call a provider adapter. A provider with no persisted observation renders
health, freshness and window facts as `unknown` rather than fabricated zeroes.

Each provider card shows connection and monitoring status, human-readable window
names, used/remaining amounts, local and UTC reset times, and the currently saved
start policy with its window/time settings in plain language and a direct link to
change it. Paused,
monitoring-only, unsupported, missing, or invalid policies are called out rather
than being presented as active. Technical window keys never appear as normal
labels.

The Overview does not duplicate the scheduler's next-decision explanation. The
Schedule page owns the persisted decision and live preview, and still never
inspects a provider while rendering either page.

## Schedule

- current observed window;
- start when a window becomes available, on a regular cycle, at chosen times,
  during selected hours, or manually;
- the saved local time zone, with first-use device detection and an explicit
  override in Settings;
- add/remove controls for custom times and active-hour periods;
- upcoming occurrences and the authoritative next decision/reason;
- manual `Trigger now` only when capability/automation mode permits.

The current server-rendered `/schedule` page reveals only the fields relevant to
the selected preference. The next-start preview uses saved provider information
and shows a local time and time zone, along with a plain-language explanation.
Internal timing tolerance and daylight-saving resolution details do not appear
in the normal form. `/settings` edits monitoring, automatic starts, check
frequency and the account time zone. Both forms contain a CSRF token; invalid or
unsupported values are rejected before SQLite writes. Secrets and provider-owned
auth state are never editable or rendered.

## Provider settings

- enabled;
- monitoring on/off;
- automatic actions (if supported);
- check frequency presets for every 1, 5 or 15 minutes, plus custom seconds;
- auth/setup status (never credential values);
- a collapsed, plain-language summary of provider capabilities and quota impact;
- “inspect now”.

Each provider is shown in one connection-first settings card. Sign-in for
Codex and Antigravity lives in that card; disconnected accounts get a primary
connect action, while monitoring controls stay hidden until connection succeeds.
Connected accounts show their settings and keep reconnect options secondary.
Sign-in links and device codes can be copied from the inline flow. Auth-session
state is held in memory only; event history contains lifecycle and bounded reason
codes, never process output or submitted codes. The `Connected` indicator is a
live-status dot and honors reduced-motion preferences.

## Usage

The server-rendered `/usage` page and `GET /api/v1/usage` read only persisted
SQLite state; neither route inspects a provider or starts a Codex turn. Usage
charts appear first, followed by the daily-use heatmap; Logs stays focused on
events. Each chart keeps its own selected time range, smooths nearby readings,
and fills the area under its line while leaving missing samples and outages
visible. A calendar day is derived from positive changes in one trustworthy
seven-day window, not from the current remaining balance. Each weekly reset
starts a new counter baseline without subtracting or fabricating the previous
cycle's use. The first observation is a baseline, and gaps, corrections, and
unproven resets are visibly marked partial/unknown.

Short observed intervals are apportioned across local midnight in the saved
IANA timezone. Longer intervals are not given false daily precision. The
heatmap uses percentage points of one weekly allowance, with explicit `No data`,
zero-observed, intensity bands, partial markers and an in-progress label for
today. This is an estimate from saved provider snapshots, not a message/token
counter. Only weekly windows qualify; a five-hour window is never silently used
as a substitute. FakeProvider follows the same visibility setting as the other
UI/API surfaces.

The heatmap shows up to 365 local dates; changing the saved timezone reprojects
the same persisted UTC contribution intervals instead of changing or losing the
underlying total. Derived intervals are retained for 400 days, beyond the
90-day raw sample retention. Older days without retained evidence remain `No
data`. Aggregation runs incrementally in bounded batches; page reads do not
rebuild historical data.

Usage charts have independent `1h`, `3h`, `6h`, `12h`, `24h`, `7d` and `30d`
periods. Queries cover the selected time domain and downsample while preserving
endpoints, extrema and outage breaks. Chart labels use the saved timezone.
Keyboard grid navigation and a plain day-list alternative complement the
calendar; the controls remain server-rendered and work without JavaScript.

## Logs

The server-rendered `/logs` page reads persisted SQLite events and never
inspects a provider. `/history` remains a permanent `301` alias that preserves
the query string. Events may carry multiple in-memory category tags (Triggers,
Resets, Sync, Config, Alerts and Manual); tags are derived from safe event
metadata and are not persisted or exposed through the JSON history contract.
Routine provider checks and scheduler no-ops are hidden by default; Sync shows
provider checks, and `?type=scheduler_noop` explicitly reveals routine scheduler
checks. Category and provider/range filters are combined and paginated in
bounded pages of 20. Existing chart-period selections link to Usage while
preserving valid selections. Keep it small:

- recent lifecycle/action timeline;
- plain-language event names, reasons and provider labels;
- bounded filters and previous/next navigation.

No enterprise dashboard, no Grafana clone.

## Frontend technology

Server-rendered HTML with a shared dark operations shell, one same-origin
stylesheet at `/assets/app.css` and a small progressive-enhancement script at
`/assets/app.js`. Chart markup is produced by the shared `ui/charts.ts` layer:
it owns dimensions, axes, grid treatment, labels, colors, null gaps, legends and
accessible point metadata. The script only reveals the tooltip for the point
being inspected; the server remains the owner of data and page state. No React,
client router or large component framework is used.
