import type { StorageRepositories } from '../storage/repositories.js';

export interface BootstrapProviderDefaultsInput {
  repositories: StorageRepositories;
  provider: { id: string; kind: string; config: unknown };
  nowMs: number;
  pollIntervalSeconds: number;
  timezone: string;
  triggerEnabled: boolean;
}

/** Seed defaults and upgrade only the old implicit monitor-only/manual defaults. */
export function seedBootstrapProviderDefaults(input: BootstrapProviderDefaultsInput): void {
  const { repositories, provider, nowMs, pollIntervalSeconds, timezone, triggerEnabled } = input;

  const existingProvider = repositories.providers.get(provider.id);
  if (!existingProvider) {
    repositories.providers.upsert({
      id: provider.id,
      kind: provider.kind,
      enabled: true,
      mode: triggerEnabled ? 'automation' : 'monitor_only',
      modeExplicit: false,
      pollIntervalSeconds,
      config: provider.config,
      configVersion: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  } else {
    const nextMode =
      triggerEnabled && !existingProvider.modeExplicit ? 'automation' : existingProvider.mode;
    if (nextMode !== existingProvider.mode) {
      repositories.providers.upsert({ ...existingProvider, mode: nextMode, updatedAtMs: nowMs });
    }
  }

  if (repositories.schedulePolicies.list(provider.id).length === 0) {
    repositories.schedulePolicies.upsert({
      id: `activation-${provider.id}`,
      providerId: provider.id,
      kind: triggerEnabled ? 'auto' : 'manual',
      kindExplicit: false,
      enabled: true,
      timezone,
      config: {},
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return;
  }

  const policyId = `activation-${provider.id}`;
  const existingPolicy = repositories.schedulePolicies.get(policyId);
  if (triggerEnabled && existingPolicy && !existingPolicy.kindExplicit) {
    const shouldUseAutomaticDefault =
      existingPolicy.kind === 'manual' &&
      existingPolicy.enabled &&
      isEmptyConfig(existingPolicy.config);
    const kind = shouldUseAutomaticDefault ? 'auto' : existingPolicy.kind;
    if (kind !== existingPolicy.kind) {
      repositories.schedulePolicies.upsert({ ...existingPolicy, kind, updatedAtMs: nowMs });
    }
  }
}

function isEmptyConfig(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
