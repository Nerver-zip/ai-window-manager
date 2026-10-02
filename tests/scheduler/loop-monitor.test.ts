import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/scheduler/clock.js';
import { LoopMonitor } from '../../src/scheduler/loop-monitor.js';

function setup(intervalMs = 30_000, maxRunMs = 60_000) {
  const clock = new FakeClock('2026-10-02T12:00:00Z');
  const monitor = new LoopMonitor(clock);
  monitor.register('reconcile', { intervalMs, maxRunMs });
  return { clock, monitor };
}

describe('LoopMonitor', () => {
  it('allows startup and configured idle intervals but detects missing progress', () => {
    const { clock, monitor } = setup(3_600_000);
    expect(monitor.snapshot()).toMatchObject({ ready: true, loops: [{ status: 'starting' }] });
    clock.advanceMs(2 * 3_600_000 + 60_000);
    expect(monitor.snapshot().ready).toBe(true);
    clock.advanceMs(1);
    expect(monitor.snapshot()).toMatchObject({ ready: false, loops: [{ status: 'overdue' }] });
    monitor.begin('reconcile');
    monitor.finish('reconcile', true);
    expect(monitor.snapshot()).toMatchObject({ ready: true, loops: [{ status: 'ok' }] });
  });

  it('detects a stalled run without treating a legitimate slow run as stalled', () => {
    const { clock, monitor } = setup();
    monitor.begin('reconcile');
    clock.advanceMs(60_000);
    expect(monitor.snapshot()).toMatchObject({
      ready: true,
      loops: [{ running: true, durationMs: 60_000 }],
    });
    clock.advanceMs(1);
    expect(monitor.snapshot()).toMatchObject({ ready: false, loops: [{ status: 'stalled' }] });
    monitor.finish('reconcile', true);
    expect(monitor.snapshot().loops[0]).toMatchObject({
      running: false,
      durationMs: 60_001,
      status: 'ok',
    });
  });

  it('measures elapsed progress independently of backward and forward wall clock jumps', () => {
    const { clock, monitor } = setup();
    monitor.begin('reconcile');
    clock.setWallClock('2025-01-01T00:00:00Z');
    clock.advanceMs(1_000);
    monitor.finish('reconcile', true);
    clock.setWallClock('2030-01-01T00:00:00Z');
    expect(monitor.snapshot()).toMatchObject({
      ready: true,
      loops: [{ durationMs: 1000, status: 'ok' }],
    });
    clock.advanceMs(120_001);
    expect(monitor.snapshot().ready).toBe(false);
  });

  it('records unhandled failures and recovery, without promoting provider outage to loop failure', async () => {
    const { clock, monitor } = setup();
    await monitor.run('reconcile', () => ({ providerHealth: 'AUTH_REQUIRED' }));
    const success = monitor.snapshot().loops[0]!.lastSuccessAtMs;
    for (let n = 0; n < 3; n++) {
      clock.advanceMs(1);
      await expect(
        monitor.run('reconcile', () => {
          throw new Error('synthetic failure');
        }),
      ).rejects.toThrow('synthetic failure');
    }
    expect(monitor.snapshot()).toMatchObject({
      ready: false,
      loops: [{ status: 'failing', consecutiveFailures: 3, lastSuccessAtMs: success }],
    });
    await monitor.run('reconcile', () => Promise.resolve('handled external outage'));
    expect(monitor.snapshot()).toMatchObject({ ready: true, loops: [{ consecutiveFailures: 0 }] });
  });

  it('rejects invalid configuration, unknown and overlapping lifecycle operations', () => {
    const { monitor } = setup();
    expect(() => monitor.register('reconcile', { intervalMs: 1, maxRunMs: 1 })).toThrow();
    expect(() => monitor.register('cleanup', { intervalMs: 0, maxRunMs: 1 })).toThrow(RangeError);
    expect(() => monitor.begin('cleanup')).toThrow();
    expect(() => monitor.finish('reconcile', false)).toThrow();
    monitor.begin('reconcile');
    expect(() => monitor.begin('reconcile')).toThrow();
    monitor.finish('reconcile', false);
    expect(monitor.snapshot().ready).toBe(true);
    expect(new LoopMonitor(new FakeClock('2026-10-02')).snapshot().ready).toBe(false);
  });
});
