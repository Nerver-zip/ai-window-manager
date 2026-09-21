# SPIKE-004 — Codex window lifecycle semantics

**Date:** 2026-09-20
**Scope:** determine whether the official Codex app-server provides enough
evidence to authorize one explicitly opt-in, ordinary window-positioning turn.
No reset-credit operation or undocumented endpoint is allowed.

## Classification

`VALIDATED_WITH_UNCERTAINTY`

The previously blocked experiment was completed by the operator in the
dedicated Compose runtime, using the official Codex app-server and the same
persistent `CODEX_HOME` used by AWM. One explicitly authorized ordinary `Hi!`
turn was dispatched after the five-hour window was naturally eligible. The
provider then returned a fixed reset timestamp instead of continuing to project
the reset as `now + 5h`, and subsequent inspections showed that timestamp
counting down. This validates the minimal heartbeat effect.

The action response exceeded AWM's then-configured five-second request timeout
by roughly two seconds, so the executor correctly recorded `action_uncertain`
rather than claiming transport success or blindly retrying. Fresh post-action
observations provided operational confirmation. The follow-up is now resolved
by separating read and action deadlines: the heartbeat uses the bounded
`AWM_CODEX_ACTION_TIMEOUT_SECONDS` setting, defaulting to 30 seconds. The
uncertain-outcome rule remains unchanged.

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

The live run showed the eligible pre-action state used by AWM. Before the
heartbeat, the observed reset advanced with each fresh inspection at roughly
five hours from the current instant. This confirms that the provider had not
yet anchored the new five-hour window.

### B — Can expired, unused, and stale states be distinguished?

The live run validates the operational distinction needed for this path:
before the turn the reset was projected forward, and after the turn it remained
anchored while the remaining time decreased. This does not make reset-time
inference an official lifecycle field; AWM continues to mark inferred phase and
must not infer it from `usedPercent = 0` or `remaining = 100%` alone.

### C — What changes after the first ordinary turn?

The authorized `Hi!` turn was sent by AWM at approximately 21:38 local time.
The next observations kept the reset at approximately 05:38 UTC rather than
moving it forward with every poll. The exact provider response arrived after
the then-configured local five-second deadline, which explains the temporary
`action_uncertain` event.

### D — Can AWM confirm that the desired window started?

Yes at the operational observation level: the persisted before/after history
shows the reset transition and a stable anchored reset after the turn. The
transport-level confirmation was not received before the configured timeout,
so the executor's `uncertain` classification remains correct and must not be
weakened.

## Safety decision

The current Codex capability declaration remains:

```text
usageRead: supported
resetRead: supported when the official response includes resetAt
windowTrigger: opt-in only (`AWM_CODEX_TRIGGER_ENABLED=true` plus provider
automation mode); consumes quota and sends exactly one ordinary `Hi!` turn
```

The adapter still uses no direct backend endpoint, token injection, or reset
credit operation. The local inferred-phase correction and the live heartbeat
experiment are now enough to close this spike. The action remains explicitly
opt-in and the uncertain-outcome safety rule remains in force.

## Follow-up hardening

1. Keep the read/action timeout separation and review the bounded action value
   if authenticated provider latency changes; do not hide an uncertain outcome.
2. Keep `turn/completed` and the post-action observation as the confirmation
   path, with no blind retry after timeout.
3. Repeat only when the state is naturally available; never burn quota to
   manufacture expiry.

This spike closes the lifecycle question for the current Codex/account path;
it does not make the quota-consuming capability default-on or prove identical
behavior across all plans and future client versions.

## References

- [Codex App Server documentation](https://developers.openai.com/es-419/docs/app-server)
- [Codex CLI documentation](https://developers.openai.com/es-419/docs/codex/cli)
- [SPIKE-001 — Codex app-server inspection/auth flow](./SPIKE-001-codex.md)
