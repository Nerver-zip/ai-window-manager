import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OpenCodeOutputError,
  generateOpenCodeSessionId,
  isOpenCodeSessionId,
  parseRunEvent,
  parseUsageEnvelope,
} from '../../../src/providers/opencode/protocol.js';

function fixture(name: string): string {
  return readFileSync(`tests/fixtures/providers/opencode/${name}`, 'utf8');
}

function usage(go: unknown): string {
  return JSON.stringify({ data: { workspace: { id: 'wrk_x' }, ...(go ? { go } : {}) } });
}

const meter = { percent: 1, limited: false, resetsAt: 1_795_352_400_000 };

describe('parseUsageEnvelope', () => {
  it('parses the three Go meters and ignores budgets and additive fields', () => {
    const report = parseUsageEnvelope(fixture('usage-go.json'));
    expect(report).toEqual({
      status: 'meters',
      meters: [
        {
          kind: 'rolling',
          percent: 12.5,
          limited: false,
          resetsAt: '2026-11-21T15:00:00.000Z',
        },
        { kind: 'weekly', percent: 45, limited: false, resetsAt: '2026-11-23T00:00:00.000Z' },
        { kind: 'monthly', percent: 30, limited: false, resetsAt: '2026-12-01T00:00:00.000Z' },
      ],
    });
  });

  it('reports signed-out (null data) and a workspace without Go', () => {
    expect(parseUsageEnvelope(fixture('usage-signed-out.json'))).toEqual({ status: 'signed_out' });
    expect(parseUsageEnvelope(fixture('usage-no-go.json'))).toEqual({ status: 'no_go' });
  });

  it('treats the web-app HTML fallback as a changed contract', () => {
    expect(() => parseUsageEnvelope('<!doctype html><html></html>')).toThrowError(
      expect.objectContaining({ code: 'SCHEMA_CHANGED' }),
    );
  });

  it('rejects non-JSON output as invalid', () => {
    expect(() => parseUsageEnvelope('HTTP 500')).toThrowError(
      expect.objectContaining({ code: 'OUTPUT_INVALID' }),
    );
  });

  it.each([
    ['missing data key', '{}'],
    ['array root', '[]'],
    ['missing workspace', JSON.stringify({ data: { go: {} } })],
    ['missing monthly meter', usage({ rolling: meter, weekly: meter })],
    [
      'percent above 100',
      usage({ rolling: { ...meter, percent: 101 }, weekly: meter, monthly: meter }),
    ],
    [
      'negative percent',
      usage({ rolling: { ...meter, percent: -1 }, weekly: meter, monthly: meter }),
    ],
    [
      'non-boolean limited',
      usage({ rolling: { ...meter, limited: 'no' }, weekly: meter, monthly: meter }),
    ],
    [
      'string reset',
      usage({ rolling: { ...meter, resetsAt: '2026-11-21' }, weekly: meter, monthly: meter }),
    ],
    ['zero reset', usage({ rolling: { ...meter, resetsAt: 0 }, weekly: meter, monthly: meter })],
    [
      'unrepresentable reset',
      usage({ rolling: { ...meter, resetsAt: 9e15 }, weekly: meter, monthly: meter }),
    ],
  ])('fails closed on %s', (_name, body) => {
    expect(() => parseUsageEnvelope(body)).toThrowError(OpenCodeOutputError);
  });
});

describe('parseRunEvent', () => {
  it('classifies lifecycle and error events without retaining text', () => {
    expect(parseRunEvent('{"type":"step_start","sessionID":"ses_a","timestamp":1}')).toEqual({
      kind: 'step_start',
      sessionId: 'ses_a',
    });
    expect(parseRunEvent('{"type":"step_finish","sessionID":"ses_a"}')).toMatchObject({
      kind: 'step_finish',
    });
    expect(parseRunEvent('{"type":"retry","sessionID":"ses_a"}')).toMatchObject({ kind: 'retry' });
    const error = parseRunEvent(
      '{"type":"error","sessionID":"ses_a","error":{"type":"provider.no-route","message":"secret text"}}',
    );
    expect(error).toEqual({ kind: 'error', errorType: 'provider.no-route', sessionId: 'ses_a' });
    expect(JSON.stringify(error)).not.toContain('secret text');
    expect(parseRunEvent('{"type":"error"}')).toMatchObject({ errorType: 'unknown' });
    const text = parseRunEvent('{"type":"text","part":{"text":"model answer"}}');
    expect(text).toEqual({ kind: 'other', sessionId: null });
    expect(JSON.stringify(text)).not.toContain('model answer');
  });

  it('rejects malformed lines and changed envelopes', () => {
    expect(() => parseRunEvent('not json')).toThrowError(
      expect.objectContaining({ code: 'OUTPUT_INVALID' }),
    );
    expect(() => parseRunEvent('[1]')).toThrowError(
      expect.objectContaining({ code: 'OUTPUT_INVALID' }),
    );
    expect(() => parseRunEvent('null')).toThrowError(OpenCodeOutputError);
    expect(() => parseRunEvent('{"type":5}')).toThrowError(
      expect.objectContaining({ code: 'SCHEMA_CHANGED' }),
    );
  });
});

describe('session IDs', () => {
  it('generates IDs the official client accepts and validates strictly', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(isOpenCodeSessionId(generateOpenCodeSessionId())).toBe(true);
    }
    expect(isOpenCodeSessionId('ses_e8d7178b2dd8HxCBdaqMTwVDx7')).toBe(true);
    for (const bad of [
      '',
      'ses_',
      'ses_short',
      'ses_E8D7178B2DD8HxCBdaqMTwVDx7',
      'xyz_e8d7178b2dd8HxCBdaqMTwVDx7',
      'ses_e8d7178b2dd8HxCBdaqMTwVDx7 ',
      'ses_e8d7178b2dd8HxCBdaqMTwVDx7; rm -rf',
      42,
      undefined,
    ]) {
      expect(isOpenCodeSessionId(bad)).toBe(false);
    }
  });

  it('rejects out-of-range random bytes so base62 stays unbiased', () => {
    const calls: number[] = [];
    const id = generateOpenCodeSessionId((size) => {
      calls.push(size);
      // 6 bytes for the hex prefix, then one batch of rejected (>=248) and valid bytes.
      return size === 6
        ? Buffer.from([1, 2, 3, 4, 5, 255])
        : Buffer.concat([
            Buffer.alloc(16, 250),
            Buffer.from([0, 1, 2, 3, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72]),
          ]);
    });
    // Bytes 0,1,2,3,61,62..70 map to base62 '0123z012345678'; the 250s were rejected.
    expect(id).toBe('ses_0102030405ff0123z012345678');
    expect(isOpenCodeSessionId(id)).toBe(true);
    expect(calls[0]).toBe(6);
  });
});
