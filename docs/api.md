# MVP HTTP API

The API exists to support the small UI and local automation/inspection. It is not a public platform API.

The web service has mandatory native single-operator authentication. `GET
/healthz`, static assets, and `/login` are public; every dashboard route, JSON
endpoint and both logout routes require the in-memory operator session.
Exact `GET`/`HEAD /metrics` also accepts the optional dedicated technical
Bearer credential described in [metrics](metrics.md); no query token is accepted.
Unauthenticated HTML navigation redirects to `/login`; JSON and
metrics return `401` with `AUTH_REQUIRED`. `POST /login` and `POST /logout` are
same-origin and CSRF protected. The login cookie is browser-only; there is no
API password, general-purpose bearer token, public-registration or trusted-header bypass.

Proposed final MVP endpoints:

```text
GET  /healthz
GET  /api/v1/diagnostics
GET  /metrics
GET  /login
POST /login
GET  /logout
POST /logout
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
GET  /api/v1/provider-clients
GET  /api/v1/providers/:id/auth/status
POST /api/v1/providers/:id/auth/start
POST /api/v1/providers/:id/auth/submit
POST /api/v1/providers/:id/auth/cancel
POST /api/v1/providers/:id/trigger
POST /api/v1/providers/:id/inspect
POST /api/v1/actions/:id/resolve-unknown
POST /api/v1/settings/timezone
POST /api/v1/scheduling
POST /api/v1/provider-clients/:id/check
POST /api/v1/provider-clients/:id/update
POST /api/v1/provider-clients/:id/rollback
```

The current implementation also serves `POST /settings/providers/:id` and
`POST /schedule` for the server-rendered settings UI. Both are same-origin and
CSRF protected. The read endpoints return persisted state only; they do not
inspect providers or execute intents. `/api/v1/providers` includes normalized
windows, freshness, capabilities, current-window state and the latest
persisted scheduler decision. `/api/v1/scheduling` exposes the persisted
timezone, activation policy, current window, upcoming occurrences and planner
decision without provider I/O. For Antigravity, each provider DTO additionally
contains `policyScopes[]` for `gemini` and `claude_gpt`; each entry has its own
policy, current window, decision, upcoming occurrences and `requiresReview`
flag. The older top-level fields remain a Gemini-family-compatible view for
existing clients. Trigger requests create a durable intent and return `202`,
while inspect requests append a per-provider reconcile hint, asynchronously wake
the service and return `202`. This is queue acceptance, not a fresh result. The
hint requests a fresh read even before the next poll is due; disabled providers
are rejected, and active authentication/runtime changes defer the read until
safe periodic recovery. Shared read backoff also defers the hint without consuming
it or clearing the failure streak. Private diagnostics expose `readRetryAtMs`
(zero when no shared read deadline exists) and `inspectHintPending` separately
from provider health. Repeated requests coalesce and do not authorize prompts.

`POST /api/v1/actions/:id/resolve-unknown` persists a review request for an
uncertain action, returning `202` without provider I/O in the handler. The
native equivalent is `POST /actions/:id/resolve-unknown`, which uses PRG back to
Overview. Both require operator session, Origin and CSRF. The executor performs
a fresh read and requires durable evidence that the corresponding exact old
cycle ended before recording `resolved_unknown`. Neither expiry nor browser
payload supplies that evidence. Duplicate pending requests coalesce; another
explicit review after failure has a 30-second cooldown. Already confirmed or
closed outcomes are returned without another transition. Executing actions
cannot be closed. Overview shows the blocker, age, confirmation attempts and
review result. Cleanup obligations still block executable updates independently.

Provider-client status is a bounded allowlisted view with packaged, active,
previous and last-checked versions plus update state; it contains no executable
path or release payload. The three provider-client command endpoints accept
only a fixed provider ID and operation, require operator auth plus Origin/CSRF,
and return `202 Accepted` while the asynchronous check/update/rollback runs (or
`409` when another operation is already running). Poll the status with
`GET /api/v1/provider-clients`. No endpoint accepts a download URL, version,
repository, asset, shell command or digest from the client.

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
- JSON mutations are limited to validated non-secret timezone and
  activation-policy values, plus the fixed provider-client operations above.
  Other settings use the protected HTML form routes below.
- JSON is versioned under `/api/v1` even though the HTML routes are not.
- pagination is simple bounded `limit` + cursor/id if history grows; no GraphQL.

Current HTML mutation routes are:

```text
POST /login
POST /logout
POST /settings/providers/:id
POST /settings/provider-clients/:id/check|update|rollback|auto-update
POST /schedule
POST /providers/:id/trigger
```

The browser may progressively enhance explicitly marked HTML forms and links
by fetching these same routes and extracting a uniquely identified
server-rendered region. This adds no fragment or JSON API and does not bypass
session, Origin, CSRF, validation or PRG behavior. Native navigation remains
the fallback when JavaScript is unavailable; enhanced mutations are not
automatically retried if their outcome cannot be confirmed.

The JSON settings routes accept only validated non-secret timezone and
activation-policy fields. They use the same SQLite services as the HTML forms.
An Antigravity activation-policy write includes `scope=gemini` or
`scope=claude_gpt`; the server derives its canonical row ID and rejects a
window target from the other family. Switching the family on `/schedule` is a
read-only GET and does not save either policy.

The former HTML route `/history` redirects permanently to `/logs`, preserving
its query string. The JSON endpoint `/api/v1/history` remains unchanged.

They require a same-origin request and a CSRF token, return `303` on success,
and write only validated non-secret SQLite configuration. Invalid input returns
an error status without calling a provider. The manual trigger form accepts an
exact observed `windowKind`, creates/queues a durable intent, and redirects with
a bounded result notice; it never starts the provider process in the handler.
It is shown only when provider mode and exact target capability allow it.

History and settings responses are bounded/allowlisted. No endpoint returns
provider credentials, raw provider payloads, tokens, or secret configuration.

Provider auth status returns a bounded DTO containing lifecycle state, expiry,
an allowlisted official sign-in URL, a one-time display code when provided by
the official client, and a bounded reason code. The start/submit/cancel routes
are same-origin and CSRF protected. Submitted codes are forwarded only to the
already-running official provider process and removed from the in-memory
session immediately; they are not persisted or logged. The status read path
does not start a provider process or inspect quota.
