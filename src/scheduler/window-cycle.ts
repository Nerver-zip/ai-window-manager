import type { ProviderObservation, WindowSnapshot } from '../domain/types.js';
import type { ObservedWindowCycle } from '../storage/window-cycles.js';
import type { StorageRepositories } from '../storage/repositories.js';

const JITTER_MS = 5_000;
const MIN_EVIDENCE_SPAN_MS = 15_000;
const actionable = (confidence: string) => confidence === 'exact' || confidence === 'high';

/** Pure lifecycle inference. Moving projections are evidence, never cycle identities. */
export function observeWindowCycle(window: WindowSnapshot, previous?: ObservedWindowCycle) {
  const at = Date.parse(window.observedAt);
  const reset =
    window.resetAt && actionable(window.resetAt.confidence)
      ? Date.parse(window.resetAt.value)
      : null;
  const duration =
    window.durationSeconds && actionable(window.durationSeconds.confidence)
      ? window.durationSeconds.value * 1000
      : undefined;
  const zero = window.usageRatio?.value === 0;
  const temporal =
    zero &&
    window.phase.source === 'inferred' &&
    window.phase.value !== 'EXHAUSTED' &&
    (window.phase.value === 'UNKNOWN' || (reset !== null && duration !== undefined));
  // Repeated/out-of-order reads cannot manufacture elapsed evidence or roll state back.
  if (
    previous &&
    (at < previous.lastObservedAtMs || (at === previous.lastObservedAtMs && temporal))
  ) {
    const value =
      at === previous.lastObservedAtMs &&
      reset !== null &&
      reset === previous.lastResetAtMs &&
      duration !== undefined &&
      window.usageRatio &&
      actionable(window.usageRatio.confidence)
        ? previous.phase
        : 'UNKNOWN';
    return {
      window: {
        ...window,
        phase: {
          value,
          source: 'inferred' as const,
          confidence: value === 'UNKNOWN' ? ('unknown' as const) : previous.phaseConfidence,
          observedAt: window.observedAt,
        },
      },
      cycle: previous,
    };
  }

  let phase = window.phase;
  const oldAnchor = previous?.anchoredResetAtMs ?? null;
  if (temporal) {
    let value: WindowSnapshot['phase']['value'] = 'UNKNOWN';
    if (!window.usageRatio || !actionable(window.usageRatio.confidence)) {
      value = 'UNKNOWN';
    } else if (reset !== null && oldAnchor !== null && oldAnchor > at) {
      if (Math.abs(reset - oldAnchor) <= JITTER_MS) value = 'ACTIVE';
    } else if (reset !== null && duration !== undefined && previous?.lastResetAtMs != null) {
      const elapsed = at - previous.lastObservedAtMs;
      const movement = reset - previous.lastResetAtMs;
      if (elapsed >= MIN_EVIDENCE_SPAN_MS && reset > at) {
        if (
          Math.abs(reset - at - duration) <= JITTER_MS &&
          Math.abs(movement - elapsed) <= JITTER_MS
        )
          value = 'INACTIVE';
        else if (Math.abs(movement) <= JITTER_MS && reset - at < duration - JITTER_MS)
          value = 'ACTIVE';
      }
    }
    phase = {
      value,
      source: 'inferred',
      confidence: value === 'UNKNOWN' ? 'unknown' : 'high',
      observedAt: window.observedAt,
    };
    // Keep the evidence baseline across short executor ticks until enough
    // elapsed time exists to distinguish a rolling projection from an anchor.
    if (value === 'UNKNOWN' && previous && at - previous.lastObservedAtMs < MIN_EVIDENCE_SPAN_MS)
      return { window: { ...window, phase }, cycle: previous };
  }

  const known = actionable(phase.confidence);
  const inactiveTransition =
    previous &&
    known &&
    phase.value === 'INACTIVE' &&
    actionable(previous.phaseConfidence) &&
    ['ACTIVE', 'EXHAUSTED', 'RESET_DUE'].includes(previous.phase) &&
    (oldAnchor === null || oldAnchor <= at);
  const cycleAtMs =
    previous &&
    oldAnchor !== null &&
    oldAnchor <= at &&
    known &&
    ['INACTIVE', 'ACTIVE', 'EXHAUSTED'].includes(phase.value)
      ? Math.max(previous.cycleAtMs, oldAnchor)
      : inactiveTransition
        ? at
        : (previous?.cycleAtMs ?? at);
  const anchor =
    known && ['ACTIVE', 'EXHAUSTED'].includes(phase.value) && reset !== null && reset > at
      ? oldAnchor !== null && oldAnchor > at && Math.abs(reset - oldAnchor) <= JITTER_MS
        ? oldAnchor
        : reset
      : oldAnchor;
  return {
    window: { ...window, phase },
    cycle: {
      providerId: window.providerId,
      windowKind: window.windowKind,
      cycleAtMs,
      anchoredResetAtMs: anchor,
      lastObservedAtMs: at,
      lastResetAtMs: reset,
      phase: phase.value,
      phaseConfidence: phase.confidence,
    } satisfies ObservedWindowCycle,
  };
}

/** Called inside the owning observation transaction, also for executor preflight reads. */
export function trackWindowCycles(
  observation: ProviderObservation,
  repositories: StorageRepositories,
): ProviderObservation {
  return {
    ...observation,
    windows: observation.windows.map((window) => {
      const previous = repositories.windowCycles.get(window.providerId, window.windowKind);
      const result = observeWindowCycle(window, previous);
      repositories.windowCycles.upsert(result.cycle);
      return result.window;
    }),
  };
}
