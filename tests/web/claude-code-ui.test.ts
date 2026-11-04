import { describe, expect, it } from 'vitest';
import type { AuthOnboardingStatus } from '../../src/web/ui/auth-onboarding.js';
import type { ProviderCapabilities, WindowSnapshot } from '../../src/domain/types.js';
import { renderActivationSchedulePage, renderSettingsPage } from '../../src/web/settings-ui.js';
import {
  errorLabel,
  providerDisplayName,
  providerLogoUrl,
  windowDisplayName,
  windowGroupDisplayName,
} from '../../src/web/ui/presentation.js';

const observedAt = '2026-11-03T12:00:00.000Z';

function capabilities(triggerSupported: boolean): ProviderCapabilities {
  return {
    usageRead: { supported: true, contract: 'official_supported' },
    resetRead: { supported: true, contract: 'official_supported' },
    windowTrigger: {
      supported: triggerSupported,
      contract: triggerSupported ? 'official_supported' : 'unknown',
      consumesQuota: true,
      ...(triggerSupported ? { supportedWindowKinds: ['claude_code_five_hour'] } : {}),
    },
  };
}

const fiveHour: WindowSnapshot = {
  providerId: 'claude_code',
  windowKind: 'claude_code_five_hour',
  observedAt,
  phase: { value: 'ACTIVE', source: 'inferred', confidence: 'high', observedAt },
  durationSeconds: { value: 18_000, source: 'official_supported', confidence: 'high', observedAt },
  resetAt: {
    value: '2026-11-03T15:00:00.000Z',
    source: 'official_supported',
    confidence: 'exact',
    observedAt,
  },
  usageRatio: { value: 0.25, source: 'official_supported', confidence: 'exact', observedAt },
};

function claudeProvider(triggerSupported: boolean) {
  return {
    id: 'claude_code',
    kind: 'claude_code',
    enabled: true,
    mode: 'monitor_only' as const,
    pollIntervalSeconds: 120,
    configured: true,
    capabilities: capabilities(triggerSupported),
    windows: [fiveHour],
  };
}

describe('Claude Code presentation', () => {
  it('labels the provider and windows without guessing scoped meter cadence', () => {
    expect(providerDisplayName('claude_code', 'claude_code')).toBe('Claude Code');
    expect(providerLogoUrl('claude_code', 'claude_code')).toBe(
      '/assets/images/providers/claude-code.png',
    );
    expect(windowDisplayName('claude_code', 'claude_code_five_hour', 18_000)).toBe('5-hour window');
    expect(windowDisplayName('claude_code', 'claude_code_seven_day', 604_800)).toBe(
      'Weekly window',
    );
    expect(windowGroupDisplayName('claude_code_five_hour')).toBeNull();
    expect(windowGroupDisplayName('claude_code_seven_day')).toBeNull();
    expect(windowGroupDisplayName('claude_code_weekly_scoped_sonnet')).toBe('Weekly Scoped Sonnet');
    expect(errorLabel('CLAUDE_CODE_AUTH_REQUIRED')).toContain('official Claude Code CLI');
    expect(errorLabel('CLAUDE_CODE_CONTRACT_CHANGED')).toContain('changed shape');
  });
});

describe('Claude Code settings', () => {
  it('uses the shared provider settings and onboarding presentation', () => {
    const status: AuthOnboardingStatus = {
      providerId: 'claude_code',
      state: 'FAILED',
      startedAt: null,
      expiresAt: null,
      authorizationUrl: null,
      userCode: null,
      requiresCodeSubmission: false,
      reasonCode: 'AUTH_REQUIRED',
    };
    const html = renderSettingsPage({
      csrfToken: 'csrf',
      providers: [claudeProvider(false)],
      authProviders: [{ providerId: 'claude_code', status, configured: true }],
    });
    expect(html).toContain('data-auth-provider-id="claude_code"');
    expect(html).toContain('Connect Claude Code');
    expect(html).toContain('/api/v1/providers/claude_code/auth/start');
    expect(html).toContain('provider-logo--claude-code');
    expect(html).toContain('width="40" height="40"');
    expect(html).toContain('What this provider can do');
    expect(html).toContain('Connect your account to customize monitoring settings.');
    expect(html).not.toContain('Use the official CLI instead');
    expect(html).not.toContain('Usage is read with the official');
    expect(html).not.toContain('Uses your allowance');
    expect(html).not.toContain('claude-code-cli auth');
    expect(html).not.toMatch(/name="code"|authorization code<\/label>/i);
  });

  it('uses the shared quota capability copy for an enabled start', () => {
    const html = renderSettingsPage({ csrfToken: 'csrf', providers: [claudeProvider(true)] });
    expect(html).toContain('May use provider quota when a window starts.');
    expect(html).not.toContain('Uses your allowance');
    expect(html).not.toContain('both the five-hour and the weekly allowance');
  });

  it('explains disabled starts on the schedule page', () => {
    const html = renderActivationSchedulePage({
      csrfToken: 'csrf',
      providers: [claudeProvider(false)],
      selectedProviderId: 'claude_code',
    });
    expect(html).toContain('Claude Code window starts are disabled');
  });
});
