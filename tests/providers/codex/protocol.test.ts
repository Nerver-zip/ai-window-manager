import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CodexRateLimitsResponseSchema,
  parseCodexRateLimitsResponse,
} from '../../../src/providers/codex/protocol.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/providers/codex/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

describe('Codex app-server response schema', () => {
  it('accepts multiple limit buckets and unknown additive fields', () => {
    const response = parseCodexRateLimitsResponse(fixture('rate-limits.multi-window.json'));

    expect(Object.keys(response.rateLimitsByLimitId ?? {})).toEqual(['codex', 'weekly-limit']);
    expect(response.rateLimits.primary?.usedPercent).toBe(25);
    expect(response.futureField).toEqual({ ignored: true });
  });

  it('keeps nullable partial windows valid', () => {
    const response = parseCodexRateLimitsResponse(fixture('rate-limits.partial.json'));

    expect(response.rateLimits.primary).toMatchObject({
      usedPercent: 0,
      windowDurationMins: null,
      resetsAt: null,
    });
    expect(response.rateLimits.secondary).toBeNull();
  });

  it('rejects invalid numeric semantics at the adapter boundary', () => {
    const result = CodexRateLimitsResponseSchema.safeParse(
      fixture('rate-limits.invalid-numeric.json'),
    );

    expect(result.success).toBe(false);
  });

  it('rejects a missing compatibility rateLimits object', () => {
    expect(() => parseCodexRateLimitsResponse({})).toThrow();
  });
});
