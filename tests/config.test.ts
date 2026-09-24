import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses safe defaults including the configured IANA timezone', () => {
    const config = loadConfig({});

    expect(config.AWM_BIND).toBe('0.0.0.0');
    expect(config.AWM_PORT).toBe(8787);
    expect(config.AWM_TIMEZONE).toBe('America/Sao_Paulo');
    expect(config.AWM_FAKE_PROVIDER_ENABLED).toBe(false);
    expect(config.AWM_CODEX_ENABLED).toBe(false);
    expect(config.AWM_CODEX_TRIGGER_ENABLED).toBe(false);
    expect(config.AWM_CODEX_HOME).toBe('./data/codex');
    expect(config.AWM_CODEX_ACTION_TIMEOUT_SECONDS).toBe(30);
    expect(config.AWM_AUTH_SESSION_TIMEOUT_SECONDS).toBe(900);
    expect(config.AWM_ANTIGRAVITY_ENABLED).toBe(false);
    expect(config.AWM_ANTIGRAVITY_HOME).toBe('./data/antigravity');
    expect(config.AWM_ANTIGRAVITY_EXECUTABLE).toBe('agy');
    expect(config.AWM_RECONCILE_INTERVAL_SECONDS).toBe(30);
    expect(config.AWM_EXECUTOR_INTERVAL_SECONDS).toBe(5);
    expect(config.AWM_RETENTION_INTERVAL_SECONDS).toBe(86400);
  });

  it('rejects an invalid timezone before startup', () => {
    expect(() => loadConfig({ AWM_TIMEZONE: 'Not/AZone' })).toThrow(/valid IANA timezone/);
  });

  it('accepts a bounded Codex action timeout independently from the read path', () => {
    expect(
      loadConfig({ AWM_CODEX_ACTION_TIMEOUT_SECONDS: '45' }).AWM_CODEX_ACTION_TIMEOUT_SECONDS,
    ).toBe(45);
    expect(() => loadConfig({ AWM_CODEX_ACTION_TIMEOUT_SECONDS: '4' })).toThrow();
    expect(() => loadConfig({ AWM_CODEX_ACTION_TIMEOUT_SECONDS: '121' })).toThrow();
  });

  it('bounds auth sessions and keeps Antigravity opt-in', () => {
    expect(
      loadConfig({ AWM_AUTH_SESSION_TIMEOUT_SECONDS: '1200', AWM_ANTIGRAVITY_ENABLED: 'true' }),
    ).toMatchObject({
      AWM_AUTH_SESSION_TIMEOUT_SECONDS: 1200,
      AWM_ANTIGRAVITY_ENABLED: true,
    });
    expect(() => loadConfig({ AWM_AUTH_SESSION_TIMEOUT_SECONDS: '59' })).toThrow();
    expect(() => loadConfig({ AWM_AUTH_SESSION_TIMEOUT_SECONDS: '1801' })).toThrow();
    expect(() => loadConfig({ AWM_ANTIGRAVITY_ENABLED: 'yes' })).toThrow();
  });
});
