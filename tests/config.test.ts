import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses safe defaults including the configured IANA timezone', () => {
    const config = loadConfig({});

    expect(config.AWM_BIND).toBe('0.0.0.0');
    expect(config.AWM_PORT).toBe(8787);
    expect(config.AWM_TIMEZONE).toBe('America/Sao_Paulo');
    expect(config.AWM_FAKE_PROVIDER_ENABLED).toBe(true);
  });

  it('rejects an invalid timezone before startup', () => {
    expect(() => loadConfig({ AWM_TIMEZONE: 'Not/AZone' })).toThrow(/valid IANA timezone/);
  });
});
