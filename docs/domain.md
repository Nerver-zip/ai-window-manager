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
  /** Optional allowlist for adapters that support only exact normalized targets. */
  supportedWindowKinds?: string[];
}
```

Trigger quota consumption is always explicitly declared in the capability
contract. When `supportedWindowKinds` is
present, only those exact normalized targets may be dispatched; an unlisted
future target remains monitorable but is not triggerable. Antigravity uses this
allowlist for its four known group/cadence targets. Its `observed_undocumented`
contract is exposed only when the application feature gate is enabled (enabled
by default for configured providers, with an explicit opt-out). Provider mode,
a supported exact target and a fresh preflight remain required.
`ProviderActionResult.status` remains separate from
the persisted scheduler lifecycle state.

## Other entities and invariants

- `ProviderConfig`: enabled/mode/poll interval/non-secret provider configuration.
- `ProviderState`: current health plus the most recent normalized observation.
- `WindowSample`: historical normalized sample.
- `Event`: append-only operational/history event.
- `SchedulePolicy`: manual, auto, fixed-cycle, custom-time or active-hours
  activation preference. Legacy target-reset/work-window records remain readable
  and executable by the compatibility reconciler until an activation policy
  replaces them. The activation read model does not reinterpret those records:
  a legacy reset target is not the same fact as a new-window anchor.
- `ActionIntent`: durable side-effect intention with dedupe key and lifecycle.
- `RuntimeSetting`: UI-owned mutable, non-secret configuration.

1. All normalized instants are UTC; scheduling timezones are IANA identifiers handled outside `WindowSnapshot`.
2. Low/unknown-confidence timing may be displayed but is not automatically actionable under the MVP policy.
3. Provider inspection failure must not replace a last-known-good observation with fabricated zeros or nulls.
4. Normalized domain objects contain no raw provider payloads, credentials, cookies or transport-specific fields.
5. Database migrations and public HTTP compatibility are outside this domain issue; later persistence/API work consumes this contract.
