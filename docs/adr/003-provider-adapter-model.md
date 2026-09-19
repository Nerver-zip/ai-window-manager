# ADR-003 — Capability-based provider adapters

Status: Accepted for MVP

Adapters expose truthful capabilities plus inspection/action operations. They are allowed to return partial observations with evidence metadata. The interface does not force every provider to expose usage/reset/trigger. Unsupported or unknown action capability means monitor-only, not emulation through hacks.
