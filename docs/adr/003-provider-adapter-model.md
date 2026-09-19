# ADR-003 — Capability-based provider adapters

Status: Accepted for MVP

Adapters expose truthful capabilities plus inspection/action operations. They are allowed to return partial observations with evidence metadata. The interface does not force every provider to expose usage/reset/trigger. Unsupported or unknown action capability means monitor-only, not emulation through hacks.

CORE-001 clarifies that fact provenance and capability stability are separate concepts. `Fact<T>.source` uses `EvidenceSource`, while capability descriptors use `CapabilityContract`; a trigger descriptor also explicitly declares whether it consumes quota (`true`, `false`, or `unknown`). Normalized observations, including evidence-bearing window phase, are validated through the canonical domain schema before downstream consumers use them.
