# ADR-010 — Verified recovery of uncertain starts

Status: Accepted

## Context

ADR-008 deliberately rejected automatic unknown-outcome expiry. That remains
correct for elapsed time, a quota percentage correction, a moving reset
projection, or a weekly reset that does not prove the exact target cycle ended.
However, provider-wide serialization means an old `uncertain` intent can block
every later policy forever even after durable evidence proves its original
target opportunity has ended. A separate liveness gap exists for a start that
was safely skipped before dispatch: a target-only legacy dedupe key can keep the
same target opportunity suppressed after a shared allowance has independently
advanced.

PR #31 already prevents a fresh start when the target or any consumed allowance
is exhausted, including at the executor's fresh preflight. This decision
preserves that prevention and adds only evidence-backed recovery.

## Decision

The executor evaluates automatic resolution during the existing persisted,
backed-off, read-only confirmation inspection. It never retries the old prompt.
The original intent, dedupe key, attempt counters, error history and cleanup
obligations remain attached to that attempt. Automatic closure is an
`action_resolved_unknown` transition, not a success or failure claim. It is
conditional on the intent still being uncertain, the expected confirmation
version, and the absence of a pending operator review. The structured event
records the verified evidence class and that provider serialization was
released. Manual audited review remains available when proof is unavailable.

| Evidence from the exact provider/window/cycle                                                                                                                                                                        | Result                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fresh exact/high active evidence for the original cycle                                                                                                                                                              | Confirm the old intent through the existing confirmation path.                       |
| Durable anchored or reported inactive closure for the exact original target cycle, plus a fresh later target cycle                                                                                                   | Close as `resolved_unknown`; allow normal planning to assess a distinct opportunity. |
| No unexpired anchor; persisted post-outcome time, full target duration, and two fresh high-confidence zero-use rolling-inactive readings at least 15 seconds apart with consistent reset movement and bounded jitter | Close as `resolved_unknown`.                                                         |
| Weekly reset only, moving projection, usage drop, elapsed TTL, insufficient confidence, stale/out-of-order reads, missing identity/time, provider outage or runtime change                                           | Keep unresolved and serialized; record a bounded waiting reason where applicable.    |

The rolling proof is the existing ADR-008 proof. It is not a fixed five-hour
expiry. A target's future anchor cannot be replaced by a reset in another
window. A later cycle's active state cannot confirm the old prompt.

Automatic opportunities use a stable generation composed from the exact target
cycle and every allowance cycle the provider's existing consumption contract
checks: all reported Codex windows, the canonical Claude Code five-hour/weekly
pair, or only the target's Antigravity family. A generation does not change on
ordinary observation ticks or usage changes. Auto intents persist that identity
in their existing dedupe key and explanation. The executor rechecks it together
with policy, capability, exact target, current mode, fresh authorization,
provider-wide serialization and every consumed allowance before dispatch.

Legacy target-only dedupe rows remain intact. A preflight-skipped legacy row is
considered superseded only if durable history proves no dispatch-start event and
a fresh, high-confidence lifecycle transition in another consumed allowance is
later than a prior exact/high active, exhausted or reset-due sample. A legacy
`resolved_unknown` row requires its linked durable resolution evidence and such
an independent transition. All other legacy rows continue to block. The normal
planner and executor gates still decide whether a new action is eligible.

No schema migration is needed: cycle identities use `observed_window_cycles`,
legacy proof uses existing samples/events and linked resolution evidence, and
new generations use existing action intent fields. No old record is deleted or
rewritten.

## Consequences

Uncertain outcomes may still remain blocked indefinitely when exact proof cannot
be established. This is intentional. A verified closure releases only the
provider-wide serialization block; it does not authorize a trigger. Each later
action is a new persisted intent and must pass ordinary planning and a fresh
preflight. Provider adapters, quota semantics, credentials and prompt contents
are unchanged.

See [ADR-008](008-unknown-action-resolution.md) for the retained manual review
path and rolling evidence contract.
