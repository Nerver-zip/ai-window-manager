# SPIKE-004 — Codex window lifecycle semantics

**Date:** 2026-09-19  
**Scope:** determine whether the official Codex app-server provides enough
evidence to authorize an automatic window-positioning action. No turn, reset
credit consumption, or trigger was executed.

## Classification

`BLOCKED`

The required authenticated lifecycle evidence was not available in this
environment, and no quota-affecting live test was authorized. Automatic Codex
triggering therefore remains disabled. The existing adapter remains
read-only/monitor-only.

`BLOCKED` is intentional here: this report does not promote an unverified
manual or automatic trigger to a supported capability.

## Evidence and method

### Official documentation

The official app-server documentation defines `account/read`,
`account/rateLimits/read`, and the `account/rateLimits/updated` notification.
The rate-limit response contains usage percentage, optional duration, and
optional reset timestamps, and can contain both a compatibility `rateLimits`
view and multiple `rateLimitsByLimitId` buckets. It also documents that reset
credits are a separate operation; AWM does not call that operation.

The official CLI documentation describes the standalone Linux/macOS installer,
but installation/authentication documentation does not by itself prove the
provider's five-hour window transition semantics.

### Local read-only process probe

The installed official CLI reported:

```text
codex-cli 0.155.1
```

Using a newly created disposable `CODEX_HOME`, the following sequence was
executed against `codex app-server --stdio`:

```text
initialize
initialized
account/read { refreshToken: false }
account/rateLimits/read
```

Observed result:

```text
account/read -> { account: null, requiresOpenaiAuth: true }
account/rateLimits/read -> JSON-RPC authentication-required error
```

The process initialized successfully and was shut down normally. No account
identity, token, cookie, auth file, turn, or reset-credit operation was used.

## Lifecycle questions

### A — What is returned after expiry and before a new turn?

**Unverified.** The environment had no authenticated account, so it was not
possible to capture an authenticated post-expiry snapshot. The unauthenticated
error is a sign-in state, not an expired-window observation.

### B — Can expired, unused, and stale states be distinguished?

**Not proven.** The documented fields are useful observations, but no paired
authenticated snapshots were collected that establish a deterministic rule
for distinguishing these lifecycle states. AWM must not infer `INACTIVE` from
`usedPercent = 0`, `remaining = 100%`, or an elapsed reset timestamp.

### C — What changes after the first ordinary turn?

**Not tested.** The controlled experiment was not run because it would require
an authorized authenticated account and one quota-affecting ordinary turn.

### D — Can AWM confirm that the desired window started?

**Not proven.** Without the before/after authenticated observations from C,
there is no validated confirmation rule that distinguishes a newly started
window from another provider state or an ambiguous/stale observation.

## Safety decision

The current Codex capability declaration remains:

```text
usageRead: supported
resetRead: supported when the official response includes resetAt
windowTrigger: unsupported
```

No `INACTIVE` inference was added. No `turn/start`, `thread/start`, reset
credit consumption, direct backend endpoint, token injection, or manual trigger
endpoint was added. `CODEX-002` remains deferred pending an explicitly
authorized, minimal, controlled live experiment and a reviewed confirmation
rule.

## Required authorized follow-up

In a disposable environment with an explicitly authorized test account:

1. authenticate through the official Codex device-code or browser flow into a
   dedicated persistent `CODEX_HOME`;
2. capture a sanitized `account/rateLimits/read` snapshot before the test;
3. use an already naturally expired eligible window, if available;
4. send exactly one minimal ordinary turn in an empty isolated workspace;
5. capture a fresh rate-limit snapshot immediately afterward;
6. compare reset timestamp, used percentage, duration, bucket identity, and
   primary/secondary values;
7. repeat only when the state is naturally available; never burn quota to
   manufacture expiry.

The result must be reviewed before any automatic trigger capability is exposed.

## References

- [Codex App Server documentation](https://developers.openai.com/es-419/docs/app-server)
- [Codex CLI documentation](https://developers.openai.com/es-419/docs/codex/cli)
- [SPIKE-001 — Codex app-server inspection/auth flow](./SPIKE-001-codex.md)
