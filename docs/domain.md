# Domain model

## Separate health from window phase

Do not mix transport/auth health with quota lifecycle.

`ProviderHealth`:

```text
UP
DEGRADED
AUTH_REQUIRED
UNAVAILABLE
ERROR
```

`WindowPhase`:

```text
UNKNOWN
INACTIVE
ACTIVE
EXHAUSTED
RESET_DUE
```

A provider can therefore be `DEGRADED` while the last-known window remains `ACTIVE`.

## Evidence-bearing facts

A timestamp/ratio is not just a primitive:

```ts
type EvidenceSource =
  | 'official_supported'
  | 'official_client_internal'
  | 'observed'
  | 'inferred'
  | 'estimated'
  | 'manual';

type Confidence = 'exact' | 'high' | 'medium' | 'low' | 'unknown';

interface Fact<T> {
  value: T;
  source: EvidenceSource;
  confidence: Confidence;
  observedAt: string; // UTC instant
}
```

This is intentionally small. It prevents an inferred `resetAt` from looking identical to a provider-returned exact timestamp.

## Normalized window snapshot

```ts
interface WindowSnapshot {
  providerId: string;
  windowKind: 'five_hour' | 'weekly' | string;
  phase: WindowPhase;
  observedAt: string;
  startedAt?: Fact<string>;
  durationSeconds?: Fact<number>;
  resetAt?: Fact<string>;
  usageRatio?: Fact<number>; // 0..1
  remainingRatio?: Fact<number>; // 0..1
}
```

Providers may expose multiple buckets. Never force one global “quota” number if the provider exposes a five-hour + weekly pair.

## Key entities

- `ProviderConfig`: enabled/mode/poll interval/non-secret provider configuration.
- `ProviderState`: current health + most recent normalized observation.
- `WindowSample`: historical normalized sample.
- `Event`: append-only operational/history event.
- `SchedulePolicy`: target reset / desired work window / manual mode.
- `ActionIntent`: durable side-effect intention with dedupe key and lifecycle.
- `RuntimeSetting`: UI-owned mutable, non-secret configuration.

## Invariants

1. Ratios are nullable and, when present, within `[0,1]`.
2. All persisted instants are UTC.
3. A schedule's timezone is an IANA identifier, never a fixed UTC offset.
4. `ActionIntent.dedupe_key` is unique.
5. A trigger starts only after its intent is durable.
6. `uncertain` trigger outcome is not auto-retried.
7. Low/unknown-confidence inferred reset values may be displayed but are not sufficient for automatic action unless the policy explicitly permits that confidence class; MVP automation requires `exact` or `high` plus fresh preflight observation.
8. Provider inspection failure never silently replaces a last-known-good snapshot with zeros/nulls.
