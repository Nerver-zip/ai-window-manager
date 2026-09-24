# MVP HTTP API

The API exists to support the small UI and local automation/inspection. It is not a public platform API.

Proposed final MVP endpoints:

```text
GET  /healthz
GET  /metrics
GET  /
GET  /schedule
GET  /logs
GET  /usage
GET  /settings

GET  /api/v1/providers
GET  /api/v1/providers/:id
GET  /api/v1/history?provider=&type=&from=&to=&limit=
GET  /api/v1/usage?provider=&window=&day=&chartRange=
GET  /api/v1/settings
GET  /api/v1/scheduling
GET  /api/v1/providers/:id/auth/status
POST /api/v1/providers/:id/auth/start
POST /api/v1/providers/:id/auth/submit
POST /api/v1/providers/:id/auth/cancel
POST /api/v1/providers/:id/trigger
POST /api/v1/providers/:id/inspect
POST /api/v1/settings/timezone
POST /api/v1/scheduling
```

The current implementation also serves `POST /settings/providers/:id` and
`POST /schedule` for the server-rendered settings UI. Both are same-origin and
CSRF protected. The read endpoints return persisted state only; they do not
inspect providers or execute intents. `/api/v1/providers` includes normalized
windows, freshness, capabilities, current-window state and the latest
persisted scheduler decision. `/api/v1/scheduling` exposes the persisted
timezone, activation policy, current window, upcoming occurrences and planner
decision without provider I/O. Trigger requests create a durable intent and
return `202`, while inspect requests append a reconcile hint and return `202`.

`/usage` and `/api/v1/usage` read the persisted weekly-usage projection. The
JSON response is bounded to 365 local calendar days and selected chart windows;
it includes the saved timezone, aggregation-pending state, selected
provider/window, daily values with quality/coverage, and downsampled chart
series. It never inspects a provider. A hidden FakeProvider follows the same
visibility filtering as the other provider read routes.

Notes:

- `POST trigger` creates/advances a durable action intent; it does not directly hide a provider side effect inside the HTTP handler.
- `inspect` queues/requests an immediate reconcile hint; the response may be `202 Accepted` rather than block on a provider CLI.
- runtime settings endpoint never accepts or returns secret values.
- There is no JSON settings mutation endpoint in the current MVP contract. The settings UI uses the protected HTML form routes documented below; a future JSON mutation surface must be added as a separate reviewed contract.
- JSON is versioned under `/api/v1` even though the HTML routes are not.
- pagination is simple bounded `limit` + cursor/id if history grows; no GraphQL.

Current HTML mutation routes are:

```text
POST /settings/providers/:id
POST /schedule
```

The JSON settings routes accept only validated non-secret timezone and
activation-policy fields. They use the same SQLite services as the HTML forms.

The former HTML route `/history` redirects permanently to `/logs`, preserving
its query string. The JSON endpoint `/api/v1/history` remains unchanged.

They require a same-origin request and a CSRF token, return `303` on success,
and write only validated non-secret SQLite configuration. Invalid input returns
an error status without calling a provider.

History and settings responses are bounded/allowlisted. No endpoint returns
provider credentials, raw provider payloads, tokens, or secret configuration.

Provider auth status returns a bounded DTO containing lifecycle state, expiry,
an allowlisted official sign-in URL, a one-time display code when provided by
the official client, and a bounded reason code. The start/submit/cancel routes
are same-origin and CSRF protected. Submitted codes are forwarded only to the
already-running official provider process and removed from the in-memory
session immediately; they are not persisted or logged. The status read path
does not start a provider process or inspect quota.
