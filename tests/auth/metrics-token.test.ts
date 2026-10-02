import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeMetricsRead, validateMetricsTokenDigest } from '../../src/auth/metrics-token.js';
import { generateMetricsCredential } from '../../scripts/metrics-token.js';
import { loadTestConfig } from '../helpers/operator-auth.js';

const token = 'synthetic-metrics-test-'.padEnd(43, 'x');
const digest = createHash('sha256').update(token).digest('hex');

describe('dedicated metrics authentication', () => {
  it('generates independent 32-byte credentials without exposing them on import', () => {
    const first = generateMetricsCredential();
    const second = generateMetricsCredential();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.token, 'base64url')).toHaveLength(32);
    expect(first.token).not.toBe(second.token);
    expect(first.digest).toBe(createHash('sha256').update(first.token).digest('hex'));
  });

  it('validates optional digest configuration and fails safely on invalid configuration', () => {
    expect(loadTestConfig().AWM_METRICS_TOKEN_SHA256).toBe('');
    expect(loadTestConfig({ AWM_METRICS_TOKEN_SHA256: digest }).AWM_METRICS_TOKEN_SHA256).toBe(
      digest,
    );
    for (const value of [token, digest.toUpperCase(), 'x'.repeat(64), digest + '\n']) {
      expect(validateMetricsTokenDigest(value)).toBe(false);
      expect(() => loadTestConfig({ AWM_METRICS_TOKEN_SHA256: value })).toThrow(
        'lowercase SHA-256',
      );
    }
  });

  it('accepts only exact read-only metrics Bearer credentials', () => {
    for (const method of ['GET', 'HEAD']) {
      expect(authorizeMetricsRead(method, '/metrics', `Bearer ${token}`, digest)).toBe(true);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'get']) {
      expect(authorizeMetricsRead(method, '/metrics', `Bearer ${token}`, digest)).toBe(false);
    }
    for (const url of [
      '/',
      '/api/v1/diagnostics',
      '/logout',
      '/metrics/',
      '/metrics?token=x',
      '/%6Detrics',
    ]) {
      expect(authorizeMetricsRead('GET', url, `Bearer ${token}`, digest)).toBe(false);
    }
    for (const header of [
      undefined,
      '',
      token,
      `Basic ${token}`,
      `Bearer ${token}x`,
      `Bearer ${token}\n`,
      `Bearer ${'y'.repeat(43)}`,
    ]) {
      expect(authorizeMetricsRead('GET', '/metrics', header, digest)).toBe(false);
    }
    expect(authorizeMetricsRead('GET', '/metrics', `Bearer ${token}`, '')).toBe(false);
    expect(authorizeMetricsRead('GET', '/metrics', `Bearer ${token}`, 'bad')).toBe(false);
  });
});
