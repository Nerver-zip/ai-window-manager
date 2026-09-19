# SPIKE-001 — Codex app-server inspection/auth flow

**Date:** 2026-09-19
**Scope:** research only; no AI Window Manager provider implementation, trigger, OAuth client, or direct backend usage endpoint
**Conclusion:** `SUPPORTED_FOR_READ_ONLY_ADAPTER`

## Executive conclusion

The official Codex app-server exposes a documented, read-only rate-limit inspection method that is suitable as the transport boundary for a future Codex adapter:

```text
codex app-server (stdio JSONL)
  initialize -> initialized
  account/rateLimits/read
  account/rateLimits/updated notifications
```

The recommended deployment shape is a dedicated official Codex process, launched by AI Window Manager as a child process over stdio, with a dedicated `CODEX_HOME` mounted to persistent storage. Authentication must remain owned by Codex. For a headless Linux host, the documented ChatGPT device-code flow is the appropriate operator-assisted bootstrap; the daemon must not receive or persist copied browser tokens itself.

This conclusion is limited to read-only inspection. It does not approve a trigger, quota-reset operation, direct HTTP usage access, token injection, or automatic login. A real authenticated acceptance test is still required before shipping a live adapter, using an explicitly authorized test account and a controlled environment.

## Evidence collected

### Installed official client

The installed binary reports:

```text
codex-cli 0.155.1
```

The local CLI exposes:

- `codex app-server`, with stdio as the default transport;
- `codex app-server daemon` lifecycle commands (`start`, `stop`, `restart`, `version`);
- `codex app-server generate-json-schema`;
- `codex login status`, `codex login`, and `codex logout`.

The generated schema was produced locally with:

```bash
codex app-server generate-json-schema --out <temporary-directory>
```

The generated bundle contains `account/rateLimits/read`, `account/read`, `account/login/start`, `account/login/completed`, and `account/rateLimits/updated` definitions. The generated artifacts were not added to the repository because they are version-specific output, not sanitized provider fixtures.

### Process lifecycle

The official app-server documentation specifies:

1. start `codex app-server` (stdio/JSONL is the default);
2. send exactly one `initialize` request per connection;
3. send the `initialized` notification;
4. issue account reads and continue consuming notifications;
5. terminate the child process through normal process shutdown.

The local unauthenticated process probe returned a successful initialization response containing `codexHome`, `platformFamily`, `platformOs`, and `userAgent`. It did not start a thread or turn. The probe used an isolated temporary `CODEX_HOME` and no credentials.

The protocol documentation says that requests before initialization are rejected and repeated initialization on the same connection is rejected. A future adapter should therefore maintain one connection state machine and recreate the child process after EOF, protocol failure, or timeout rather than attempting to reuse a poisoned stream.

### Authentication flow

The official app-server protocol documents these relevant modes:

- `chatgpt`: Codex-managed browser OAuth flow;
- `chatgptDeviceCode`: Codex-managed device-code flow, suitable when a browser callback is inconvenient on a headless machine;
- `apiKey`: API-key authentication, which is not the ChatGPT subscription/rate-limit path;
- externally supplied `chatgptAuthTokens`: explicitly experimental/unstable and not suitable for this project.

For the target Linux/container model, the supported operational flow is:

1. mount a dedicated persistent `CODEX_HOME` for the Codex child process;
2. an operator starts the official device-code login through the official CLI/app-server flow;
3. the operator completes authentication outside the container using the displayed verification URL and one-time code;
4. the official Codex client stores and refreshes its own credentials in its configured credential store;
5. later restarts reuse the same dedicated Codex state directory.

AI Window Manager must not mount the operator's workstation home, copy `auth.json`, accept browser cookies, parse JWTs, or use `chatgptAuthTokens`. The exact credential-store mode and permissions need to be fixed in CODEX-001; this spike only establishes the official flow and storage boundary.

### Read-only rate-limit inspection

The official documentation lists `account/rateLimits/read` as the ChatGPT rate-limit read method and `account/rateLimits/updated` as its change notification. The official app-server test suite also verifies that the method requires account authentication and specifically requires ChatGPT authentication rather than an API key.

No turn, `thread/start`, `turn/start`, reset-credit consumption, or other quota-consuming operation was run during this spike.

The adapter must call the app-server method only after initialization and authenticated account state is available. It must treat an authentication error, timeout, protocol mismatch, or missing snapshot as an unavailable/degraded observation and retain last-known-good state according to the generic provider contract.

The following is a sanitized shape from the official documentation/schema; values are illustrative and not captured account data:

```json
{
  "rateLimits": {
    "limitId": "codex",
    "limitName": null,
    "primary": {
      "usedPercent": 25,
      "windowDurationMins": 300,
      "resetsAt": 1730947200
    },
    "secondary": null,
    "rateLimitReachedType": null
  },
  "rateLimitsByLimitId": {
    "codex": {
      "limitId": "codex",
      "primary": {
        "usedPercent": 25,
        "windowDurationMins": 300,
        "resetsAt": 1730947200
      },
      "secondary": null
    }
  },
  "accountId": null,
  "ordinaryUsageAllowed": null,
  "rateLimitResetCredits": null
}
```

## Current response contract

The locally generated v2 schema for `GetAccountRateLimitsResponse` requires only `rateLimits`. Other top-level fields are optional or nullable:

