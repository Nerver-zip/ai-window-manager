import type { ProviderClientId } from './runtime-store.js';
import type { ProviderClientUpdateStatus } from './update-service.js';

/** Narrow authenticated web boundary; it never exposes the runtime store or update URLs. */
export interface ProviderClientUpdateWebControls {
  getStatus(providerId: ProviderClientId): ProviderClientUpdateStatus;
  isRuntimeChanging(providerId: ProviderClientId): boolean;
  autoUpdateEnabled(providerId: ProviderClientId): boolean;
  setAutoUpdateEnabled(providerId: ProviderClientId, enabled: boolean): void;
  startCheck(providerId: ProviderClientId): boolean;
  startUpdate(providerId: ProviderClientId): boolean;
  startRollback(providerId: ProviderClientId): boolean;
}
