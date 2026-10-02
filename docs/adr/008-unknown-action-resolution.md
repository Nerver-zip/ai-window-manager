# ADR-008 — Manual closure with an unknown action outcome

Status: Accepted

## Decision

An unresolved prompt must never be retried because its quota cycle ended. The
operator may request a freshly verified, audited closure as `resolved_unknown`.
This terminal state asserts neither success nor failure and preserves the original
intent ID, dedupe key, target, explanation, dispatch count and error history.

Closure requires read-only observation by the application, canonical validation,
freshness after the requested read began, an exact target/cycle identity and
durable lifecycle evidence that the corresponding old cycle ended. Evidence is
an observed transition beyond a previously anchored cycle boundary or a supported
active-to-inactive lifecycle transition, not a local deadline, TTL, rounded quota
value or isolated reset timestamp.

Closure evidence is recorded only for unresolved side effects referencing that
exact cycle. It survives restarts and raw-history pruning, and is removed by
cascade when the associated terminal intent reaches its audit retention period.
Migration does not fabricate evidence for already-lost or unidentified cycles.
Insufficient evidence leaves the provider blocked with an explicit reason.

New actions, including manual requests, durably bind their exact preflight
observed cycle before claiming and sending the prompt. Missing identity is
accepted only while an intent is unsent; malformed existing identity is never
replaced. Recovered `executing`, `succeeded` or `uncertain` legacy intents with
no cycle identity cannot be confirmed from a currently active window. Their
original outcome remains unknown and blocked; migration or restart cannot
reconstruct the cycle of an already dispatched side effect.

The service must coordinate with action execution and executable updates. It
must not close `executing` or overwrite a concurrently confirmed result. The
SQL transition is conditional on `uncertain` and the expected update/confirmation
version, with an audit event in the same transaction. Repeated requests return
the persisted outcome without repeated transitions or provider dispatch.

The command requires operator authentication, Origin and CSRF checks,
and a native form with PRG. HTTP handlers only enqueue requests; they never call
provider actions. Closing uncertainty does not waive remaining cleanup jobs or
the normal gates for future actions. There is no automatic expiry-based closure.

Requests are persisted once per intent, coalesced while pending, and consumed
by the action executor under its provider-wide serialization. A failed review
is checked, not retried automatically as a mutation; the operator may request
another read after a 30-second cooldown. Inspection failures do not close the
intent or repeat its prompt. A same-cycle active observation can still confirm
the known effect normally rather than recording an unknown outcome.

## Upgrade implications

Migration 011 expands the state CHECK constraint by transactionally rebuilding
the intents table, preserving existing columns, values, indexes and dedupe
uniqueness. `resolved_unknown` follows the 365-day terminal-intent retention
policy. Back up first; restoring an earlier compatible backup is the schema
rollback path. Upgrading an existing deployment requires the operator-run
backup and migration procedure in [Deployment](../deployment.md).
