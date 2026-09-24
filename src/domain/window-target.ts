export type WindowCadence = 'five_hour' | 'weekly' | 'other';

export interface WindowTargetLike {
  windowKind: string;
  durationSeconds?: number | { value: number } | undefined;
}

export type WindowTargetResolution =
  | { status: 'exact' | 'legacy_resolved'; requested: string; windowKind: string }
  | { status: 'ambiguous'; requested: string; candidates: string[] }
  | { status: 'missing'; requested?: string };

/** Duration is authoritative; machine-key suffixes are only compatibility evidence. */
export function classifyWindowCadence(window: WindowTargetLike): WindowCadence {
  const duration =
    typeof window.durationSeconds === 'number'
      ? window.durationSeconds
      : window.durationSeconds?.value;
  if (duration === 18_000) return 'five_hour';
  if (duration === 604_800) return 'weekly';

  const kind = window.windowKind.toLowerCase();
  if (kind === 'five_hour' || /_(five_hour|primary)$/.test(kind)) return 'five_hour';
  if (kind === 'weekly' || kind === 'seven_day' || /_(weekly|seven_day|secondary)$/.test(kind)) {
    return 'weekly';
  }
  return 'other';
}

/** Resolve only historical generic cadence aliases; exact targets are never guessed. */
export function resolveWindowTarget(
  requested: string | undefined,
  windows: readonly WindowTargetLike[],
): WindowTargetResolution {
  if (!requested) return { status: 'missing' };
  if (windows.some((window) => window.windowKind === requested)) {
    return { status: 'exact', requested, windowKind: requested };
  }
  if (requested !== 'five_hour' && requested !== 'weekly') {
    return { status: 'missing', requested };
  }

  const candidates = windows
    .filter((window) => classifyWindowCadence(window) === requested)
    .map((window) => window.windowKind);
  if (candidates.length === 1) {
    return { status: 'legacy_resolved', requested, windowKind: candidates[0]! };
  }
  if (candidates.length > 1) return { status: 'ambiguous', requested, candidates };
  return { status: 'missing', requested };
}
