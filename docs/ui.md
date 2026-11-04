# Web UI

The deterministic FakeProvider is shown only when
`AWM_FAKE_PROVIDER_ENABLED=true`. With the setting false, previously persisted
fake state is omitted from the overview, provider settings, schedule, history,
JSON read/command routes, Usage, and metrics; SQLite history is preserved.

The application has a standalone sign-in page for one local operator. The login
screen uses the same design tokens but no application navigation or provider
data; authenticated pages expose a deliberate Sign out action. The username and
password hash come from bootstrap environment configuration, not the UI. There
is no signup, user-management or password-reset screen. An unauthenticated
HTML request returns to login with a safe same-origin destination; JSON and
metrics clients receive `401` instead of an HTML redirect.

The overview should answer at a glance:

1. which usage windows are available?
2. how much has been used and how much remains?
3. when does each window reset in my local time and in UTC?
4. which start policy is selected, and is it enabled?
5. is the provider information current?

## Overview

When more than one provider is available, a compact segmented selector (logo,
name and a status dot) chooses which provider to inspect. Only the selected
provider's overview is shown, so usage windows and policy details stay focused
instead of competing side by side. The dot is filled green when connected,
hollow amber when sign-in, a check failure or stale data needs attention, and
hollow grey when paused or not set up; the status text stays available to
assistive technology (and visible on wide screens). With one provider, the
selector is omitted.

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

The selected provider is laid out top-down by importance:

1. a heading with one quiet status line — connection, `Last checked …`, and the
   automation state as plain text;
2. an always-visible attention area for stale data, sign-in, unresolved start
   outcomes (with their review action) and policies that need review;
3. usage windows as aligned, hairline-separated rows — name and phase, a large
   used percentage with the remaining share, a meter, the local reset time with
   relative timing, and the time zone/UTC line as secondary text. Antigravity
   rows are grouped under Gemini Models, Claude and GPT Models and Gemini 4
   Argon (weekly only);
4. the saved start policies as a compact list with Change/Choose/Review links;
5. connection details in a disclosure.

Paused, monitoring-only, unsupported, missing, or invalid policies are called
out rather than being presented as active. Technical window keys never appear as
normal labels.

When a configured provider is disconnected, the Overview offers a direct
`Connect Codex` or `Connect Antigravity` action that opens the matching
provider's onboarding section in Settings. Settings displays the official
client's one-time sign-in code from the same rendered value used by its copy
button; clipboard failure selects the actual displayed code or link for manual
copy. Codes live only in the bounded in-memory sign-in session and disappear
when that session ends.

When the provider is in automation mode and an exact window is triggerable,
that window has its own `Start this window now` action. It queues a durable
intent; it does not dispatch from the HTTP handler. The button itself is the
operator's explicit manual-start action; the overview does not add a separate
quota warning or confirmation dialog.

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

Codex has one saved activation policy. Antigravity has independent saved
policies for Gemini Models, Claude and GPT Models, and Gemini 4 Argon; a family
switch loads the selected policy without saving, and saving it leaves the other
families intact. Each policy targets one exact observed window from its family.
Argon has a weekly target only. If the provider does not report it, Schedule
shows that target as unavailable; it does not substitute a Gemini window or
invent a five-hour Argon window. The provider reports this as a weekly-only
allowance; its trigger effect has not been live-validated, so Argon triggering
is disabled by default. Ambiguous legacy Antigravity schedules require review
before they can resume. Older manual policies without a target are flagged for
review when an exact target for that family becomes available. If an
Antigravity trigger is enabled and the exact target is supported, its model is
shown as secondary detail.

The current server-rendered `/schedule` page is one policy form beside a
"What happens next" column (sticky on wide screens, stacked below on narrow
ones) with the current window, the authoritative next decision, the next-24-hours
preview and safety notes. The five strategies are a compact radio list; the
form reveals only the fields relevant to the selected preference. The next-start preview uses saved provider information
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

Settings is a single page of headed sections (Time zone, Providers, Data
retention) with a sticky in-page section list on wide screens. Each provider is
shown in one connection-first panel. Sign-in for
Codex and Antigravity lives in that card; disconnected accounts get a primary
connect action, while monitoring controls stay hidden until connection succeeds.
Connected accounts show their settings and keep reconnect options secondary.
Sign-in links and device codes can be copied from the inline flow. Auth-session
state is held in memory only; event history contains lifecycle and bounded reason
codes, never process output or submitted codes. The `Connected` indicator is a
live-status dot and honors reduced-motion preferences. A read-only Data retention
section summarizes automatic history expiry and the protection for unresolved
starts. Each real-provider card also displays packaged/active/latest stable
client versions and offers protected check, install, rollback and optional
off-by-default automatic update controls. Update status is also available from
the authenticated provider-client API.

## Usage

