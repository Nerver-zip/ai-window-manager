import { describe, expect, it } from 'vitest';
import type { ProviderObservation } from '../../src/domain/types.js';
import {
  CLAUDE_CODE_FIVE_HOUR_WINDOW,
  claudeWindowSnapshot,
} from '../../src/providers/claude-code/index.js';
import { deriveCurrentWindowForTarget } from '../../src/scheduler/current-window.js';
import { planWindowAction } from '../../src/scheduler/planner.js';
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
  it('keeps generic medium-confidence idle evidence unactionable without an anchored reset', () => {
    const weak = session(0, 0, null);
    weak.phase = { ...weak.phase, confidence: 'medium' };
    const first = observeWindowCycle(weak);
    expect(first.window.phase).toMatchObject({ value: 'INACTIVE', confidence: 'medium' });
    const again = observeWindowCycle(
      { ...session(600, 0, null), phase: { ...weak.phase, observedAt: at(600) } },
      first.cycle,
    );
    expect(again.window.phase).toMatchObject({ value: 'INACTIVE', confidence: 'medium' });
  });

  it('allows the first automatic start for the official zero-use session meter with no reset', () => {
    const observed = observeWindowCycle(session(0, 0, null));
    expect(observed.window.phase).toMatchObject({ value: 'INACTIVE', confidence: 'high' });
    const observation: ProviderObservation = {
      providerId: 'claude_code',
      health: 'UP',
      observedAt: at(0),
      staleAfterSeconds: 120,
      windows: [observed.window],
    };
    const currentWindow = deriveCurrentWindowForTarget(
      'claude_code',
      observation,
      'UP',
      CLAUDE_CODE_FIVE_HOUR_WINDOW,
    );

    const decision = planWindowAction({
      now: new Date(at(0)),
      providerId: 'claude_code',
      policy: {
        id: 'activation-claude_code',
        providerId: 'claude_code',
        kind: 'auto',
        enabled: true,
        timezone: 'America/Sao_Paulo',
        windowKind: CLAUDE_CODE_FIVE_HOUR_WINDOW,
        updatedAtMs: origin,
      },
      currentWindow,
      window: observed.window,
      observation: { observedAt: observation.observedAt, staleAfterSeconds: 120 },
      capabilities: {
        windowTrigger: {
          supported: true,
          contract: 'official_supported',
          consumesQuota: true,
          supportedWindowKinds: [CLAUDE_CODE_FIVE_HOUR_WINDOW],
        },
      },
      automationEnabled: true,
      observedCycleAt: new Date(observed.cycle.cycleAtMs).toISOString(),
    });

    expect(decision).toMatchObject({ kind: 'START', reasonCode: 'AUTO_WINDOW_AVAILABLE' });

    const started = observeWindowCycle(session(1, 1, 18_001), observed.cycle);
    expect(started.window.phase).toMatchObject({ value: 'ACTIVE', confidence: 'high' });
    expect(started.cycle.cycleAtMs).toBe(observed.cycle.cycleAtMs);
    expect(started.cycle.anchoredResetAtMs).toBe(origin + 18_001_000);
  });

  it('upgrades an idle meter after the anchored reset passed and keeps the new cycle through a start', () => {
    const active = observeWindowCycle(session(0, 20, 18_000));
    expect(active.window.phase).toMatchObject({ value: 'ACTIVE', confidence: 'high' });
    expect(active.cycle.anchoredResetAtMs).toBe(origin + 18_000_000);

    // Still before the anchored reset: a missing reset conflicts with the known
    // started session, so this observation is unknown and cannot restart it.
    const early = observeWindowCycle(session(9_000, 0, null), active.cycle);
    expect(early.window.phase).toMatchObject({ value: 'UNKNOWN', confidence: 'unknown' });

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

  it('does not raise a medium no-reset phase with low usage evidence', () => {
    const window = session(0, 0, null);
    window.phase = { ...window.phase, confidence: 'medium' };
    window.usageRatio!.confidence = 'low';
    expect(observeWindowCycle(window).window.phase).toMatchObject({
      value: 'INACTIVE',
      confidence: 'medium',
    });
  });

  it('keeps an expired reset as RESET_DUE without opening a new cycle', () => {
    const active = observeWindowCycle(session(0, 20, 18_000));
    const due = observeWindowCycle(session(18_000, 20, 18_000), active.cycle);
    expect(due.window.phase.value).toBe('RESET_DUE');
    expect(due.cycle.cycleAtMs).toBe(active.cycle.cycleAtMs);
  });
});
