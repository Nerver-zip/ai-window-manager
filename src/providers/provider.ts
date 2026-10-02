import type {
  ProviderActionResult,
  ProviderCapabilities,
  ProviderHealth,
  ProviderObservation,
  TriggerWindowRequest,
} from '../domain/types.js';
import type { ProviderCleanupArtifact } from '../domain/provider-cleanup.js';

export type { ProviderCleanupArtifact } from '../domain/provider-cleanup.js';

export interface ProviderContext {
  signal?: AbortSignal;
  /** Executor-owned synchronous gate; call immediately before the quota-affecting write. */
  assertDispatchAllowed?: () => void;
  /** Persist a provider-side artifact ID before a quota-affecting turn is dispatched. */
  registerCleanupArtifact?: (artifact: ProviderCleanupArtifact) => Promise<void>;
}

export interface ProviderAdapter {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  health(ctx: ProviderContext): Promise<ProviderHealth>;
  inspect(ctx: ProviderContext): Promise<ProviderObservation>;
  triggerWindow?(
    ctx: ProviderContext,
    request: TriggerWindowRequest,
  ): Promise<ProviderActionResult>;
  /** Delete a disposable artifact created only for an AWM trigger. */
  cleanupArtifact?(ctx: ProviderContext, artifact: ProviderCleanupArtifact): Promise<void>;
}