The server-rendered `/usage` page and `GET /api/v1/usage` read only persisted
SQLite state; neither route inspects a provider or starts a Codex turn. Usage
charts appear first, followed by the daily-use heatmap; Logs stays focused on
events. Each chart keeps its own selected time range, smooths nearby readings,
and fills the area under its line. Visual continuity allows three effective
polling intervals plus one reconcile tick between valid readings; a longer
outage splits both line and fill. Short missing readings can be bridged only
when the valid endpoints fit that limit. A drop in observed usage stays sharp,
without averaging across the drop. This display rule does not fill missing
history or change the daily heatmap's unknown/partial accounting. The current
saved polling interval is used when displaying older samples, so changing it
can change how historical gaps appear.

A calendar day is derived from positive changes in one trustworthy seven-day
window, not from the current remaining balance. Each weekly reset
starts a new counter baseline without subtracting or fabricating the previous
cycle's use. The first observation is a baseline, and gaps, corrections, and
unproven resets are visibly marked partial/unknown.

Short observed intervals are apportioned across local midnight in the saved
IANA timezone. Longer intervals are not given false daily precision. The
heatmap uses percentage points of one weekly allowance, with explicit `No data`,
zero-observed, intensity bands and an in-progress label for today. Partial
days keep their intensity and say so in the cell name and the selected-day
summary rather than through a separate legend marker. This is an estimate from saved provider snapshots, not a message/token
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
endpoints, extrema and outage breaks within a 384-point per-series limit.
Chart labels use the saved timezone.
Antigravity renders a weekly-family selector within the daily usage section and
one chart for each observed or historically saved window. Gemini Models and
Claude and GPT Models retain their four existing charts; Gemini 4 Argon adds a
fifth, weekly chart only when an Argon window or its saved history exists. An
account without Argon keeps the existing four charts and has no phantom Argon
heatmap option. Codex's sole weekly window is selected automatically. The
heatmap uses only reported weekly windows, has no alternate day list or
always-visible zero-usage caveat, and retains keyboard grid navigation and
per-day accessible names.

## Logs

The server-rendered `/logs` page reads persisted SQLite events and never
inspects a provider. `/history` remains a permanent `301` alias that preserves
the query string. Events may carry multiple in-memory category tags (Triggers,
Resets, Sync, Config, Alerts and Manual); tags are derived from safe event
metadata and are not persisted or exposed through the JSON history contract.
Routine provider checks and scheduler no-ops are hidden by default; Sync shows
provider checks, and `?type=scheduler_noop` explicitly reveals routine scheduler
checks. Category and provider/range filters are combined and paginated in
bounded pages of 20. Filters sit in a light toolbar (provider selector, range,
a segmented category row and the routine-checks link). Events are grouped under
local-day headings in the saved time zone along a thin rail; each entry shows a
24-hour time, a severity dot with a text equivalent, the plain-language title,
provider and categories as secondary text, and the `Why` reason beneath. Existing chart-period selections link to Usage while
preserving valid selections. Keep it small:

- recent lifecycle/action timeline;
- plain-language event names, reasons and provider labels;
- bounded filters and previous/next navigation.

No enterprise dashboard, no Grafana clone.

## Frontend technology

Server-rendered HTML with a shared dark operations shell, one same-origin
stylesheet at `/assets/app.css` (composed from `src/web/ui/styles/*` modules:
base tokens/controls, shell, provider selector and one module per page) and a small progressive-enhancement script at
`/assets/app.js`. Interactive controls may opt in to fetching their existing
HTML route and replacing one uniquely keyed `data-awm-region` from its
server-rendered response. This keeps the shell, scroll and unrelated form state
in place while Fastify remains the sole owner of validation, notices and
application state. Enhanced GETs update browser history and discard stale
responses; enhanced POSTs follow the existing PRG redirect and are never
automatically retried after an uncertain response. Login/logout, provider
authorization and primary page navigation remain ordinary navigations.

The enhancement lifecycle is re-run after a region replacement so existing
chart, schedule-preview and provider-auth interactions remain available. A
shared live region announces concise outcomes; target regions expose pending
state and restore a stable focus target where possible. Enhancements are
explicitly marked on server-rendered forms and links; unmarked controls are not
intercepted. Without JavaScript, the same native forms, links, validation and
redirects remain usable.

Chart markup is produced by the shared `ui/charts.ts` layer: it owns dimensions,
axes, grid treatment, labels, colors, null gaps, legends and accessible point
metadata. The script only reveals the tooltip for the point being inspected;
the server remains the owner of data and page state. No React, client router or
large component framework is used.

## Visual language and layout

- One restrained dark palette with a single cyan accent; amber and red are
  reserved for attention and danger. Status is a small dot plus text, not pill
  badges.
- Content sits on the canvas, grouped by headings, whitespace and hairline
  dividers. A panel is used at most one level deep (chart cards, provider
  settings); cards are not nested.
- Shared primitives live in the base module: buttons (primary, secondary,
  ghost, danger), fields, segmented controls, notices, status, meters,
  disclosures and empty states.
- Shell: a slim sticky sidebar (navigation, developer links, Sign out) on wide
  screens; at 760px and below it becomes a sticky top bar with a five-item tab
  row. There is no hamburger menu or client router.
