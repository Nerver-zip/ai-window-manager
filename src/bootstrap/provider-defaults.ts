import type { StorageRepositories } from '../storage/repositories.js';
import { activationPolicyId, activationPolicyScopes } from '../scheduler/policy-scope.js';

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

  const savedPolicies = repositories.schedulePolicies.list(provider.id);
  const scopes = activationPolicyScopes(provider.kind);
  const hasLegacySchedule = savedPolicies.some(
    (policy) =>
      policy.scope === 'legacy' || policy.kind === 'target_reset' || policy.kind === 'work_window',
  );
  const hasAnyScopedPolicy = savedPolicies.some((policy) =>
    scopes.some(
      (scope) => policy.scope === scope || (policy.scope === undefined && scope === 'default'),
    ),
  );
  if (!hasAnyScopedPolicy && hasLegacySchedule) return;

  for (const scope of scopes) {
    const policyId = activationPolicyId(provider.id, scope);
    const existingPolicy = repositories.schedulePolicies.get(policyId);
    if (!existingPolicy) {
      repositories.schedulePolicies.upsert({
        id: policyId,
        providerId: provider.id,
        scope,
        requiresReview: false,
        kind: triggerEnabled ? 'auto' : 'manual',
        kindExplicit: false,
        enabled: true,
        timezone,
        config: {},
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      continue;
    }

    if (triggerEnabled && !existingPolicy.kindExplicit && !existingPolicy.requiresReview) {
      const shouldUseAutomaticDefault =
        existingPolicy.kind === 'manual' &&
        existingPolicy.enabled &&
        isEmptyConfig(existingPolicy.config);
      if (shouldUseAutomaticDefault) {
        repositories.schedulePolicies.upsert({
          ...existingPolicy,
          kind: 'auto',
          updatedAtMs: nowMs,
        });
      }
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
