import type { StorageRepositories } from '../storage/repositories.js';

export interface BootstrapProviderDefaultsInput {
  repositories: StorageRepositories;
  provider: { id: string; kind: string; config: unknown };
  nowMs: number;
  pollIntervalSeconds: number;
  timezone: string;
  triggerEnabled: boolean;
}

/** Seed defaults once; persisted operator choices always remain authoritative. */
export function seedBootstrapProviderDefaults(input: BootstrapProviderDefaultsInput): void {
  const { repositories, provider, nowMs, pollIntervalSeconds, timezone, triggerEnabled } = input;

  if (!repositories.providers.get(provider.id)) {
    repositories.providers.upsert({
      id: provider.id,
      kind: provider.kind,
      enabled: true,
      mode: triggerEnabled ? 'automation' : 'monitor_only',
      pollIntervalSeconds,
      config: provider.config,
      configVersion: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  if (repositories.schedulePolicies.list(provider.id).length === 0) {
    repositories.schedulePolicies.upsert({
      id: `activation-${provider.id}`,
      providerId: provider.id,
      kind: triggerEnabled ? 'auto' : 'manual',
      enabled: true,
      timezone,
      config: {},
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }
}
