import { describe, expect, it } from 'vitest';
import type { Confidence, WindowPhase, WindowSnapshot } from '../../src/domain/types.js';
import { findExhaustedAllowance } from '../../src/scheduler/allowance.js';

const now = new Date('2026-11-10T12:00:00.000Z');
const observedAt = '2026-11-10T11:59:50.000Z';
const future = '2026-11-10T15:00:00.000Z';
const past = '2026-11-10T11:00:00.000Z';

function window(
  providerId: string,
  windowKind: string,
  options: {
    phase?: WindowPhase;
    phaseConfidence?: Confidence;
    usage?: number;
    usageConfidence?: Confidence;
    resetAt?: string;
  } = {},
): WindowSnapshot {
  return {
    providerId,
    windowKind,
    observedAt,
    phase: {
      value: options.phase ?? 'UNKNOWN',
      source: 'inferred',
      confidence: options.phaseConfidence ?? 'high',
      observedAt,
    },
    ...(options.usage === undefined
      ? {}
      : {
          usageRatio: {
            value: options.usage,
            source: 'official_supported',
            confidence: options.usageConfidence ?? 'exact',
            observedAt,
          },
        }),
    ...(options.resetAt === undefined
      ? {}
      : {
          resetAt: {
            value: options.resetAt,
            source: 'official_supported',
            confidence: 'exact',
            observedAt,
          },
        }),
  };
}

function check(
  providerId: string,
  windowKind: string | undefined,
  windows: WindowSnapshot[],
  at: Date = now,
) {
  return findExhaustedAllowance({ now: at, providerId, windowKind, windows });
}

