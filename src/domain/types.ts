export type EvidenceSource =
  | 'official_supported'
  | 'official_client_internal'
  | 'observed'
  | 'inferred'
  | 'estimated'
  | 'manual'
  | 'unknown';

export type CapabilityContract =
  'official_supported' | 'official_client_internal' | 'observed_undocumented' | 'unknown';

export type Confidence = 'exact' | 'high' | 'medium' | 'low' | 'unknown';

export interface Fact<T> {
  value: T;
  source: EvidenceSource;
  confidence: Confidence;
  observedAt: string;
}

export type ProviderHealth = 'UP' | 'DEGRADED' | 'AUTH_REQUIRED' | 'UNAVAILABLE' | 'ERROR';
export type WindowPhase = 'UNKNOWN' | 'INACTIVE' | 'ACTIVE' | 'EXHAUSTED' | 'RESET_DUE';

export interface WindowSnapshot {
  providerId: string;
  windowKind: string;
  observedAt: string;
  phase: Fact<WindowPhase>;
  startedAt?: Fact<string>;
  durationSeconds?: Fact<number>;
  resetAt?: Fact<string>;
  usageRatio?: Fact<number>;
  remainingRatio?: Fact<number>;
}

export type ActivationPolicyKind = 'manual' | 'auto' | 'fixed' | 'custom_schedule' | 'active_hours';

export interface ActiveHoursPeriod {
  start: string;
  end: string;
}

export type ActivationPolicy =
  | {
      id: string;
      providerId: string;
      kind: 'manual' | 'auto';
      enabled: boolean;
      timezone: string;
      updatedAtMs: number;
    }
  | {
      id: string;
      providerId: string;
      kind: 'fixed';
      enabled: boolean;
      timezone: string;
      windowKind: string;
      anchorLocalTime: string;
      toleranceSeconds: number;
      updatedAtMs: number;
    }
  | {
      id: string;
      providerId: string;
      kind: 'custom_schedule';
      enabled: boolean;
      timezone: string;
      windowKind: string;
      times: string[];
      toleranceSeconds: number;
      updatedAtMs: number;
    }
  | {
      id: string;
      providerId: string;
      kind: 'active_hours';
      enabled: boolean;
      timezone: string;
      windowKind: string;
      periods: ActiveHoursPeriod[];
      updatedAtMs: number;
    };

export type CurrentWindowStatus = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN' | 'UNAVAILABLE';

export interface CurrentWindowState {
  providerId: string;
  status: CurrentWindowStatus;
  windowKind?: string;
  observedAt?: string;
  startedAt?: Fact<string>;
  expectedEndAt?: Fact<string>;
  confidence: Confidence;
  reason?: string;
}

export interface ProviderObservation {
  providerId: string;
  health: ProviderHealth;
  observedAt: string;
  windows: WindowSnapshot[];
  staleAfterSeconds: number;
  summary?: string;
}

export interface ReadCapability {
  supported: boolean;
  contract: CapabilityContract;
  notes?: string;
}

export interface TriggerCapability {
  supported: boolean;
  contract: CapabilityContract;
  consumesQuota: boolean | 'unknown';
  notes?: string;
}

export interface ProviderCapabilities {
  usageRead: ReadCapability;
  resetRead: ReadCapability;
  windowTrigger: TriggerCapability;
}

export type ProviderActionStatus = 'succeeded' | 'failed' | 'uncertain' | 'rejected';

export interface TriggerWindowRequest {
  intentId: string;
  dedupeKey: string;
  reasonCode: string;
}

export interface ProviderActionResult {
  status: ProviderActionStatus;
  occurredAt: string;
  confirmationHint?: string;
  errorCode?: string;
}
