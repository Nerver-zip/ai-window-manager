import { describe, expect, it } from 'vitest';
import type { ProviderObservation, WindowSnapshot } from '../../src/domain/types.js';
import {
  deriveCurrentWindow,
  deriveCurrentWindowForTarget,
} from '../../src/scheduler/current-window.js';

const observedAt = '2026-09-19T12:00:00.000Z';

function window(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    providerId: 'fake',
    windowKind: 'five_hour',
    observedAt,
    phase: { value: 'INACTIVE', source: 'observed', confidence: 'exact', observedAt },
    ...overrides,
  };
}

function observation(windows: WindowSnapshot[]): ProviderObservation {
  return {
    providerId: 'fake',
    health: 'UP',
    observedAt,
    windows,
    staleAfterSeconds: 300,
  };
}

describe('deriveCurrentWindow', () => {
  it.each([
    ['missing observation', undefined, undefined, 'MONITORING_UNAVAILABLE'],
    ['auth required', observation([window()]), 'AUTH_REQUIRED', 'AUTH_REQUIRED'],
    ['provider unavailable', observation([window()]), 'UNAVAILABLE', 'MONITORING_UNAVAILABLE'],
    ['provider error', observation([window()]), 'ERROR', 'MONITORING_UNAVAILABLE'],
  ] as const)('%s is unavailable', (_label, input, health, reason) => {
    expect(deriveCurrentWindow('fake', input, health)).toMatchObject({
      providerId: 'fake',
      status: 'UNAVAILABLE',
      confidence: 'unknown',
      reason,
    });
  });

  it('preserves an active window reset fact', () => {
    const resetAt = {
      value: '2026-09-19T17:00:00.000Z',
      source: 'official_supported' as const,
      confidence: 'exact' as const,
      observedAt,
    };
    const startedAt = {
      value: '2026-09-19T12:00:00.000Z',
      source: 'observed' as const,
      confidence: 'high' as const,
      observedAt,
    };
    expect(
      deriveCurrentWindow(
        'fake',
        observation([
          window({
            phase: { value: 'ACTIVE', source: 'observed', confidence: 'high', observedAt },
            startedAt,
            resetAt,
          }),
        ]),
      ),
    ).toMatchObject({
      status: 'ACTIVE',
      windowKind: 'five_hour',
      startedAt,
      expectedEndAt: resetAt,
      confidence: 'high',
    });
  });

  it('infers the end of an active window only from valid duration evidence', () => {
    const startedAt = {
      value: '2026-09-19T12:00:00.000Z',
      source: 'observed' as const,
      confidence: 'exact' as const,
      observedAt,
    };
    const durationSeconds = {
      value: 18_000,
      source: 'official_supported' as const,
      confidence: 'exact' as const,
      observedAt,
    };
    expect(
      deriveCurrentWindow(
        'fake',
        observation([
          window({
            phase: { value: 'ACTIVE', source: 'inferred', confidence: 'exact', observedAt },
            startedAt,
            durationSeconds,
          }),
        ]),
      ).expectedEndAt,
    ).toMatchObject({
      value: '2026-09-19T17:00:00.000Z',
      source: 'inferred',
      confidence: 'exact',
    });
  });

  it('returns an exact inactive state', () => {
    expect(deriveCurrentWindow('fake', observation([window()]))).toMatchObject({
      status: 'INACTIVE',
      windowKind: 'five_hour',
      confidence: 'exact',
    });
  });

  it('derives state from the selected window instead of another reported window', () => {
    const primary = window({
      windowKind: 'primary',
      phase: { value: 'INACTIVE', source: 'observed', confidence: 'exact', observedAt },
    });
    const weekly = window({
      windowKind: 'weekly',
      phase: { value: 'ACTIVE', source: 'observed', confidence: 'exact', observedAt },
    });

    expect(
      deriveCurrentWindow('fake', observation([primary, weekly]), undefined, 'primary'),
    ).toMatchObject({
      status: 'INACTIVE',
      windowKind: 'primary',
    });
    expect(
      deriveCurrentWindow('fake', observation([primary, weekly]), undefined, 'weekly'),
    ).toMatchObject({
      status: 'ACTIVE',
      windowKind: 'weekly',
    });
  });

  it('fails closed when the selected window is not reported', () => {
    expect(deriveCurrentWindow('fake', observation([window()]), undefined, 'weekly')).toMatchObject(
      {
        status: 'UNKNOWN',
        windowKind: 'weekly',
        reason: 'WINDOW_NOT_REPORTED',
      },
    );
  });

  it('does not choose an arbitrary reported window when the managed target is unset', () => {
    expect(
      deriveCurrentWindowForTarget('fake', observation([window()]), undefined, undefined),
    ).toMatchObject({
      status: 'UNKNOWN',
      confidence: 'unknown',
      reason: 'WINDOW_TARGET_NOT_SELECTED',
    });
  });

  it('does not turn uncertain or exhausted evidence into a confident state', () => {
    const uncertain = window({
      phase: { value: 'ACTIVE', source: 'inferred', confidence: 'medium', observedAt },
    });
    expect(deriveCurrentWindow('fake', observation([uncertain]))).toMatchObject({
      status: 'UNKNOWN',
      reason: 'WINDOW_STATE_UNCERTAIN',
      confidence: 'medium',
    });
    expect(deriveCurrentWindow('fake', observation([]))).toMatchObject({
      status: 'UNKNOWN',
      reason: 'NO_WINDOW_REPORTED',
      confidence: 'unknown',
    });
  });

  it('ignores malformed started timestamps while retaining active status', () => {
    const result = deriveCurrentWindow(
      'fake',
      observation([
        window({
          phase: { value: 'ACTIVE', source: 'observed', confidence: 'exact', observedAt },
          startedAt: { value: 'not-a-date', source: 'observed', confidence: 'exact', observedAt },
          durationSeconds: {
            value: 18_000,
            source: 'official_supported',
            confidence: 'exact',
            observedAt,
          },
        }),
      ]),
    );
    expect(result.status).toBe('ACTIVE');
    expect(result.expectedEndAt).toBeUndefined();
  });
});