- Responsive targets are 1440, 1280, 390 and 360px wide without page-level
  horizontal scrolling. Only intentional inner regions (the heatmap track)
  scroll horizontally. Coarse pointers get 44px targets.
- Accessibility: skip link, `aria-current` navigation, visible `:focus-visible`
  outlines, native labels/fieldsets, live regions for notices and enhancement
  outcomes, accessible chart and heatmap metadata, and no hover-only critical
  information. `prefers-reduced-motion` disables transitions and the live-status
  pulse.

## Page functional contract

Visual changes must keep each page's information, actions, states and
enhancement hooks. This table is the parity checklist for UI work.

| Page                 | Information                                                                                                                                                                                          | Actions, routes and forms                                                                                                                                                                                                  | Conditional states                                                                                                                        | Enhancement and accessibility hooks                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview `/`         | Provider and connection, monitoring/automation state, freshness, used/left %, local and UTC reset with relative time, every window family (Argon weekly only), saved policies per Antigravity family | `GET /?provider=` switcher with noscript button; `POST /providers/:id/trigger` (capability- and automation-gated); `POST /actions/:id/resolve-unknown`; Connect/Continue sign-in link; schedule Change/Choose/Review links | No providers, one provider, disconnected, first observation pending, stale, unknown usage or reset, uncertain intent, policy needs review | Regions `overview-workspace` and `overview-provider:<id>`; mutation, pending and uncertain-message attributes; `progress` labels; `role=status`              |
| Usage `/usage`       | Per-window charts with tooltips and point metadata, gap/reset semantics, daily heatmap (partial, no data, today), weekly-family choice, selected day, saved time zone                                | Provider links; per-chart `GET /usage` period form (noscript Apply, other charts' hidden ranges); family select (noscript); day links                                                                                      | No weekly windows, family not selected, no data, out of range, empty range, aggregation pending, Argon only when observed                 | Regions `usage-heatmap` and `usage-chart:<p>:<w>`; heatmap `role=grid` keyboard; chart `role=img` and focusable points                                       |
| Schedule `/schedule` | Current observed window, exact target, trigger model, cross-window warning, next decision, next-24-hours preview, time zone, safety notes                                                            | Provider `GET` form (noscript); Antigravity family links; `POST /schedule` (five strategies, times, cycle anchor, active-hour periods, presets, steppers); `GET /schedule/preview`                                         | No providers, no targets, Argon unavailable, ambiguous or unresolved target (`role=alert`), review required, no time zone                 | Region `schedule-workspace`; `data-policy-*` and `data-schedule-*` hooks; preview root two levels above the form; `fieldset`/`legend`                        |
| Logs `/logs`         | Severity, categories, provider, local time, plain-language title, reason, count                                                                                                                      | Combined provider, range and category filters; routine-checks toggle; Previous/Next (20 per page); `/history` 301                                                                                                          | Empty, provider unavailable, routine checks hidden or shown                                                                               | Region `logs-results`; focus keys; `aria-current` filters; `Log pages` navigation                                                                            |
| Settings `/settings` | Time zone, connection status, capabilities, active/image/latest client versions, update status, retention                                                                                            | `POST /settings/timezone`; `POST /settings/providers/:id`; sign-in start/submit/cancel APIs with link and code copy; client check/install/rollback/auto-update                                                             | Connected, signing in, sign-in required, controls locked until connected, update running, controls unavailable                            | Regions `settings-timezone`, `settings-provider:<id>` and `provider-client:<id>`; `data-auth-*` hooks inside `.provider-settings`; update polling attributes |
| Sign-in `/login`     | Invalid-credential, throttled and expired-session errors                                                                                                                                             | `POST /login` (CSRF, safe `next`); `GET`/`POST /logout`                                                                                                                                                                    | Throttled (`429`), expired session                                                                                                        | `role=alert`; autocomplete; no application navigation or provider data                                                                                       |

## Browser checks

`scripts/ui-checks/` holds optional developer tooling for verifying the UI in a real browser. It is not part of `pnpm validate` or CI.

- `pnpm ui:demo` starts the real web server on `127.0.0.1` (`PORT`, default 4870) with synthetic seed data, stub provider adapters that reject `inspect()`, fake sign-in drivers, a static client-update stub and a fixed clock. Sign in as `demo` / `demo-password`. It never contacts providers or the network. Set `AWM_DEMO_TMP` to choose the temporary directory root and `AWM_DEMO_NO_AUTOSTART=1` to skip the auto-started sign-in session.
- `pnpm ui:a11y <baseUrl>` runs keyboard, focus-ring, progressive-enhancement and JavaScript-disabled checks.
- `pnpm ui:auth-flow <baseUrl> <outDir> [label]` walks the synthetic Claude Code sign-in onboarding (start the demo with `AWM_DEMO_NO_AUTOSTART=1`).
- `pnpm ui:shots <baseUrl> <outDir> [label]` captures screenshots and reports horizontal overflow (`SHOOT_ONLY`, `SHOOT_SIZES`, `SHOOT_VIEWPORT` narrow the run).

The browser scripts need a local Chromium or Chrome; set `CHROME_BIN` to its path if it is not found automatically.
