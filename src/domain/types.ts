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
