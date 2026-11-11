import type { Confidence, WindowSnapshot } from '../domain/types.js';
import { policyScopeForWindowKind } from './policy-scope.js';

/**
 * Pure allowance gate: a window start is pointless (and must not be dispatched)
 * when the target window, or another reported window that the same start also
 * consumes, is already exhausted with a reset that has not yet passed.
 *
 * Consumption scope (explicit, conservative):
 * - Antigravity: only windows of the same model family (Gemini, Claude/GPT or
 *   Argon's weekly-only allowance). The provider may account a start against the
 *   family's other window, so both of its windows are checked.
 * - Claude Code: a start is documented to count against both the five-hour and
 *   the weekly allowance. Per-model meters are not consulted, so a model-scoped
 *   limit does not block a default-model start.
 * - Codex and any other provider: every reported window of that provider. The
 *   consumption model is not documented, so this fails closed.
 */

const CLAUDE_CODE_CANONICAL_WINDOW_KINDS: ReadonlySet<string> = new Set([
  'claude_code_five_hour',
  'claude_code_seven_day',
]);

const ACTIONABLE_CONFIDENCE: ReadonlySet<Confidence> = new Set<Confidence>(['exact', 'high']);

export interface ExhaustedAllowance {
  /** The exhausted window; the target itself is reported first when it is exhausted. */
  windowKind: string;
  resetAt?: string;
}

export interface FindExhaustedAllowanceInput {
  now: Date;
  providerId: string;
  windowKind: string | undefined;
  windows: readonly WindowSnapshot[];
}

export interface AllowanceCycleIdentity {
  cycleAtMs: number;
  lastObservedAtMs: number;
}

/** Window identities whose allowance is consumed by a start for this target. */
export function consumedAllowanceWindowKinds(
  providerId: string,
  targetWindowKind: string | undefined,
  windows: readonly WindowSnapshot[],
  previouslyObservedWindowKinds: readonly string[] = [],
): string[] {
  if (!targetWindowKind) return [];
  return [
    ...new Set([...windows.map((window) => window.windowKind), ...previouslyObservedWindowKinds]),
  ]
    .filter((windowKind) => consumesSameAllowance(providerId, targetWindowKind, windowKind))
    .sort((left, right) => {
      if (left === targetWindowKind) return right === targetWindowKind ? 0 : -1;
      if (right === targetWindowKind) return 1;
      return left.localeCompare(right);
    });
}

/**
 * Stable auto-opportunity identity from the target and every allowance a start
 * consumes. A lifecycle row cannot be newer than its normalized window sample;
 * the tracker may intentionally retain an older baseline across short ticks.
 */
export function buildAvailabilityGeneration(input: {
  providerId: string;
  windowKind: string | undefined;
  windows: readonly WindowSnapshot[];
  cycles: ReadonlyMap<string, AllowanceCycleIdentity>;
}): string | undefined {
  const kinds = consumedAllowanceWindowKinds(input.providerId, input.windowKind, input.windows, [
    ...input.cycles.keys(),
  ]);
  if (kinds.length === 0) return undefined;
  const identities: Array<{ windowKind: string; cycleAtMs: number }> = [];
  for (const windowKind of kinds) {
    const window = input.windows.find((candidate) => candidate.windowKind === windowKind);
    const cycle = input.cycles.get(windowKind);
    const observedAtMs = window ? Date.parse(window.observedAt) : NaN;
    if (
      !window ||
      window.providerId !== input.providerId ||
      !Number.isSafeInteger(observedAtMs) ||
      !cycle ||
      !Number.isSafeInteger(cycle.cycleAtMs) ||
      !Number.isSafeInteger(cycle.lastObservedAtMs) ||
      cycle.lastObservedAtMs > observedAtMs
    )
      return undefined;
    identities.push({ windowKind, cycleAtMs: cycle.cycleAtMs });
  }
  return JSON.stringify(identities);
}

export function findExhaustedAllowance(
  input: FindExhaustedAllowanceInput,
): ExhaustedAllowance | undefined {
  const targetWindowKind = input.windowKind;
  if (!targetWindowKind) return undefined;
  const nowMs = input.now.getTime();
  const sharing = consumedAllowanceWindowKinds(input.providerId, targetWindowKind, input.windows)
    .map((windowKind) => input.windows.find((window) => window.windowKind === windowKind))
    .filter((window): window is WindowSnapshot => window !== undefined);

  for (const window of sharing) {
    if (!isExhausted(window, nowMs)) continue;
    const resetAt = window.resetAt?.value;
    return resetAt === undefined
      ? { windowKind: window.windowKind }
      : { windowKind: window.windowKind, resetAt };
  }
  return undefined;
}

function consumesSameAllowance(
  providerId: string,
  targetWindowKind: string,
  candidateWindowKind: string,
): boolean {
  if (candidateWindowKind === targetWindowKind) return true;
  if (providerId === 'antigravity') {
    const scope = policyScopeForWindowKind(targetWindowKind);
    return scope !== undefined && policyScopeForWindowKind(candidateWindowKind) === scope;
  }
  if (providerId === 'claude_code') {
    return (
      CLAUDE_CODE_CANONICAL_WINDOW_KINDS.has(targetWindowKind) &&
      CLAUDE_CODE_CANONICAL_WINDOW_KINDS.has(candidateWindowKind)
    );
  }
  return true;
}

function isExhausted(window: WindowSnapshot, nowMs: number): boolean {
  // A reset that has already passed means the allowance is no longer exhausted,
  // whatever an older snapshot recorded. The executor's fresh read is authoritative.
  if (window.resetAt) {
    const resetMs = Date.parse(window.resetAt.value);
    if (Number.isFinite(resetMs) && resetMs <= nowMs) return false;
  }
  if (window.phase.value === 'EXHAUSTED' && ACTIONABLE_CONFIDENCE.has(window.phase.confidence)) {
    return true;
  }
  return (
    window.usageRatio !== undefined &&
    ACTIONABLE_CONFIDENCE.has(window.usageRatio.confidence) &&
    window.usageRatio.value >= 1
  );
}
