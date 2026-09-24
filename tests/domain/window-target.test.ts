import { describe, expect, it } from 'vitest';
import {
  classifyWindowCadence,
  resolveWindowTarget,
  type WindowTargetLike,
} from '../../src/domain/window-target.js';

describe('normalized usage-window target semantics', () => {
  it.each([
    [{ windowKind: 'codex_codex_primary', durationSeconds: 604_800 }, 'weekly'],
    [{ windowKind: 'codex_codex_secondary', durationSeconds: 18_000 }, 'five_hour'],
    [{ windowKind: 'antigravity_gemini_five_hour' }, 'five_hour'],
    [{ windowKind: 'antigravity_claude_gpt_weekly' }, 'weekly'],
    [{ windowKind: 'codex_custom' }, 'other'],
  ] as const)('classifies %o as %s', (target, expected) => {
    expect(classifyWindowCadence(target)).toBe(expected);
  });

  it('resolves an old generic cadence only when exactly one observed target matches', () => {
    const windows: WindowTargetLike[] = [
      { windowKind: 'codex_codex_primary', durationSeconds: 18_000 },
      { windowKind: 'codex_codex_secondary', durationSeconds: 604_800 },
    ];

    expect(resolveWindowTarget('five_hour', windows)).toEqual({
      status: 'legacy_resolved',
      requested: 'five_hour',
      windowKind: 'codex_codex_primary',
    });
    expect(resolveWindowTarget('weekly', windows)).toEqual({
      status: 'legacy_resolved',
      requested: 'weekly',
      windowKind: 'codex_codex_secondary',
    });
  });

  it('preserves exact targets and reports ambiguous legacy group choices', () => {
    const windows: WindowTargetLike[] = [
      { windowKind: 'antigravity_gemini_five_hour', durationSeconds: 18_000 },
      { windowKind: 'antigravity_claude_gpt_five_hour', durationSeconds: 18_000 },
    ];

    expect(resolveWindowTarget('antigravity_claude_gpt_five_hour', windows)).toEqual({
      status: 'exact',
      requested: 'antigravity_claude_gpt_five_hour',
      windowKind: 'antigravity_claude_gpt_five_hour',
    });
    expect(resolveWindowTarget('five_hour', windows)).toEqual({
      status: 'ambiguous',
      requested: 'five_hour',
      candidates: ['antigravity_gemini_five_hour', 'antigravity_claude_gpt_five_hour'],
    });
  });

  it('does not guess for absent, stale-key, or unsupported targets', () => {
    const windows = [{ windowKind: 'codex_codex_primary', durationSeconds: 18_000 }];

    expect(resolveWindowTarget(undefined, windows)).toEqual({ status: 'missing' });
    expect(resolveWindowTarget('codex_codex_secondary', windows)).toEqual({
      status: 'missing',
      requested: 'codex_codex_secondary',
    });
    expect(resolveWindowTarget('monthly', windows)).toEqual({
      status: 'missing',
      requested: 'monthly',
    });
  });
});
