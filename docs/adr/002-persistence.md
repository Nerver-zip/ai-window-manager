# ADR-002 — SQLite persistence

Status: Accepted for MVP

Use SQLite `/data/window-manager.db`, WAL, foreign keys and forward-only migrations. One daemon owns writes, so a network DB/Redis would add operational complexity without a concurrency requirement. Current-state tables coexist with append-only history; this is not event sourcing.
