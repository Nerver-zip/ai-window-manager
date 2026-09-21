import type {
  ActivationPolicy,
  CurrentWindowState,
  ProviderCapabilities,
  WindowSnapshot,
} from '../domain/types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from '../scheduler/clock.js';
import { deriveCurrentWindow } from '../scheduler/current-window.js';
import { planWindowAction, upcomingSchedule, type PlannerDecision } from '../scheduler/planner.js';
import { activationPolicyFromRecord, type TimezoneSetting } from '../scheduler/policy.js';
import { readTimezoneSetting } from './settings-api.js';
import type { StorageRepositories } from '../storage/repositories.js';

export interface SchedulingApiInput {
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  clock: Clock;
}

export interface SchedulingProviderRead {
  providerId: string;
  policy: ActivationPolicy | null;
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
    providers: input.repositories.providers.list().map((provider) => {
      const state = input.repositories.providerState.get(provider.id);
      const policyRecord =
        input.repositories.schedulePolicies
          .list(provider.id)
          .find((candidate) => candidate.id === `activation-${provider.id}`) ??
        input.repositories.schedulePolicies.list(provider.id)[0];
      const policy = policyRecord
        ? safePolicy(policyRecord, timezone?.timezone ?? policyRecord.timezone)
        : null;
      const observation = state?.observation;
      const currentWindow = deriveCurrentWindow(provider.id, observation, state?.health);
      const adapter = input.adapters.get(provider.id);
      const windowKind = policy && 'windowKind' in policy ? policy.windowKind : undefined;
      const window = observation ? selectWindow(observation.windows, windowKind) : undefined;
      const decision =
        policy && adapter && observation && state?.health === 'UP'
          ? safeDecision({
              now,
              providerId: provider.id,
              policy,
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
        providerId: provider.id,
        policy,
        currentWindow,
        decision,
        upcoming: policy ? upcomingSchedule(policy, now, window?.durationSeconds?.value) : [],
      };
    }),
  };
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

function selectWindow(
  windows: readonly WindowSnapshot[],
  windowKind: string | undefined,
): WindowSnapshot | undefined {
  return (
    (windowKind ? windows.find((window) => window.windowKind === windowKind) : undefined) ??
    windows[0]
  );
}
