import { describe, expect, it } from 'vitest';
import { claudeWindowSnapshot } from '../../src/providers/claude-code/index.js';
import { observeWindowCycle } from '../../src/scheduler/window-cycle.js';

const origin = Date.parse('2026-11-03T07:00:00Z');
const at = (seconds: number) => new Date(origin + seconds * 1000).toISOString();

function session(seconds: number, percent: number, resetSeconds: number | null) {
  return claudeWindowSnapshot(
    'claude_code',
    {
      kind: 'session',
      group: 'session',
      percent,
      resetsAt: resetSeconds === null ? null : at(resetSeconds),
      scopeLabel: null,
    },
    at(seconds),
  );
}

describe('Claude Code five-hour cycle evidence', () => {
  it('never makes an idle meter actionable without a previously anchored reset', () => {
    const first = observeWindowCycle(session(0, 0, null));
    expect(first.window.phase).toMatchObject({ value: 'INACTIVE', confidence: 'medium' });
    const again = observeWindowCycle(session(600, 0, null), first.cycle);
    expect(again.window.phase).toMatchObject({ value: 'INACTIVE', confidence: 'medium' });
  });

  it('upgrades an idle meter after the anchored reset passed and keeps the new cycle through a start', () => {
    const active = observeWindowCycle(session(0, 20, 18_000));
    expect(active.window.phase).toMatchObject({ value: 'ACTIVE', confidence: 'high' });
    expect(active.cycle.anchoredResetAtMs).toBe(origin + 18_000_000);

    // Still before the anchored reset: an idle-looking reading stays weak evidence.
    const early = observeWindowCycle(session(9_000, 0, null), active.cycle);
    expect(early.window.phase.confidence).toBe('medium');

    const idle = observeWindowCycle(session(18_060, 0, null), active.cycle);
    expect(idle.window.phase).toMatchObject({ value: 'INACTIVE', confidence: 'high' });
    expect(idle.cycle.cycleAtMs).toBe(origin + 18_000_000);

    // A start then anchors a fresh window; the bound cycle identity is unchanged,
    // so the executor can confirm the intent against it.
    const started = observeWindowCycle(session(18_200, 1, 36_000), idle.cycle);
    expect(started.window.phase).toMatchObject({ value: 'ACTIVE', confidence: 'high' });
    expect(started.cycle.cycleAtMs).toBe(idle.cycle.cycleAtMs);
    expect(started.cycle.anchoredResetAtMs).toBe(origin + 36_000_000);
  });

  it('does not upgrade a reading whose usage evidence is not actionable', () => {
    const active = observeWindowCycle(session(0, 20, 18_000));
    const window = session(18_060, 0, null);
    window.usageRatio!.confidence = 'low';
    expect(observeWindowCycle(window, active.cycle).window.phase.confidence).toBe('medium');
  });

  it('keeps an expired reset as RESET_DUE without opening a new cycle', () => {
    const active = observeWindowCycle(session(0, 20, 18_000));
    const due = observeWindowCycle(session(18_000, 20, 18_000), active.cycle);
    expect(due.window.phase.value).toBe('RESET_DUE');
    expect(due.cycle.cycleAtMs).toBe(active.cycle.cycleAtMs);
  });
});
