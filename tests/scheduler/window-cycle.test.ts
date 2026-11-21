import { describe, expect, it } from 'vitest';
import type { WindowSnapshot } from '../../src/domain/types.js';
import { observeWindowCycle } from '../../src/scheduler/window-cycle.js';

const origin = Date.parse('2026-09-30T04:28:00Z');
function sample(seconds: number, resetSeconds = seconds + 18_000, usage = 0): WindowSnapshot {
  const observedAt = new Date(origin + seconds * 1000).toISOString();
  return {
    providerId: 'codex',
    windowKind: 'codex_codex_primary',
    observedAt,
    phase: {
      value: usage === 0 ? 'UNKNOWN' : 'ACTIVE',
      source: 'inferred',
      confidence: usage === 0 ? 'unknown' : 'high',
      observedAt,
    },
    resetAt: {
      value: new Date(origin + resetSeconds * 1000).toISOString(),
      source: 'official_supported',
      confidence: 'exact',
      observedAt,
    },
    durationSeconds: {
      value: 18_000,
      source: 'official_supported',
      confidence: 'exact',
      observedAt,
    },
    usageRatio: { value: usage, source: 'official_supported', confidence: 'exact', observedAt },
  };
}

describe('observed quota cycle', () => {
  it('does not make a low-confidence zero actionable', () => {
    const first = observeWindowCycle(sample(0));
    const window = sample(30);
    window.usageRatio!.confidence = 'low';
    expect(observeWindowCycle(window, first.cycle).window.phase.value).toBe('UNKNOWN');
    const available = observeWindowCycle(sample(30), first.cycle);
    expect(observeWindowCycle(window, available.cycle).window.phase.value).toBe('UNKNOWN');
  });
  it('keeps one identity across a moving reset, an anchored zero and the next real expiry', () => {
    const first = observeWindowCycle(sample(0));
    expect(first.window.phase.value).toBe('UNKNOWN');
    const rolling = observeWindowCycle(sample(30), first.cycle);
    expect(rolling.window.phase).toMatchObject({ value: 'INACTIVE', confidence: 'high' });
    expect(rolling.cycle.cycleAtMs).toBe(origin);
    const moreRolling = observeWindowCycle(sample(60), rolling.cycle);
    expect(moreRolling.cycle.cycleAtMs).toBe(origin);
    const anchored = observeWindowCycle(sample(90, 18_060), moreRolling.cycle);
    expect(anchored.window.phase.value).toBe('ACTIVE');
    const zero = observeWindowCycle(sample(5_520, 18_061), anchored.cycle);
    expect(zero.window.phase.value).toBe('ACTIVE');
    expect(zero.cycle.anchoredResetAtMs).toBe(origin + 18_060_000);
    const afterReset = observeWindowCycle(sample(18_090), zero.cycle);
    expect(afterReset.window.phase.value).toBe('UNKNOWN');
    const available = observeWindowCycle(sample(18_120), afterReset.cycle);
    expect(available.window.phase.value).toBe('INACTIVE');
    expect(available.cycle.cycleAtMs).toBe(origin + 18_060_000);
    expect(observeWindowCycle(sample(18_150), available.cycle).cycle.cycleAtMs).toBe(
      available.cycle.cycleAtMs,
    );
  });

  it('accumulates evidence across short executor ticks rather than resetting its baseline', () => {
    const first = observeWindowCycle(sample(0));
    for (const seconds of [5, 10]) {
      const result = observeWindowCycle(sample(seconds), first.cycle);
      expect(result.window.phase.value).toBe('UNKNOWN');
      expect(result.cycle).toEqual(first.cycle);
    }
    expect(observeWindowCycle(sample(15), first.cycle).window.phase.value).toBe('INACTIVE');
  });

  it('does not overwrite evidence with duplicate, out-of-order or changed same-instant snapshots', () => {
    const initial = observeWindowCycle(sample(0));
    const previous = observeWindowCycle(sample(30), initial.cycle);
    expect(observeWindowCycle(sample(30), previous.cycle).window.phase.value).toBe('INACTIVE');
    for (const window of [sample(0), sample(30, 18_031)]) {
      const result = observeWindowCycle(window, previous.cycle);
      expect(result.window.phase.value).toBe('UNKNOWN');
      expect(result.cycle).toEqual(previous.cycle);
    }
  });

  it.each([
    'missing reset',
    'low reset',
    'missing duration',
    'low duration',
    'expired reset',
    'inconsistent projection',
  ])('fails closed for %s', (variant) => {
    const initial = observeWindowCycle(sample(0));
    const window = sample(30);
    if (variant === 'missing reset') delete window.resetAt;
    if (variant === 'low reset') window.resetAt!.confidence = 'low';
    if (variant === 'missing duration') delete window.durationSeconds;
    if (variant === 'low duration') window.durationSeconds!.confidence = 'low';
    if (variant === 'expired reset') window.resetAt!.value = new Date(origin).toISOString();
    if (variant === 'inconsistent projection')
      window.resetAt!.value = new Date(origin + 20_000_000).toISOString();
    expect(observeWindowCycle(window, initial.cycle).window.phase.value).toBe('UNKNOWN');
  });

  it('blocks an unexplained reset correction before a known anchor expires', () => {
    const active = observeWindowCycle(sample(0, 18_000, 0.01));
    const result = observeWindowCycle(sample(30, 20_000), active.cycle);
    expect(result.window.phase.value).toBe('UNKNOWN');
    expect(result.cycle.anchoredResetAtMs).toBe(active.cycle.anchoredResetAtMs);
    // Repeated static shifted resets still stay blocked.
    const repeated = observeWindowCycle(sample(240, 20_000), result.cycle);
    expect(repeated.window.phase.value).toBe('UNKNOWN');
    expect(repeated.cycle.anchoredResetAtMs).toBe(active.cycle.anchoredResetAtMs);
  });

  it('recovers to INACTIVE when a forced reset holds 0% and rolling now+duration for 180s', () => {
    const active = observeWindowCycle(sample(0, 18_000, 0.25));
    expect(active.cycle.anchoredResetAtMs).toBe(origin + 18_000_000);

    // First post-reset reading establishes the UNKNOWN rolling baseline.
    const baseline = observeWindowCycle(sample(30), active.cycle);
    expect(baseline.window.phase.value).toBe('UNKNOWN');
    expect(baseline.cycle.lastObservedAtMs).toBe(origin + 30_000);
    expect(baseline.cycle.anchoredResetAtMs).toBe(origin + 18_000_000);

    // Sustained rolling readings before 180s preserve the baseline and stay UNKNOWN.
    for (const seconds of [60, 120, 209]) {
      const pending = observeWindowCycle(sample(seconds), baseline.cycle);
      expect(pending.window.phase.value).toBe('UNKNOWN');
      expect(pending.cycle).toEqual(baseline.cycle);
    }

    // At 180s from the rolling baseline, forced reset is confirmed.
    const recovered = observeWindowCycle(sample(210), baseline.cycle);
    expect(recovered.window.phase).toMatchObject({ value: 'INACTIVE', confidence: 'high' });
    expect(recovered.cycle.cycleAtMs).toBe(origin + 210_000);
    expect(recovered.cycle.anchoredResetAtMs).toBeNull();
  });

  it('resets forced-reset confirmation if backend flickers back to ACTIVE or static reset', () => {
    const active = observeWindowCycle(sample(0, 18_000, 0.25));
    const firstRolling = observeWindowCycle(sample(30), active.cycle);
    const midFlicker = observeWindowCycle(sample(120), firstRolling.cycle);
    expect(midFlicker.window.phase.value).toBe('UNKNOWN');

    // Rollout flickers back to the old active state, invalidating the 30s baseline.
    const flickeredActive = observeWindowCycle(sample(150, 18_000, 0.25), midFlicker.cycle);
    expect(flickeredActive.window.phase.value).toBe('ACTIVE');
    expect(flickeredActive.cycle.anchoredResetAtMs).toBe(origin + 18_000_000);

    const secondBaseline = observeWindowCycle(sample(180), flickeredActive.cycle);
    expect(secondBaseline.window.phase.value).toBe('UNKNOWN');
    // 210s is 180s after the first baseline, but only 30s after the post-flicker baseline.
    expect(observeWindowCycle(sample(210), secondBaseline.cycle).window.phase.value).toBe(
      'UNKNOWN',
    );
    const confirmed = observeWindowCycle(sample(360), secondBaseline.cycle);
    expect(confirmed.window.phase).toMatchObject({ value: 'INACTIVE', confidence: 'high' });
    expect(confirmed.cycle.anchoredResetAtMs).toBeNull();

    // A single rolling reading followed by a static (non-rolling) reset does not recover.
    const active2 = observeWindowCycle(sample(0, 18_000, 0.25));
    const rollOnce = observeWindowCycle(sample(30), active2.cycle);
    const staticAfter = observeWindowCycle(sample(240, 18_030), rollOnce.cycle);
    expect(staticAfter.window.phase.value).toBe('UNKNOWN');
    expect(staticAfter.cycle.anchoredResetAtMs).toBe(origin + 18_000_000);
  });

  it('preserves non-temporal provider facts and does not promote low confidence on repeated reads', () => {
    const window = sample(0);
    window.phase = { ...window.phase, value: 'INACTIVE', source: 'observed', confidence: 'low' };
    delete window.resetAt;
    const result = observeWindowCycle(window);
    expect(result.window.phase).toEqual(window.phase);
    expect(observeWindowCycle(window, result.cycle).window.phase.confidence).toBe('low');
  });

  it('learns an external active window after expiry without losing the previous availability boundary', () => {
    const active = observeWindowCycle(sample(0, 18_000, 0.01));
    const next = observeWindowCycle(sample(18_030, 36_030, 0.02), active.cycle);
    expect(next.cycle.cycleAtMs).toBe(origin + 18_000_000);
    expect(next.cycle.anchoredResetAtMs).toBe(origin + 36_030_000);
  });

  it('recognizes a reported active-to-inactive transition when the provider omits reset timestamps', () => {
    const active = sample(0, 18_000, 0.01);
    delete active.resetAt;
    const previous = observeWindowCycle(active);
    const inactive = sample(18_030);
    delete inactive.resetAt;
    inactive.phase = { ...inactive.phase, value: 'INACTIVE', confidence: 'high' };
    const result = observeWindowCycle(inactive, previous.cycle);
    expect(result.cycle.cycleAtMs).toBe(origin + 18_030_000);
    expect(result.window.phase.value).toBe('INACTIVE');
  });

  it('preserves the canonical RESET_DUE phase without inventing an anchor', () => {
    const window = sample(0);
    window.phase = { ...window.phase, value: 'RESET_DUE', source: 'observed', confidence: 'exact' };
    delete window.resetAt;
    const result = observeWindowCycle(window);
    expect(result.cycle.phase).toBe('RESET_DUE');
    expect(result.cycle.anchoredResetAtMs).toBeNull();
  });
});
