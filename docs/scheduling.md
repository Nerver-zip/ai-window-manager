# Scheduling semantics

The scheduler is a deterministic policy engine wrapped by a periodic reconciler.

The implemented pure entry point is `planWindowAction`. It receives the current
instant, provider/policy IDs, selected normalized window, current observed
window state, observation freshness, trigger capability and automation
eligibility. It returns a deterministic `START`, `WAIT`, `SKIP` or `NONE`
decision plus a JSON-serializable explanation. It never reads the system clock,
provider transport or database.

Stable reasons currently include `TARGET_RESET_WINDOW_MATCH`,
`TARGET_NOT_DUE`, `TARGET_MISSED`, `WINDOW_DURATION_UNKNOWN`,
`WINDOW_DURATION_CONFIDENCE_TOO_LOW`, `WINDOW_PHASE_CONFIDENCE_TOO_LOW`,
`WINDOW_NOT_INACTIVE`, `OBSERVATION_STALE`, `OBSERVATION_MISSING`,
`TRIGGER_CAPABILITY_UNAVAILABLE`, `AUTOMATION_DISABLED`, `POLICY_DISABLED`,
`MANUAL_POLICY`, `MONITORING_UNAVAILABLE`, `CURRENT_WINDOW_ACTIVE`,
`SCHEDULED_ANCHOR`, `ANCHOR_NOT_DUE`, `ANCHOR_EXPIRED`,
`ACTION_ALREADY_PENDING`, `ACTIVE_HOURS_COVERAGE`, `ACTIVE_HOURS_TOO_SHORT` and
`WINDOW_NOT_REPORTED`. Phase confidence is also retained in the explanation,
so a low-confidence observed phase is not presented as an ordinary monitoring
failure.

## Activation policies

Runtime policies are stored in SQLite and interpreted with the selected IANA
timezone:

- `manual`: observe only; never create an automatic start intent;
- `auto`: start when the selected provider window is inactive, fresh and safely
  triggerable; each provider has one canonical `activation-${providerId}` policy
  whose exact `windowKind` selects the only window that policy may manage;
- `fixed`: repeat one local anchor using the observed window duration;
- `custom_schedule`: evaluate a bounded list of local times;
- `active_hours`: start only while enough time remains in a configured local
  period to cover a full window.

The observed current window is a separate fact from the activation policy. The
UI/API can therefore show `Active`, `Inactive`, `Unknown` or `Monitoring
unavailable` without interpreting that state as a schedule instruction.
When a policy selects a specific window kind, current-window derivation is scoped
to that window; an active weekly window cannot incorrectly suppress a scheduled
five-hour start.

The target is required for every policy as soon as the provider has persisted
usage windows. For compatibility, an older manual policy may omit it while no
window has ever been observed; after observations exist, the overview flags that
policy for review and the schedule form requires one exact reported window.
Saving a different target updates the same canonical policy instead of creating
parallel policies for one provider.

Legacy `target_reset` and `work_window` records remain readable and are handled
by the compatibility path in the reconciler. The activation schedule API only
loads the explicit `activation-${providerId}` record; it never converts a legacy
reset target into an activation anchor because those two local times have
different meanings.

## Modes in the MVP

### Manual

The Overview's per-window `Start this window now` form creates an action intent
only when the provider is enabled, its persisted mode is `automation`, its
trigger capability is enabled for that exact `windowKind`, and a fresh preflight
inspection says the action is eligible. The HTTP handler only validates and
queues the intent; the executor performs provider I/O. Codex additionally
requires `AWM_CODEX_TRIGGER_ENABLED=true` (the default; set it to `false` to
opt out). Antigravity additionally requires
`AWM_ANTIGRAVITY_TRIGGER_ENABLED=true` (also default-on; set it to `false` to
opt out) and the selected window's configured
model. Its only implemented action is one ordinary `Hi!` through official
`agy -p`; it consumes normal quota. A selected model family is targeted, but
the provider may also account that request against the family's other window.
The Overview does not add a separate warning before a manual start. A
post-dispatch uncertain result is never blindly retried.

Manual starts remain separate from the saved automatic schedule: selecting a
provider/window for the action does not alter that provider's one saved policy.

### Legacy target reset compatibility

This section describes the compatibility path for persisted `target_reset`
records. New policies should use `fixed`, whose local time is the activation
anchor rather than the provider reset target.

User configures a local wall-clock reset target, e.g. 13:00. When an exact/high-confidence window duration and phase fact are known:

```text
target trigger ≈ target reset - window duration
```

For a 5h window and 13:00 target, the candidate trigger is 08:00 local for that date.

The current pure decision consumer requires both `durationSeconds.confidence` and `phase.confidence` to be `exact` or `high`, and requires `phase.value` to be `INACTIVE`. A low-confidence phase produces `WINDOW_PHASE_CONFIDENCE_TOO_LOW`; it is not silently treated as inactive.

### Legacy desired work period compatibility

MVP computes a deterministic recommendation; it does **not** solve a generalized optimization problem. Initial heuristic:

1. estimate high-value reset near the first third of the configured work period;
2. project the provider window backwards to a trigger candidate;
3. display expected overlap and assumptions;
4. require the user to choose/apply a target-reset schedule.

No ML/LLM is involved.

## Reconcile loop

Default every 30s:

1. read wall clock + monotonic clock;
2. load provider configs, policies, current state and open intents;
3. inspect providers whose persisted poll interval is due;
4. validate and persist observations, samples and events;
5. derive current-window state and preserve last-known-good data on failure;
6. resolve the next policy occurrence and call pure `planWindowAction()`;
7. persist a proposed intent with a unique provider/policy/cycle dedupe key;
8. the separate action executor handles only due intents and performs its own
   preflight, claim, dispatch and confirmation lifecycle.

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

For quota-affecting `trigger_window`, a transport timeout after dispatch is
**uncertain**, not `failed_retryable`. The daemon reconciles with a fresh usage
observation before considering any further action. A Codex `turn/completed`
notification is the provider action confirmation; it does not authorize a
second turn.

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
