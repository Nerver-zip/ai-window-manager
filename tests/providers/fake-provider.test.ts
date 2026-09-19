import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';

describe('FakeProvider', () => {
  it('starts and resets a short fake window deterministically', async () => {
    const clock = new FakeClock('2026-09-14T11:00:00Z');
    const provider = new FakeProvider(clock, { windowDurationSeconds: 30 });

    expect((await provider.inspect({})).windows[0]?.phase).toBe('INACTIVE');
    expect(
      (
        await provider.triggerWindow(
          {},
          {
            intentId: 'i1',
            dedupeKey: 'd1',
            reasonCode: 'test',
          },
        )
      ).status,
    ).toBe('succeeded');
    expect((await provider.inspect({})).windows[0]?.phase).toBe('ACTIVE');

    clock.advanceMs(30_000);
    expect((await provider.inspect({})).windows[0]?.phase).toBe('INACTIVE');
  });
});