| Field                   | Shape / semantics                                             | Adapter treatment                                                                         |
| ----------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `rateLimits`            | Required single-bucket `RateLimitSnapshot` compatibility view | Validate as the primary snapshot, but do not assume every nested field exists             |
| `rateLimitsByLimitId`   | Nullable map of bucket ID to snapshot                         | Prefer for multiple windows/buckets when present; preserve opaque IDs                     |
| `accountId`             | `string \| null`                                              | Never expose to UI or metrics; do not require it for observation                          |
| `ordinaryUsageAllowed`  | `boolean \| null`                                             | Preserve as a provider fact only; `null` is unavailable, not permission to infer recovery |
| `rateLimitResetCredits` | Object `\| null`                                              | Read-only metadata; do not consume/reset credits in this adapter                          |
| `rateLimitUpsell`       | Optional backend-owned object with an unstable nested shape   | Ignore or retain only through a deliberately versioned boundary; never expose raw payload |

Each `RateLimitSnapshot` may contain:

- `limitId: string | null`;
- `limitName: string | null`;
- `normalModelSlug: string | null`;
- `planType: enum | null`;
- `primary: RateLimitWindow | null`;
- `secondary: RateLimitWindow | null`;
- `credits: CreditsSnapshot | null`;
- `individualLimit: SpendControlLimitSnapshot | null`;
- `rateLimitReachedType: enum | null`;
- `spendControlReached: boolean | null`.

Each `RateLimitWindow` requires only `usedPercent: integer`; `resetsAt` and `windowDurationMins` are nullable. Therefore:

- a percentage without a reset timestamp is valid partial evidence;
- a reset timestamp without a duration must not be turned into an invented window start;
- `primary` or `secondary` may be `null`;
- the adapter must preserve multiple buckets instead of collapsing them into one five-hour/weekly pair;
- integer ranges and semantic validity must be checked at the adapter boundary;
- absent/null fields must degrade safely rather than be guessed.

The `account/rateLimits/updated` notification is explicitly sparse. Its `rateLimits` payload should be merged into the latest read snapshot or followed by a fresh read; nullable account metadata in the notification does not clear a previously observed value.

## State across restarts

### Must persist outside the AWM container filesystem

- the dedicated Codex `CODEX_HOME` directory and its official credential-store state, with restrictive permissions;
- the selected Codex executable/version or an equivalent deployment pin;
- AWM's own normalized last-known-good state and observation history in SQLite, as already required by the project architecture.

### Must not be treated as durable provider truth

- an in-memory app-server connection;
- a pending JSON-RPC request ID;
- a cached rate-limit notification without a corresponding validated snapshot;
- a stale `rateLimits` object after an authentication or contract failure.

After restart, CODEX-001 should start a fresh app-server child process, perform a new handshake, read `account/read`, then request a fresh `account/rateLimits/read`. AWM may display persisted last-known-good state while the new inspection is pending, marked stale; it must not use that stale state to authorize an action.

The app-server's own conversation/session persistence is not required for read-only quota inspection. Do not persist or resume threads for this adapter.

## Recommended CODEX-001 boundary

Implement only:

1. a bounded child-process lifecycle around the official `codex app-server` stdio transport;
2. the initialize/initialized handshake;
3. account/auth-state read sufficient to distinguish signed out, API-key-only, ChatGPT-authenticated, and unavailable states;
4. `account/rateLimits/read` request/response validation;
5. `account/rateLimits/updated` merge/refetch handling;
6. normalization into the canonical `ProviderObservationSchema` with explicit evidence and confidence;
7. sanitized fixture tests for complete, partial, null, malformed, auth-error, timeout, and notification-merge cases;
8. a dedicated `CODEX_HOME` path supplied by configuration, never the host user's home.

Do not implement in CODEX-001:

- direct calls to `/api/codex/usage`, `/wham/usage`, or any other backend URL;
- `chatgptAuthTokens` handling;
- account rotation or token extraction;
- `account/rateLimitResetCredit/consume`;
- `thread/start`/`turn/start` as a way to position a window;
- any scheduler policy or trigger behavior.

The capability declaration for the resulting adapter should be read-only. A future trigger would require a separate compliance and lifecycle decision; this spike provides no evidence for enabling it.

## Uncertainties and required follow-up

- The authenticated device-code flow was not executed, intentionally: no credentials were available or requested, and no quota was to be spent.
- The exact Linux credential-store implementation and filesystem permissions must be verified in CODEX-001 with a dedicated disposable Codex home and an explicitly authorized test account.
- The app-server protocol/schema is version-specific. Pin the Codex CLI/app-server version and fail closed on unsupported schema changes.
- Backend rate-limit semantics can be partial or inconsistent. The adapter must preserve nullability and provenance and must not infer a window start from incomplete data.
- The official docs describe the app-server/WebSocket transport as experimental/not supported for production workloads. This spike uses stdio, which is the documented default local transport, but deployment approval should retain an operational rollback/monitor-only mode.
- No live account payload or provider fixture was captured. The inline example above is sanitized and illustrative only.

## Official references

- [Codex App Server documentation](https://developers.openai.com/docs/app-server) — stdio/JSONL transport, lifecycle, authentication methods, account methods, and rate-limit example.
- [Codex authentication documentation](https://developers.openai.com/docs/auth) — CLI login methods and credential persistence boundary.
- [Official Codex app-server account protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs) — current protocol enums, nullable fields, and sparse update semantics.
- [Official Codex app-server rate-limit tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/rate_limits.rs) — authentication requirements and sanitized protocol test fixtures.

## Files changed

- `docs/research/spikes/SPIKE-001-codex.md` — this research report only.

No source files, shared documentation, provider adapters, credentials, or fixtures were changed.
