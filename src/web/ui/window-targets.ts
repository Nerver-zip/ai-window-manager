import type { WindowSnapshot } from '../../domain/types.js';
import {
  classifyWindowCadence,
  resolveWindowTarget as resolveDomainWindowTarget,
  type WindowCadence,
} from '../../domain/window-target.js';
import { windowDisplayName, windowGroupDisplayName } from './presentation.js';

export interface WindowTargetDescriptor {
  windowKind: string;
  durationSeconds?: number;
  cadence: WindowCadence;
  label: string;
  groupLabel: string | null;
}

export type WindowTargetResolution =
  | { status: 'none' }
  | { status: 'resolved'; target: WindowTargetDescriptor; source: 'exact' | 'legacy' }
  | {
      status: 'ambiguous';
      legacyCadence: Exclude<WindowCadence, 'other'>;
      matches: readonly WindowTargetDescriptor[];
    }
  | {
      status: 'unresolved';
      configuredWindowKind: string;
    };

export function observedWindowTargets(
  providerId: string,
  windows: readonly WindowSnapshot[] | undefined,
): WindowTargetDescriptor[] {
  const seen = new Set<string>();
  const targets: WindowTargetDescriptor[] = [];

  for (const window of windows ?? []) {
    const windowKind = window.windowKind.trim();
    if (!windowKind || seen.has(windowKind)) continue;
    seen.add(windowKind);

    const durationSeconds = window.durationSeconds?.value;
    targets.push({
      windowKind,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      cadence: classifyWindowCadence({ windowKind, durationSeconds }),
      label: windowDisplayName(providerId, windowKind, durationSeconds),
      groupLabel: windowGroupDisplayName(windowKind),
    });
  }

  return targets;
}

export function resolveWindowTarget(
  configuredWindowKind: string | undefined,
  targets: readonly WindowTargetDescriptor[],
): WindowTargetResolution {
  const resolution = resolveDomainWindowTarget(configuredWindowKind, targets);
  switch (resolution.status) {
    case 'exact':
    case 'legacy_resolved': {
      const target = targets.find((entry) => entry.windowKind === resolution.windowKind);
      return target
        ? {
            status: 'resolved',
            target,
            source: resolution.status === 'exact' ? 'exact' : 'legacy',
          }
        : configuredWindowKind
          ? { status: 'unresolved', configuredWindowKind }
          : { status: 'none' };
    }
    case 'ambiguous': {
      return {
        status: 'ambiguous',
        legacyCadence: resolution.requested === 'weekly' ? 'weekly' : 'five_hour',
        matches: resolution.candidates.flatMap((candidate) => {
          const target = targets.find((entry) => entry.windowKind === candidate);
          return target ? [target] : [];
        }),
      };
    }
    case 'missing':
      return resolution.requested
        ? { status: 'unresolved', configuredWindowKind: resolution.requested }
        : { status: 'none' };
  }
}
