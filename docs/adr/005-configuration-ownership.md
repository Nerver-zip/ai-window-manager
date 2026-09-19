# ADR-005 — DB owns runtime config; env owns bootstrap/process config

Status: Accepted for MVP

Environment controls process/container bootstrap and seeds initial mutable values only on a fresh DB. SQLite then owns runtime/UI settings. Secrets remain outside both ordinary runtime settings and browser APIs. This avoids two mutable sources of truth.