describe('findExhaustedAllowance', () => {
  it('reports nothing without a target window kind', () => {
    const exhausted = window('codex', 'codex_primary', { phase: 'EXHAUSTED', usage: 1 });
    expect(check('codex', undefined, [exhausted])).toBeUndefined();
  });

  it('blocks a Codex five-hour start when the shared weekly allowance is used up', () => {
    const fiveHour = window('codex', 'codex_primary', { usage: 0 });
    const weekly = window('codex', 'codex_secondary', {
      phase: 'EXHAUSTED',
      usage: 1,
      resetAt: future,
    });

    expect(check('codex', 'codex_primary', [fiveHour, weekly])).toEqual({
      windowKind: 'codex_secondary',
      resetAt: future,
    });
  });

  it('reports the target first when the target itself is exhausted', () => {
    const fiveHour = window('codex', 'codex_primary', {
      phase: 'EXHAUSTED',
      usage: 1,
      resetAt: future,
    });
    const weekly = window('codex', 'codex_secondary', { phase: 'EXHAUSTED', usage: 1 });

    expect(check('codex', 'codex_primary', [weekly, fiveHour])).toEqual({
      windowKind: 'codex_primary',
      resetAt: future,
    });
  });

  it('does not block when every window still has allowance', () => {
    const fiveHour = window('codex', 'codex_primary', { phase: 'ACTIVE', usage: 0.4 });
    const weekly = window('codex', 'codex_secondary', { phase: 'ACTIVE', usage: 0.99 });

    expect(check('codex', 'codex_primary', [fiveHour, weekly])).toBeUndefined();
  });

  it('treats a usage ratio of one as exhausted only when that ratio is actionable', () => {
    const exact = window('codex', 'codex_primary', { usage: 1, usageConfidence: 'exact' });
    const low = window('codex', 'codex_primary', { usage: 1, usageConfidence: 'low' });

    expect(check('codex', 'codex_primary', [exact])).toEqual({ windowKind: 'codex_primary' });
    expect(check('codex', 'codex_primary', [low])).toBeUndefined();
  });

  it('ignores an EXHAUSTED phase whose confidence is not actionable', () => {
    const uncertain = window('codex', 'codex_primary', {
      phase: 'EXHAUSTED',
      phaseConfidence: 'low',
    });
    expect(check('codex', 'codex_primary', [uncertain])).toBeUndefined();
  });

  it('does not treat a reset that has already passed as exhausted', () => {
    const passed = window('codex', 'codex_primary', {
      phase: 'EXHAUSTED',
      usage: 1,
      resetAt: past,
    });
    expect(check('codex', 'codex_primary', [passed])).toBeUndefined();
  });

  it('keeps an exhausted allowance without a reset timestamp as exhausted', () => {
    const noReset = window('codex', 'codex_primary', { phase: 'EXHAUSTED', usage: 1 });
    expect(check('codex', 'codex_primary', [noReset])).toEqual({ windowKind: 'codex_primary' });
  });

  describe('Antigravity model families', () => {
    it('blocks a family start when the family other window is exhausted', () => {
      const fiveHour = window('antigravity', 'antigravity_gemini_five_hour', { usage: 0 });
      const weekly = window('antigravity', 'antigravity_gemini_weekly', {
        phase: 'EXHAUSTED',
        usage: 1,
        resetAt: future,
      });

      expect(
        check('antigravity', 'antigravity_gemini_five_hour', [fiveHour, weekly]),
      ).toMatchObject({ windowKind: 'antigravity_gemini_weekly' });
    });

    it('keeps the Gemini and Claude/GPT families independent', () => {
      const gemini = window('antigravity', 'antigravity_gemini_weekly', {
        phase: 'EXHAUSTED',
        usage: 1,
        resetAt: future,
      });
      const claudeGpt = window('antigravity', 'antigravity_claude_gpt_five_hour', {
        phase: 'ACTIVE',
        usage: 0.2,
      });

      expect(
        check('antigravity', 'antigravity_claude_gpt_five_hour', [gemini, claudeGpt]),
      ).toBeUndefined();
    });

    it('lets Argon, which has only a weekly allowance, stand alone', () => {
      const gemini = window('antigravity', 'antigravity_gemini_weekly', {
        phase: 'EXHAUSTED',
        usage: 1,
        resetAt: future,
      });
      const argon = window('antigravity', 'antigravity_argon_weekly', {
        phase: 'ACTIVE',
        usage: 0.3,
      });

      expect(check('antigravity', 'antigravity_argon_weekly', [gemini, argon])).toBeUndefined();
    });

    it('blocks an Argon start when its own weekly allowance is used up', () => {
      const argon = window('antigravity', 'antigravity_argon_weekly', {
        phase: 'EXHAUSTED',
        usage: 1,
        resetAt: future,
      });

      expect(check('antigravity', 'antigravity_argon_weekly', [argon])).toEqual({
        windowKind: 'antigravity_argon_weekly',
        resetAt: future,
      });
    });

    it('checks only the target when an Antigravity window is outside every known family', () => {
      const unknown = window('antigravity', 'antigravity_future_family_weekly', {
        phase: 'EXHAUSTED',
        usage: 1,
      });
      const other = window('antigravity', 'antigravity_gemini_weekly', {
        phase: 'EXHAUSTED',
        usage: 1,
      });

      expect(check('antigravity', 'antigravity_future_family_weekly', [unknown, other])).toEqual({
        windowKind: 'antigravity_future_family_weekly',
      });
    });
  });

  describe('Claude Code canonical allowances', () => {
    it('blocks a session start when the weekly allowance is used up', () => {
      const session = window('claude_code', 'claude_code_five_hour', { usage: 0 });
      const weekly = window('claude_code', 'claude_code_seven_day', {
        phase: 'EXHAUSTED',
        usage: 1,
        resetAt: future,
      });

      expect(check('claude_code', 'claude_code_five_hour', [session, weekly])).toEqual({
        windowKind: 'claude_code_seven_day',
        resetAt: future,
      });
    });

    it('does not let a model-scoped meter block a default session start', () => {
      const session = window('claude_code', 'claude_code_five_hour', { usage: 0.1 });
      const modelScoped = window('claude_code', 'claude_code_weekly_opus', {
        phase: 'EXHAUSTED',
        usage: 1,
        resetAt: future,
      });

      expect(check('claude_code', 'claude_code_five_hour', [session, modelScoped])).toBeUndefined();
    });

    it('checks only the target when a model-scoped meter is the target', () => {
      const session = window('claude_code', 'claude_code_five_hour', {
        phase: 'EXHAUSTED',
        usage: 1,
        resetAt: future,
      });
      const modelScoped = window('claude_code', 'claude_code_weekly_opus', { usage: 0.2 });

      expect(
        check('claude_code', 'claude_code_weekly_opus', [session, modelScoped]),
      ).toBeUndefined();
    });
  });

  it('fails closed for providers without a documented sharing model', () => {
    const target = window('fake', 'five_hour', { usage: 0 });
    const other = window('fake', 'weekly', { phase: 'EXHAUSTED', usage: 1 });

    expect(check('fake', 'five_hour', [target, other])).toEqual({ windowKind: 'weekly' });
  });
});
