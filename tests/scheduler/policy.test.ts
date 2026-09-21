import { describe, expect, it } from 'vitest';
import {
  activationPolicyFromRecord,
  ActivationPolicySchema,
  isValidTimeZone,
  localTimeMinutes,
  parseActivationPolicy,
  safeParseActivationPolicy,
  sortLocalTimes,
  validatePolicySemantics,
  validateToleranceAgainstDuration,
} from '../../src/scheduler/policy.js';

const base = {
  id: 'activation-fake',
  providerId: 'fake',
  enabled: true,
  timezone: 'UTC',
  updatedAtMs: 1,
};

describe('activation policies', () => {
  it.each(['manual', 'auto'] as const)('parses %s policies', (kind) => {
    expect(parseActivationPolicy({ ...base, kind })).toMatchObject({ kind });
  });

  it('parses fixed, custom and active-hours policies', () => {
    expect(
      parseActivationPolicy({
        ...base,
        kind: 'fixed',
        windowKind: 'five_hour',
        anchorLocalTime: '08:00',
        toleranceSeconds: 900,
      }),
    ).toMatchObject({ kind: 'fixed' });
    expect(
      parseActivationPolicy({
        ...base,
        kind: 'custom_schedule',
        windowKind: 'five_hour',
        times: ['08:00', '18:00'],
        toleranceSeconds: 900,
      }),
    ).toMatchObject({ kind: 'custom_schedule' });
    expect(
      parseActivationPolicy({
        ...base,
        kind: 'active_hours',
        windowKind: 'five_hour',
        periods: [
          { start: '08:00', end: '12:00' },
          { start: '18:00', end: '22:00' },
        ],
      }),
    ).toMatchObject({ kind: 'active_hours' });
  });

  it('rejects duplicate schedule times and invalid active periods', () => {
    expect(() =>
      parseActivationPolicy({
        ...base,
        kind: 'custom_schedule',
        windowKind: 'five_hour',
        times: ['08:00', '08:00'],
        toleranceSeconds: 30,
      }),
    ).toThrow('unique');
    expect(() =>
      parseActivationPolicy({
        ...base,
        kind: 'active_hours',
        windowKind: 'five_hour',
        periods: [
          { start: '08:00', end: '12:00' },
          { start: '11:00', end: '13:00' },
        ],
      }),
    ).toThrow('overlap');
    expect(() =>
      parseActivationPolicy({
        ...base,
        kind: 'active_hours',
        windowKind: 'five_hour',
        periods: [{ start: '08:00', end: '08:00' }],
      }),
    ).toThrow('empty');
    expect(() =>
      validatePolicySemantics({
        ...base,
        kind: 'active_hours',
        windowKind: 'five_hour',
        periods: [{ start: '22:00', end: '02:00' }],
      }),
    ).not.toThrow();
  });

  it('returns structured safe-parse errors for schema and semantic failures', () => {
    expect(
      safeParseActivationPolicy({
        ...base,
        kind: 'fixed',
        windowKind: 'five_hour',
        anchorLocalTime: 'bad',
        toleranceSeconds: 30,
      }).success,
    ).toBe(false);
    expect(
      safeParseActivationPolicy({
        ...base,
        kind: 'custom_schedule',
        windowKind: 'five_hour',
        times: ['08:00', '08:00'],
        toleranceSeconds: 30,
      }).success,
    ).toBe(false);
    expect(ActivationPolicySchema.safeParse({ ...base, kind: 'manual' }).success).toBe(true);
  });

  it('maps persisted legacy and current records', () => {
    const record = (kind: string, config: unknown) => ({ ...base, kind, config });
    expect(activationPolicyFromRecord(record('manual', {}))).toMatchObject({ kind: 'manual' });
    expect(activationPolicyFromRecord(record('auto', {}))).toMatchObject({ kind: 'auto' });
    expect(
      activationPolicyFromRecord(
        record('target_reset', { targetResetLocalTime: '08:00', toleranceSeconds: 30 }),
      ),
    ).toMatchObject({ kind: 'fixed', anchorLocalTime: '08:00' });
    expect(
      activationPolicyFromRecord(
        record('fixed', { anchorLocalTime: '09:00', windowKind: 'weekly' }),
      ),
    ).toMatchObject({ kind: 'fixed', windowKind: 'weekly' });
    expect(
      activationPolicyFromRecord(
        record('custom_schedule', { times: ['08:00'], windowKind: 'five_hour' }),
      ),
    ).toMatchObject({ kind: 'custom_schedule' });
    expect(() => activationPolicyFromRecord(record('custom_schedule', {}))).toThrow();
    expect(
      activationPolicyFromRecord(
        record('work_window', { periods: [{ start: '08:00', end: '12:00' }] }),
      ),
    ).toMatchObject({ kind: 'active_hours' });
    expect(
      activationPolicyFromRecord(
        record('active_hours', {
          periods: [{ start: '08:00', end: '12:00' }, 'invalid', null],
        }),
      ),
    ).toMatchObject({ kind: 'active_hours' });
    expect(activationPolicyFromRecord(record('active_hours', {}))).toBeUndefined();
    expect(activationPolicyFromRecord(record('unknown', {}))).toBeUndefined();
  });

  it('validates tolerance, timezone and local-time helpers', () => {
    expect(() => validateToleranceAgainstDuration(900, 1800)).toThrow('unambiguous');
    expect(() => validateToleranceAgainstDuration(-1, undefined)).toThrow('outside');
    expect(() => validateToleranceAgainstDuration(30.5, undefined)).toThrow('integer');
    expect(() => validateToleranceAgainstDuration(30, undefined)).not.toThrow();
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('not/a-zone')).toBe(false);
    expect(localTimeMinutes('08:30')).toBe(510);
    expect(() => localTimeMinutes('bad')).toThrow('HH:mm');
    expect(sortLocalTimes(['18:00', '08:00', '12:30'])).toEqual(['08:00', '12:30', '18:00']);
  });
});
