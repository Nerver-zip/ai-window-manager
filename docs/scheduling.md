# Scheduling semantics

The scheduler is a deterministic policy engine wrapped by a periodic reconciler.

The implemented pure entry point is `decideTargetReset`. It receives the
current instant, provider/policy IDs, target reset, selected normalized window,
observation freshness, trigger capability and automation eligibility. It returns
either `noop` or `create_intent` plus a JSON-serializable explanation. It never
reads the system clock, provider transport or database.

Stable reasons currently include `TARGET_RESET_WINDOW_MATCH`,
`TARGET_NOT_DUE`, `TARGET_MISSED`, `WINDOW_DURATION_UNKNOWN`,
`WINDOW_DURATION_CONFIDENCE_TOO_LOW`, `WINDOW_PHASE_CONFIDENCE_TOO_LOW`,
`WINDOW_NOT_INACTIVE`, `OBSERVATION_STALE`, `OBSERVATION_MISSING`,
`TRIGGER_CAPABILITY_UNAVAILABLE` and `AUTOMATION_DISABLED`.

## Modes in the MVP

### Manual

`Trigger now` creates an action intent only if the provider reports `canTriggerWindow=true`, the user has enabled automation for that provider, and a fresh preflight inspection says an action is eligible.

### Target reset

User configures a local wall-clock reset target, e.g. 13:00. When an exact/high-confidence window duration and phase fact are known:

```text
target trigger ≈ target reset - window duration
```

For a 5h window and 13:00 target, the candidate trigger is 08:00 local for that date.

The current pure decision consumer requires both `durationSeconds.confidence` and `phase.confidence` to be `exact` or `high`, and requires `phase.value` to be `INACTIVE`. A low-confidence phase produces `WINDOW_PHASE_CONFIDENCE_TOO_LOW`; it is not silently treated as inactive.

### Desired work period

MVP computes a deterministic recommendation; it does **not** solve a generalized optimization problem. Initial heuristic:

1. estimate high-value reset near the first third of the configured work period;
2. project the provider window backwards to a trigger candidate;
3. display expected overlap and assumptions;
4. require the user to choose/apply a target-reset schedule.

No ML/LLM is involved.

## Reconcile loop

Default every 30s:

1. read wall clock + monotonic clock;
2. load provider configs/schedules/current state/open intents;
3. inspect providers whose poll is due;
4. normalize and persist observations/events;
5. recover/resolve stale `executing`/`uncertain` intents;
6. call pure `decideSchedule()` per provider;
7. persist proposed action intent with unique dedupe key;
8. if automation is enabled, preflight re-inspect;
9. atomically claim intent;
10. execute provider action once;
11. persist result;
12. perform confirmation inspection and update result to confirmed/uncertain.

## Dedupe key

Conceptually:

```text
provider_id + action_type + schedule_policy_id + target_cycle_instant
```

The DB unique constraint is the final guard. Repeated ticks can propose the same action without producing multiple triggers.

## Action lifecycle

```text
planned
  ├─> executing ─> succeeded ─> confirmed
  │                  └────────> uncertain
  ├─> skipped
  ├─> canceled
  └─> failed_retryable / failed_terminal
```

For quota-affecting `trigger_window`, a transport timeout after dispatch is **uncertain**, not `failed_retryable`. The daemon reconciles with a fresh usage observation before considering any further action.

## Retries

- Read-only inspection: bounded exponential backoff + jitter, reset after success.
- Auth errors: no tight retry; transition to `AUTH_REQUIRED`.
- 429: honor official retry information when available; otherwise bounded backoff.
- Trigger rejected before dispatch: retry only if error is explicitly safe/retryable and intent remains within schedule tolerance.
- Trigger outcome unknown after dispatch: no automatic retry.

## Restart recovery

At startup:

1. open/migrate DB;
2. load last-known provider state;
3. any persisted `executing` trigger from a prior process becomes `uncertain_recovery`;
4. inspect provider before making new decisions;
5. resolve confirmed state when possible; otherwise leave it visibly uncertain and require later observation/manual intervention.

## Missed actions during downtime

MVP default is **skip, don't surprise**.

Example: scheduled 08:00, host returns 08:20. The reconciler records `schedule_missed`, explains the 20-minute miss, and does not automatically spend quota. UI offers `Trigger now` if still eligible. A bounded catch-up policy is future work, not default MVP behavior.

## Timezone and DST

- DB instants: UTC.
- Schedules: local wall-clock + IANA timezone, e.g. `America/Sao_Paulo`.
- Convert schedule occurrence to an instant each day; never persist a fixed offset.
- Spring-forward nonexistent time: choose the first valid instant after the gap and record an adjustment event.
- Fall-back ambiguous time: choose the earlier occurrence for MVP and expose that choice in the decision explanation.
- Durations are elapsed time and use monotonic time while the process runs.
- Compare monotonic elapsed vs wall-clock delta; a significant clock step forces full reconcile and invalidates old immediate-action assumptions.
- Host should run NTP; health can warn on obviously invalid time, but the application is not an NTP client.

## Explanation object

Every recommendation/action decision should have a structured reason, for example:

```json
{
  "decision": "trigger",
  "reasonCode": "TARGET_RESET_WINDOW_MATCH",
  "desiredResetLocal": "13:00",
  "timezone": "America/Sao_Paulo",
  "windowDurationSeconds": 18000,
  "targetTriggerAt": "2026-09-14T11:00:00Z",
  "resetConfidence": "exact"
}
```

Persist the reason with the intent/event so logs/UI can answer “why?”.
