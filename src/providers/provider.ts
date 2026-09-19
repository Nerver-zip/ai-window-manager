import type {
  ProviderActionResult,
  ProviderCapabilities,
  ProviderHealth,
  ProviderObservation,
  TriggerWindowRequest,
} from '../domain/types.js';

export interface ProviderContext {
  signal?: AbortSignal;
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
}
