import { describe, expect, it } from 'vitest';
import type { WindowSnapshot } from '../../src/domain/types.js';
import { observedWindowTargets, resolveWindowTarget } from '../../src/web/ui/window-targets.js';

function windowSnapshot(windowKind: string, durationSeconds?: number): WindowSnapshot {
  const observedAt = '2026-09-24T12:00:00.000Z';
  return {
    providerId: 'codex',
    windowKind,
    observedAt,
    phase: { value: 'INACTIVE', source: 'observed', confidence: 'exact', observedAt },
    ...(durationSeconds !== undefined
      ? {
          durationSeconds: {
            value: durationSeconds,
            source: 'observed' as const,
            confidence: 'exact' as const,
            observedAt,
          },
        }
      : {}),
  };
}

describe('observed Schedule window targets', () => {
  it('treats missing observations and missing durations as unknown instead of inventing targets', () => {
    expect(observedWindowTargets('codex', undefined)).toEqual([]);

    const [target] = observedWindowTargets('codex', [windowSnapshot('codex_custom')]);
    expect(target).toMatchObject({
      windowKind: 'codex_custom',
      cadence: 'other',
      groupLabel: null,
    });
    expect(target).not.toHaveProperty('durationSeconds');
  });

  it('uses only distinct, non-empty provider-reported target keys', () => {
    const targets = observedWindowTargets('codex', [
      windowSnapshot('codex_primary', 18_000),
      windowSnapshot('codex_secondary', 604_800),
      windowSnapshot('codex_primary', 18_000),
      windowSnapshot('   ', 18_000),
    ]);

    expect(targets.map((target) => target.windowKind)).toEqual([
      'codex_primary',
      'codex_secondary',
    ]);
    expect(targets.map((target) => target.label)).toEqual(['5-hour window', 'Weekly window']);
  });

  it('maps a legacy cadence to an exact target only when the match is unique', () => {
    const targets = observedWindowTargets('codex', [
      windowSnapshot('codex_primary', 18_000),
      windowSnapshot('codex_secondary', 604_800),
    ]);

    expect(resolveWindowTarget('five_hour', targets)).toMatchObject({
      status: 'resolved',
      source: 'legacy',
      target: { windowKind: 'codex_primary' },
    });
  });

  it('keeps ambiguous legacy choices unresolved and preserves every exact target', () => {
    const targets = observedWindowTargets('codex', [
      windowSnapshot('codex_primary', 18_000),
      windowSnapshot('codex_additional', 18_000),
    ]);

    expect(resolveWindowTarget('five_hour', targets)).toMatchObject({
      status: 'ambiguous',
      matches: [{ windowKind: 'codex_primary' }, { windowKind: 'codex_additional' }],
    });
  });

  it('labels ambiguous weekly legacy choices with their matching cadence', () => {
    const targets = observedWindowTargets('codex', [
      windowSnapshot('codex_weekly', 604_800),
      windowSnapshot('codex_extra_weekly', 604_800),
    ]);

    expect(resolveWindowTarget('weekly', targets)).toMatchObject({
      status: 'ambiguous',
      legacyCadence: 'weekly',
      matches: [{ windowKind: 'codex_weekly' }, { windowKind: 'codex_extra_weekly' }],
    });
  });

  it('never invents a target when an old key no longer matches an observation', () => {
    const targets = observedWindowTargets('codex', [windowSnapshot('codex_secondary', 604_800)]);

    expect(resolveWindowTarget('five_hour', targets)).toEqual({
      status: 'unresolved',
      configuredWindowKind: 'five_hour',
    });
    expect(resolveWindowTarget(undefined, targets)).toEqual({ status: 'none' });
  });

  it('prefers an exact target key before considering its value as a legacy alias', () => {
    const targets = observedWindowTargets('fake', [windowSnapshot('five_hour', 18_000)]);

    expect(resolveWindowTarget('five_hour', targets)).toMatchObject({
      status: 'resolved',
      source: 'exact',
      target: { windowKind: 'five_hour' },
    });
  });
});
