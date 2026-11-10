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

export function findExhaustedAllowance(
  input: FindExhaustedAllowanceInput,
): ExhaustedAllowance | undefined {
  const targetWindowKind = input.windowKind;
  if (!targetWindowKind) return undefined;
  const nowMs = input.now.getTime();
  const sharing = input.windows
    .filter((window) => consumesSameAllowance(input.providerId, targetWindowKind, window))
    .sort((left, right) => rank(left, targetWindowKind) - rank(right, targetWindowKind));

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
  candidate: WindowSnapshot,
): boolean {
  if (candidate.windowKind === targetWindowKind) return true;
  if (providerId === 'antigravity') {
    const scope = policyScopeForWindowKind(targetWindowKind);
    return scope !== undefined && policyScopeForWindowKind(candidate.windowKind) === scope;
  }
  if (providerId === 'claude_code') {
    return (
      CLAUDE_CODE_CANONICAL_WINDOW_KINDS.has(targetWindowKind) &&
      CLAUDE_CODE_CANONICAL_WINDOW_KINDS.has(candidate.windowKind)
    );
  }
  return true;
}

function rank(window: WindowSnapshot, targetWindowKind: string): number {
  return window.windowKind === targetWindowKind ? 0 : 1;
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
