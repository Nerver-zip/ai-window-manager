# Domain model

## Separate health from window phase

Transport/auth health and quota lifecycle are distinct dimensions.

`ProviderHealth` is one of:

```text
UP | DEGRADED | AUTH_REQUIRED | UNAVAILABLE | ERROR
```

`WindowPhase` is one of:

```text
UNKNOWN | INACTIVE | ACTIVE | EXHAUSTED | RESET_DUE
```

A provider can therefore be `DEGRADED` while its last-known window remains `ACTIVE`.

## Evidence and capability contracts

`EvidenceSource` answers where a fact came from:

```text
official_supported | official_client_internal | observed | inferred
estimated | manual | unknown
```

`CapabilityContract` answers how stable the mechanism behind a capability is:

```text
official_supported | official_client_internal | observed_undocumented | unknown
```

These are deliberately separate. `resetAt.source = inferred` describes a value derived by an adapter, while `windowTrigger.contract = official_client_internal` describes the support status of the mechanism. A capability contract must never use fact evidence values such as `inferred` or `estimated`.

## Evidence-bearing facts

A normalized value is not just a primitive:

```ts
interface Fact<T> {
  value: T;
  source: EvidenceSource;
  confidence: Confidence;
  observedAt: string; // normalized UTC instant ending in Z
}
```

`Confidence` is orthogonal to provenance:

```text
exact | high | medium | low | unknown
```

For example, `remainingRatio = 1 - usageRatio` can be `inferred + exact`, while a heuristic reset estimate can be `estimated + low`. The runtime schema validates every fact's source, confidence, timestamp and value-specific constraints.

## Normalized window snapshot

```ts
interface WindowSnapshot {
  providerId: string;
  windowKind: string; // lowercase machine key, e.g. five_hour or weekly
  observedAt: string; // UTC instant
  phase: Fact<WindowPhase>;
  startedAt?: Fact<string>;
  durationSeconds?: Fact<number>;
  resetAt?: Fact<string>;
  usageRatio?: Fact<number>; // 0..1
  remainingRatio?: Fact<number>; // 0..1
}
```

Phase is evidence-bearing because a provider may report it directly while another adapter may infer it. Automatic scheduling can then require an actionable confidence rather than silently treating both cases as equivalent.

All timing and usage facts except `phase` are optional. Valid partial windows include:

- `UNKNOWN` with no optional facts;
- `INACTIVE` with duration only;
- `ACTIVE` with reset but no start;
- `ACTIVE` with usage but no reset;
- `ACTIVE` with independently rounded usage and remaining ratios.

Do not invent zeroes, timestamps, or cross-field requirements such as `ACTIVE` requiring `startedAt` or `INACTIVE` requiring zero usage.

Providers may expose multiple buckets. Keep five-hour and weekly windows as separate normalized records.

## Runtime validation boundary

Provider-specific parsing ends at the canonical schemas in `src/domain/schemas.ts`:

```text
provider raw/client response
        -> adapter parser
        -> ProviderObservationSchema
        -> validated ProviderObservation
```

Use `parseProviderObservation()` or `safeParseProviderObservation()` at the adapter boundary. The schema rejects malformed input instead of passing it to scheduler, persistence, API or metrics code.

The normalized boundary enforces:

- provider IDs and window kinds are bounded lowercase machine identifiers;
- timestamps are valid UTC ISO/RFC3339 instants using `Z` notation;
- ratios are finite and within `[0, 1]`;
- durations and staleness are positive bounded integers;
- window provider IDs match the parent observation;
- window kinds are unique within one observation;
- summaries and capability notes are bounded text;
- empty `windows` is valid for states such as `AUTH_REQUIRED` and `UNAVAILABLE`.

There is no requirement that usage plus remaining equals exactly `1`. Providers can independently round the values, and one value may be inferred from the other.

## Capabilities and actions

Capabilities remain truthful and capability-based:

```ts
interface ReadCapability {
  supported: boolean;
  contract: CapabilityContract;
  notes?: string;
}

interface TriggerCapability extends ReadCapability {
  consumesQuota: boolean | 'unknown';
}
```

Trigger quota consumption is always explicit. Unsupported or unknown provider operations remain monitor-only; the domain does not emulate support through undocumented behavior. `ProviderActionResult.status` remains separate from future persisted scheduler lifecycle states.

## Other entities and invariants

- `ProviderConfig`: enabled/mode/poll interval/non-secret provider configuration.
- `ProviderState`: current health plus the most recent normalized observation.
- `WindowSample`: historical normalized sample.
- `Event`: append-only operational/history event.
- `SchedulePolicy`: target reset / desired work window / manual mode.
- `ActionIntent`: durable side-effect intention with dedupe key and lifecycle.
- `RuntimeSetting`: UI-owned mutable, non-secret configuration.

1. All normalized instants are UTC; scheduling timezones are IANA identifiers handled outside `WindowSnapshot`.
2. Low/unknown-confidence timing may be displayed but is not automatically actionable under the MVP policy.
3. Provider inspection failure must not replace a last-known-good observation with fabricated zeros or nulls.
4. Normalized domain objects contain no raw provider payloads, credentials, cookies or transport-specific fields.
5. Database migrations and public HTTP compatibility are outside this domain issue; later persistence/API work consumes this contract.
