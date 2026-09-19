export type ContractClass =
  | 'official_supported'
  | 'official_client_internal'
  | 'observed'
  | 'inferred'
  | 'estimated'
  | 'manual'
  | 'unknown';

export type Confidence = 'exact' | 'high' | 'medium' | 'low' | 'unknown';

export interface Fact<T> {
  value: T;
  source: ContractClass;
  confidence: Confidence;
  observedAt: string;
}

export type ProviderHealth = 'UP' | 'DEGRADED' | 'AUTH_REQUIRED' | 'UNAVAILABLE' | 'ERROR';
export type WindowPhase = 'UNKNOWN' | 'INACTIVE' | 'ACTIVE' | 'EXHAUSTED' | 'RESET_DUE';

export interface WindowSnapshot {
  providerId: string;
  windowKind: string;
  phase: WindowPhase;
  observedAt: string;
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

export interface CapabilityDescriptor {
  supported: boolean;
  contract: ContractClass;
  consumesQuota?: boolean;
  notes?: string;
}

export interface ProviderCapabilities {
  usageRead: CapabilityDescriptor;
  resetRead: CapabilityDescriptor;
  windowTrigger: CapabilityDescriptor;
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
