import type {
  ActivationPolicy,
  CurrentWindowState,
  ProviderCapabilities,
} from '../domain/types.js';
import { resolveWindowTarget } from '../domain/window-target.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from '../scheduler/clock.js';
import { deriveCurrentWindowForTarget } from '../scheduler/current-window.js';
import { planWindowAction, upcomingSchedule, type PlannerDecision } from '../scheduler/planner.js';
import {
  activationPolicyId,
  activationPolicyScopes,
  windowKindBelongsToPolicyScope,
  type ActivationPolicyScope,
} from '../scheduler/policy-scope.js';
import { activationPolicyFromRecord, type TimezoneSetting } from '../scheduler/policy.js';
import { readTimezoneSetting } from './settings-api.js';
import type { StorageRepositories } from '../storage/repositories.js';
import { filterVisibleProviders } from '../providers/visibility.js';

export interface SchedulingApiInput {
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  clock: Clock;
  fakeProviderEnabled?: boolean;
}

export interface SchedulingProviderRead {
  providerId: string;
  policy: ActivationPolicy | null;
  currentWindow: CurrentWindowState;
  decision: PlannerDecision | null;
  upcoming: ReturnType<typeof upcomingSchedule>;
  policyScopes?: SchedulingPolicyScopeRead[];
}

export interface SchedulingPolicyScopeRead {
  scope: ActivationPolicyScope;
  policy: ActivationPolicy | null;
  requiresReview: boolean;
  currentWindow: CurrentWindowState;
  decision: PlannerDecision | null;
  upcoming: ReturnType<typeof upcomingSchedule>;
}

export interface SchedulingRead {
  timezone: TimezoneSetting | null;
  providers: SchedulingProviderRead[];
}

export function readScheduling(input: SchedulingApiInput): SchedulingRead {
  const timezone = readTimezoneSetting(input);
  const now = input.clock.now();
  return {
    timezone: timezone ?? null,
    providers: filterVisibleProviders(
      input.repositories.providers.list(),
      input.fakeProviderEnabled ?? true,
    ).map((provider) => {
      const state = input.repositories.providerState.get(provider.id);
      const records = input.repositories.schedulePolicies.list(provider.id);
      const scopeReads = activationPolicyScopes(provider.kind).map((scope) => {
        const policyRecord = records.find(
          (candidate) => candidate.id === activationPolicyId(provider.id, scope),
        );
        let policy = policyRecord
          ? safePolicy(policyRecord, timezone?.timezone ?? policyRecord.timezone)
          : null;
        let requiresReview =
          (policyRecord?.requiresReview ?? false) ||
          Boolean(policyRecord && !policy) ||
          Boolean(policyRecord && (policyRecord.scope ?? 'default') !== scope);
        if (
          provider.kind === 'antigravity' &&
          policy &&
          'windowKind' in policy &&
          policy.windowKind &&
          !windowKindBelongsToPolicyScope(policy.windowKind, scope)
        ) {
          policy = null;
          requiresReview = true;
        }
        const observation = state?.observation;
        const adapter = input.adapters.get(provider.id);
        const requestedWindowKind =
          policy && 'windowKind' in policy ? policy.windowKind : undefined;
        const targetResolution = resolveWindowTarget(
          requestedWindowKind,
          observation?.windows ?? [],
        );
        const windowKind =
          targetResolution.status === 'exact' || targetResolution.status === 'legacy_resolved'
            ? targetResolution.windowKind
            : undefined;
        const currentWindowKind =
          windowKind ?? (targetResolution.status === 'missing' ? requestedWindowKind : undefined);
        const resolvedPolicy = withResolvedWindowKind(policy, windowKind);
        const window = observation?.windows.find(
          (candidate) => candidate.windowKind === windowKind,
        );
        const currentWindow = deriveCurrentWindowForTarget(
          provider.id,
          observation,
          state?.health,
          currentWindowKind,
        );
        const decision =
          !requiresReview && resolvedPolicy && adapter && observation && state?.health === 'UP'
            ? safeDecision({
                now,
                providerId: provider.id,
                policy: resolvedPolicy,
                currentWindow,
                observation: {
                  observedAt: observation.observedAt,
                  staleAfterSeconds: observation.staleAfterSeconds,
                },
                capabilities: safeCapabilities(adapter),
                automationEnabled: provider.mode === 'automation',
                pendingIntents: input.repositories.actionIntents.listOpen(provider.id),
                ...(window ? { window } : {}),
              })
            : null;
        return {
          scope,
          policy: resolvedPolicy,
          requiresReview,
          currentWindow,
          decision,
          upcoming: resolvedPolicy
            ? upcomingSchedule(resolvedPolicy, now, window?.durationSeconds?.value)
            : [],
        } satisfies SchedulingPolicyScopeRead;
      });
      const selected = scopeReads[0]!;
      return {
        providerId: provider.id,
        policy: selected.policy,
        currentWindow: selected.currentWindow,
        decision: selected.decision,
        upcoming: selected.upcoming,
        ...(provider.kind === 'antigravity' ? { policyScopes: scopeReads } : {}),
      };
    }),
  };
}

function withResolvedWindowKind(
  policy: ActivationPolicy | null,
  windowKind: string | undefined,
): ActivationPolicy | null {
  if (!policy || !windowKind || !('windowKind' in policy)) return policy;
  return { ...policy, windowKind };
}

function safePolicy(
  record: Parameters<typeof activationPolicyFromRecord>[0],
  timezone: string,
): ActivationPolicy | null {
  try {
    return activationPolicyFromRecord(record, timezone) ?? null;
  } catch {
    return null;
  }
}

function safeDecision(input: Parameters<typeof planWindowAction>[0]): PlannerDecision | null {
  try {
    return planWindowAction(input);
  } catch {
    return null;
  }
}

function safeCapabilities(adapter: ProviderAdapter): Pick<ProviderCapabilities, 'windowTrigger'> {
  try {
    return { windowTrigger: adapter.capabilities().windowTrigger };
  } catch {
    return { windowTrigger: { supported: false, contract: 'unknown', consumesQuota: 'unknown' } };
  }
}
