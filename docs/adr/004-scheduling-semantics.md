# ADR-004 — Reconciler + persisted intents

Status: Accepted for MVP

Use a periodic reconcile loop and durable `action_intents`, not cron jobs or long-lived in-memory timers. Persist unique dedupe intent before any trigger. Unknown post-dispatch result becomes `uncertain` and is not automatically retried. Missed downtime actions are skipped by default.
