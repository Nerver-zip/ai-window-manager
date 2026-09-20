# MVP HTTP API

The API exists to support the small UI and local automation/inspection. It is not a public platform API.

Proposed final MVP endpoints:

```text
GET  /healthz
GET  /metrics
GET  /
GET  /schedule
GET  /history
GET  /settings

GET  /api/v1/providers
GET  /api/v1/providers/:id
GET  /api/v1/history?provider=&type=&from=&to=&limit=
GET  /api/v1/settings
PUT  /api/v1/settings
POST /api/v1/providers/:id/trigger
POST /api/v1/providers/:id/inspect
```

The current implementation also serves `POST /settings/providers/:id` and
`POST /schedule` for the server-rendered settings UI. Both are same-origin and
CSRF protected. The read endpoints return persisted state only; they do not
inspect providers or execute intents. Trigger requests create a durable intent
and return `202`, while inspect requests append a reconcile hint and return
`202`.

Notes:

- `POST trigger` creates/advances a durable action intent; it does not directly hide a provider side effect inside the HTTP handler.
- `inspect` queues/requests an immediate reconcile hint; the response may be `202 Accepted` rather than block on a provider CLI.
- runtime settings endpoint never accepts or returns secret values.
- `PUT /api/v1/settings` remains a planned JSON mutation surface; the current settings UI uses the protected HTML form routes documented below.
- JSON is versioned under `/api/v1` even though the HTML routes are not.
- pagination is simple bounded `limit` + cursor/id if history grows; no GraphQL.

History and settings responses are bounded/allowlisted. No endpoint returns
provider credentials, raw provider payloads, tokens, or secret configuration.
