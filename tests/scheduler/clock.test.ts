import { describe, expect, it } from 'vitest';
import { FakeClock, SystemClock } from '../../src/scheduler/clock.js';

describe('clocks', () => {
  it('provides current and monotonic time through the system clock', () => {
    const clock = new SystemClock();

    expect(clock.now()).toBeInstanceOf(Date);
    expect(clock.monotonicMs()).toEqual(expect.any(Number));
  });

  it('advances a fake clock without allowing backwards movement', () => {
    const clock = new FakeClock('2026-09-14T11:00:00.000Z');

    expect(clock.now().toISOString()).toBe('2026-09-14T11:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
    clock.advanceMs(1_500);
    expect(clock.now().toISOString()).toBe('2026-09-14T11:00:01.500Z');
    expect(clock.monotonicMs()).toBe(1_500);
    expect(() => clock.advanceMs(-1)).toThrow('cannot move backwards');
  });
});
