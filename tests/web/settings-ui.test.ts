import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import {
  previewTargetReset,
  renderActivationSchedulePage,
  renderScheduleHorizon,
  renderSchedulePage,
  renderSettingsPage,
  renderSchedulePreview,
} from '../../src/web/settings-ui.js';
import { APP_JS } from '../../src/web/ui/chart-interactions.js';
import type { ProviderCapabilities, WindowSnapshot } from '../../src/domain/types.js';
import type { AuthOnboardingStatus } from '../../src/web/ui/auth-onboarding.js';

const csrfToken = 'csrf-token-for-test';
const provider = {
  id: 'fake',
  kind: 'fake',
  enabled: true,
  mode: 'monitor_only' as const,
  pollIntervalSeconds: 30,
};

const supportedCapabilities: ProviderCapabilities = {
  usageRead: { supported: true, contract: 'official_supported' },
  resetRead: { supported: true, contract: 'official_supported' },
  windowTrigger: { supported: true, contract: 'official_supported', consumesQuota: true },
};

function windowWithDuration(
  confidence: NonNullable<WindowSnapshot['durationSeconds']>['confidence'],
): WindowSnapshot {
  const observedAt = '2026-09-19T15:00:00.000Z';
  return {
    providerId: 'fake',
    windowKind: 'five_hour',
    observedAt,
    phase: { value: 'INACTIVE', source: 'observed', confidence: 'exact', observedAt },
    durationSeconds: { value: 18_000, source: 'official_supported', confidence, observedAt },
  };
}

function authProvider(
  providerId: AuthOnboardingStatus['providerId'],
  state: AuthOnboardingStatus['state'],
  reasonCode: string | null = null,
) {
  return {
    providerId,
    status: {
      providerId,
      state,
      startedAt: null,
      expiresAt: null,
      authorizationUrl: null,
      userCode: null,
      requiresCodeSubmission: false,
      reasonCode,
    } satisfies AuthOnboardingStatus,
  };
}

describe('settings UI helpers', () => {
  it('renders empty settings safely and preserves false/automation selections', () => {
    const empty = renderSettingsPage({ csrfToken, providers: [], notice: 'saved' });
    expect(empty).toContain('No providers configured');
    expect(empty).toContain('saved');

    const html = renderSettingsPage({
      csrfToken,
      providers: [
        { ...provider, enabled: false, mode: 'automation', capabilities: supportedCapabilities },
        {
          id: 'codex',
          kind: 'codex',
          enabled: true,
          mode: 'monitor_only',
          pollIntervalSeconds: 30,
        },
      ],
    });
    expect(html).toContain('value="false" selected');
    expect(html).toContain('value="automation" selected');
    expect(html).toContain('What this provider can do');
    expect(html).toContain('/assets/images/providers/codex.png');
  });

  it('shows concise provider capabilities and distinguishes allowed starts from active starts', () => {
    const html = renderSettingsPage({
      csrfToken,
      providers: [
        { ...provider, mode: 'automation', capabilities: supportedCapabilities },
        {
          ...provider,
          id: 'codex',
          kind: 'codex',
          mode: 'monitor_only',
          capabilities: supportedCapabilities,
        },
      ],
    });

    expect(html).toContain('Off (monitoring only)');
    expect(html).toContain('On (auto-start allowed)');
    expect(html).toContain('Automatic window start');
    expect(html).toContain('May use provider quota when a window starts.');
    expect(html).not.toContain('Reported by provider');
    expect(html).not.toContain('official_supported');
    expect(html).not.toContain('consumesQuota');
  });

  it('unifies provider connection and settings, gating controls until sign-in succeeds', () => {
    const html = renderSettingsPage({
      csrfToken,
      providers: [
        {
          ...provider,
          id: 'codex',
          kind: 'codex',
          configured: false,
          connectionLabel: 'Sign in to connect',
        },
        {
          ...provider,
          id: 'antigravity',
          kind: 'antigravity',
          configured: true,
          connectionLabel: 'Connected',
        },
      ],
      authProviders: [
        authProvider('codex', 'FAILED', 'AUTH_REQUIRED'),
        authProvider('antigravity', 'SUCCEEDED'),
      ],
    });
    const cards = html.match(/<article class="card provider-settings"[\s\S]*?<\/article>/g) ?? [];

    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('Sign-in required');
    expect(cards[0]).toContain('Connect Codex');
    expect(cards[0]).toContain('Sign in with OpenAI to start tracking your usage windows.');
    expect(cards[0]).toContain('data-provider-settings-form hidden');
    expect(cards[0]).toContain('data-provider-monitoring-note>Connect your account');
    expect(cards[1]).toContain('Connected');
    expect(cards[1]).toContain('Reconnect account');
    expect(cards[1]).toContain('Reconnect Antigravity');
    expect(cards[1]).toContain('data-provider-settings-form>');
    expect(cards[1]).not.toContain('data-provider-settings-form hidden');
    expect(html).toContain('Time Zone');
    expect(html).toContain('Schedules and window resets are displayed in this time zone.');
    expect(html).toContain('Manage connected accounts and update frequencies.');
    expect(html).not.toContain('Provider accounts');
    expect(html).not.toContain('Official sign-in');
    expect(html).not.toContain('never asks for your password or tokens');
    expect(html).not.toContain('Paused providers keep their saved history');
  });

  it('renders accessible start-pattern cards and keeps inactive fields unavailable', () => {
    const html = renderActivationSchedulePage({
      csrfToken,
      providers: [{ ...provider, configured: true, windows: [windowWithDuration('exact')] }],
      policy: {
        id: 'activation-fake',
        providerId: 'fake',
        kind: 'fixed',
        enabled: true,
        timezone: 'America/Sao_Paulo',
        windowKind: 'five_hour',
        anchorLocalTime: '18:00',
        toleranceSeconds: 900,
        updatedAtMs: Date.parse('2026-09-19T12:00:00.000Z'),
      },
      timezone: { timezone: 'America/Sao_Paulo', source: 'manual' },
      currentWindow: {
        providerId: 'fake',
        status: 'INACTIVE',
        windowKind: 'five_hour',
        observedAt: '2026-09-19T15:00:00.000Z',
        confidence: 'exact',
      },
    });

    expect(html).toContain('Current window');
    expect(html).toContain('Usage right now');
    expect(html).toContain('Available');
    expect(html).not.toContain('Inactive');
    expect(html).toContain('Cycle start time');
    expect(html).toContain('name="policyKind" value="fixed" checked');
    expect(html).toContain('Whenever possible');
    expect(html).toContain('At specific times');
    expect(html).toContain('Only when I ask');
    expect(html).not.toContain('data-policy-kind');
    expect(html.match(/name="policyKind"/g)).toHaveLength(5);
    expect(html).toContain('data-policy-fields="custom_schedule" hidden');
    expect(html).toContain('data-policy-fields="custom_schedule" hidden aria-hidden="true"');
    expect(html).toMatch(/<input disabled[^>]*name="times"/);
    expect(html).not.toContain('reasonCode');
    expect(html).not.toContain('exact confidence');
    expect(html).not.toContain('confidence');
    expect(html).toContain('Your schedule at a glance');
    expect(html).toContain('role="img" aria-label="24-hour schedule view.');
    expect(html).toContain('name="toleranceSeconds" value="900"');
    expect(html).not.toContain('Tolerance</label>');
  });

  it('ships progressive policy, preview, and non-persisting timezone detection behavior', () => {
    expect(APP_JS).toContain('[data-policy-form]');
    expect(APP_JS).toContain('control.disabled = !active');
    expect(APP_JS).toContain('form.querySelector(\'[name="policyKind"]:checked\')?.value');
    expect(APP_JS).toContain("fetch('/schedule/preview?' + query.toString()");
    expect(APP_JS).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
    expect(APP_JS).toContain("select.dataset.timezoneAutoDetect !== 'true'");
    expect(APP_JS).toContain("source.value = 'detected'");
    expect(APP_JS).not.toContain("method: 'POST'");
    expect(APP_JS).not.toContain('customTimezone');
    expect(APP_JS).toContain('[data-chart-range-select]');
    expect(APP_JS).toContain('[data-provider-picker-auto-submit]');
    expect(APP_JS).toContain('form.requestSubmit()');
    expect(APP_JS).toContain('[data-refresh-preset]');
    expect(() => new Script(APP_JS)).not.toThrow();
    expect(new TextEncoder().encode(APP_JS).length).toBeLessThan(15 * 1024);

    const manualSettings = renderSettingsPage({
      csrfToken,
      providers: [],
      timezone: { timezone: 'America/Sao_Paulo', source: 'manual' },
    });
    expect(manualSettings).toContain('data-timezone-auto-detect="false"');
  });

  it('offers grouped timezone choices with offsets and preserves a saved unlisted zone', () => {
    const preset = renderSettingsPage({
      csrfToken,
      providers: [],
      timezone: { timezone: 'America/Sao_Paulo', source: 'manual' },
    });
    expect(preset).toContain(
      '<option value="America/Sao_Paulo" selected>São Paulo (UTC-03:00)</option>',
    );
    expect(preset).toContain('name="timezoneChoice"');
    expect(preset).toContain('<optgroup label="Americas">');
    expect(preset).toContain('<optgroup label="Europe">');
    expect(preset).toContain('<optgroup label="Asia">');
    expect(preset).not.toContain('customTimezone');
    expect(preset).not.toContain('Another location…');

    const custom = renderSettingsPage({
      csrfToken,
      providers: [],
      timezone: { timezone: 'Pacific/Marquesas', source: 'manual' },
    });
    expect(custom).toContain(
      '<optgroup label="Saved location"><option value="Pacific/Marquesas" selected>Pacific/Marquesas (UTC-09:30)</option></optgroup>',
    );
    expect(custom).not.toContain('type="text"');

    const firstVisit = renderSettingsPage({ csrfToken, providers: [] });
    expect(firstVisit).toContain('data-timezone-auto-detect="true"');
    expect(firstVisit).toContain('data-timezone-status aria-live="polite"');
  });

  it('groups the provider settings heading for readable narrow layouts', () => {
    const html = renderSettingsPage({
      csrfToken,
      providers: [provider],
      timezone: { timezone: 'America/Sao_Paulo', source: 'manual' },
    });

    expect(html).toContain(
      '<div class="section-heading"><div class="heading-copy"><p class="eyebrow">Accounts</p><h2 id="provider-settings-title">Providers</h2><p class="muted">Manage connected accounts and update frequencies.</p></div></div>',
    );
  });

  it('explains missing or uncertain selected windows in human language', () => {
    const html = renderActivationSchedulePage({
      csrfToken,
      providers: [{ ...provider, configured: true, windows: [windowWithDuration('exact')] }],
      policy: {
        id: 'activation-fake',
        providerId: 'fake',
        kind: 'fixed',
        enabled: true,
        timezone: 'UTC',
        windowKind: 'weekly',
        anchorLocalTime: '18:00',
        toleranceSeconds: 900,
        updatedAtMs: 1,
      },
      timezone: { timezone: 'UTC', source: 'manual' },
      currentWindow: {
        providerId: 'fake',
        status: 'UNKNOWN',
        windowKind: 'weekly',
        confidence: 'unknown',
        reason: 'WINDOW_NOT_REPORTED',
      },
      decision: {
        kind: 'WAIT',
        reasonCode: 'WINDOW_NOT_REPORTED',
        explanation: {
          decision: 'WAIT',
          reasonCode: 'WINDOW_NOT_REPORTED',
          providerId: 'fake',
          policyId: 'activation-fake',
          policyKind: 'fixed',
          timezone: 'UTC',
          currentWindow: 'UNKNOWN',
        },
      },
    });

    expect(html).toContain('The selected usage window is not reported by this provider.');
  });

  it('renders only safe fields with hidden CSRF inputs and escaped values', () => {
    const html = renderSettingsPage({
      csrfToken,
      providers: [{ ...provider, id: 'fake<&' }],
      notice: '<script>bad</script>',
    });

    expect(html).toContain('name="csrfToken"');
    expect(html).toContain('action="/settings/providers/fake%3C%26"');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).toContain('name="refreshIntervalPreset"');
    expect(html).toContain('Every 5 minutes');
    expect(html).toContain('name="customPollIntervalSeconds"');
    expect(html).not.toContain('account/rateLimits/read');
    expect(html).not.toContain('AWM_CODEX_TRIGGER_ENABLED');
    expect(html).not.toContain('apiKey');
    expect(html).not.toContain('<script>bad</script>');
    expect(html).toContain('href="/assets/app.css"');
    expect(html).not.toContain('<style>');
    expect(html).not.toContain('<script>');
  });

  it('fails closed for automation when trigger support is absent or unknown', () => {
    const unsupported: ProviderCapabilities = {
      ...supportedCapabilities,
      windowTrigger: {
        supported: false,
        contract: 'unknown',
        consumesQuota: 'unknown',
      },
    };
    const html = renderSettingsPage({
      csrfToken,
      providers: [{ ...provider, capabilities: unsupported }],
    });
    expect(html).toContain('value="automation" disabled');
    expect(html).toContain('Automatic starts are not available for this provider.');

    const unknown = renderSettingsPage({ csrfToken, providers: [provider] });
    expect(unknown).toContain('We could not check this provider yet');
    expect(unknown).toContain('value="automation" disabled');
  });

  it('renders explicit unknown schedule data instead of zero values', () => {
    const html = renderSchedulePage({
      csrfToken,
      providers: [],
      referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
    });

    expect(html).toContain('Preview unavailable');
    expect(html).toContain('No providers configured');
    expect(html).not.toContain('1970-01-01');
    expect(html).toContain('name="csrfToken"');
  });

  it('renders persisted schedule fields and a resolved preview without validating or saving', () => {
    const html = renderSchedulePage({
      csrfToken,
      providers: [
        {
          ...provider,
          capabilities: supportedCapabilities,
          windows: [windowWithDuration('exact')],
        },
      ],
      policy: {
        enabled: true,
        providerId: 'fake',
        windowKind: 'five_hour',
        targetResetLocalTime: '13:00',
        timezone: 'America/Sao_Paulo',
        toleranceSeconds: 30,
      },
      referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
    });

    expect(html).toContain('value="five_hour"');
    expect(html).toContain('value="America/Sao_Paulo"');
    expect(html).not.toContain('2026-09-19T16:00:00.000Z');
    expect(html).toContain('Planned start');
    expect(html).toContain('08:00');
    expect(html).toContain('5 hours');
    expect(html).toContain('data-resolution="exact"');
  });

  it('labels a supported enabled automation provider as eligible', () => {
    const html = renderSchedulePage({
      csrfToken,
      providers: [
        {
          ...provider,
          mode: 'automation',
          capabilities: supportedCapabilities,
          windows: [windowWithDuration('exact')],
        },
      ],
      policy: {
        enabled: true,
        providerId: 'fake',
        windowKind: 'five_hour',
        targetResetLocalTime: '13:00',
        timezone: 'America/Sao_Paulo',
        toleranceSeconds: 30,
      },
      referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
    });

    expect(html).toContain('Automatic actions available');
    expect(html).not.toContain('automation ready');
  });

  it('renders a 24-hour schedule timeline, projected coverage and the next milestones', () => {
    const referenceInstant = new Date('2026-09-19T11:00:00.000Z');
    const html = renderScheduleHorizon({
      policy: {
        id: 'activation-fake',
        providerId: 'fake',
        kind: 'custom_schedule',
        enabled: true,
        timezone: 'America/Sao_Paulo',
        windowKind: 'five_hour',
        times: ['09:00', '14:00'],
        toleranceSeconds: 900,
        updatedAtMs: referenceInstant.getTime(),
      },
      provider: { ...provider, windows: [windowWithDuration('exact')], staleAfterSeconds: 300 },
      currentWindow: {
        providerId: 'fake',
        status: 'ACTIVE',
        windowKind: 'five_hour',
        observedAt: '2026-09-19T10:59:00.000Z',
        confidence: 'exact',
        expectedEndAt: {
          value: '2026-09-19T15:00:00.000Z',
          source: 'official_supported',
          confidence: 'exact',
          observedAt: '2026-09-19T10:59:00.000Z',
        },
      },
      referenceInstant,
      timezone: 'America/Sao_Paulo',
    });
    expect(html).toContain(
      'role="img" aria-label="24-hour schedule view. A fresh provider update reports a window in use.',
    );
    expect(html).toContain('class="horizon-current"');
    expect(html).toContain('class="horizon-projected"');
    expect(html).toContain('Scheduled start opportunity');
    expect(html).toContain('Expected current-window reset');
    expect(html).toContain('Next milestones');
    expect(html).toContain('08:00');
  });

  it('does not project stale active state or manual starts on the schedule horizon', () => {
    const horizon = renderScheduleHorizon({
      policy: {
        id: 'activation-fake',
        providerId: 'fake',
        kind: 'manual',
        enabled: true,
        timezone: 'UTC',
        updatedAtMs: 1,
      },
      provider: { ...provider, staleAfterSeconds: 30 },
      currentWindow: {
        providerId: 'fake',
        status: 'ACTIVE',
        observedAt: '2026-09-19T10:00:00.000Z',
        confidence: 'exact',
        expectedEndAt: {
          value: '2026-09-19T17:00:00.000Z',
          source: 'observed',
          confidence: 'exact',
          observedAt: '2026-09-19T10:00:00.000Z',
        },
      },
      referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
      timezone: 'UTC',
    });
    expect(horizon).not.toContain('class="horizon-current"');
    expect(horizon).not.toContain('class="horizon-projected"');
    expect(horizon).toContain('No automatic start is scheduled.');
    expect(horizon).toContain('too old to project');
  });

  it('renders paired active-hour controls and workday/evening presets', () => {
    const html = renderActivationSchedulePage({
      csrfToken,
      providers: [{ ...provider, configured: true, windows: [windowWithDuration('exact')] }],
      policy: {
        id: 'activation-fake',
        providerId: 'fake',
        kind: 'active_hours',
        enabled: true,
        timezone: 'America/Sao_Paulo',
        windowKind: 'five_hour',
        periods: [{ start: '08:00', end: '18:00' }],
        updatedAtMs: 1,
      },
      timezone: { timezone: 'America/Sao_Paulo', source: 'manual' },
      referenceInstant: new Date('2026-09-19T11:00:00.000Z'),
    });
    expect(html).toContain('name="periodStarts" type="time" value="08:00"');
    expect(html).toContain('name="periodEnds" type="time" value="18:00"');
    expect(html).toContain('data-period-preset-start="08:00" data-period-preset-end="18:00"');
    expect(html).toContain('data-period-preset-start="13:00" data-period-preset-end="22:00"');
    expect(html).toContain('class="horizon-active-hours"');
    expect(html).toContain('Chosen active hours');
    expect(html).toContain('name="providerId" value="fake" checked required');
    expect(html).toContain('Connected');
  });

  it('renders a safe fallback without a provider or saved policy', () => {
    const html = renderActivationSchedulePage({ csrfToken, providers: [] });
    expect(html).toContain('No providers configured');
    expect(html).toContain('class="provider-picker"');
    expect(html).toContain('Select a provider to see the current observed window.');
    expect(html).toContain('Choose a time zone in Settings before enabling a time-based policy.');
    expect(html).toContain('No automatic start is scheduled.');
    expect(html).toContain('No start can be planned until usage data is available.');
  });

  it('renders removable daily time chips and the honest auto-policy preview', () => {
    const daily = renderActivationSchedulePage({
      csrfToken,
      providers: [{ ...provider, windows: [windowWithDuration('exact')] }],
      policy: {
        id: 'activation-fake',
        providerId: 'fake',
        kind: 'custom_schedule',
        enabled: true,
        timezone: 'America/Sao_Paulo',
        windowKind: 'five_hour',
        times: ['09:00', '14:00'],
        toleranceSeconds: 900,
        updatedAtMs: 1,
      },
      timezone: { timezone: 'America/Sao_Paulo', source: 'manual' },
      referenceInstant: new Date('2026-09-19T10:00:00.000Z'),
    });
    expect(daily).toContain('class="dynamic-list-item time-chip"');
    expect(daily).toContain('Morning <span>09:00</span>');
    expect(daily).toContain('Afternoon <span>14:00</span>');
    expect(daily).toContain('Evening <span>18:00</span>');

    const automatic = renderScheduleHorizon({
      policy: {
        id: 'activation-fake',
        providerId: 'fake',
        kind: 'auto',
        enabled: true,
        timezone: 'UTC',
        updatedAtMs: 1,
      },
      provider,
      currentWindow: { providerId: 'fake', status: 'UNKNOWN', confidence: 'unknown' },
      referenceInstant: new Date('2026-09-19T10:00:00.000Z'),
      timezone: 'UTC',
    });
    expect(automatic).toContain(
      'A start may happen when a fresh update confirms a new window is available.',
    );
  });

  it('handles overnight active hours across DST and paused schedules without fake projections', () => {
    const now = new Date('2024-03-10T06:30:00.000Z');
    const overnight = renderScheduleHorizon({
      policy: {
        id: 'activation-fake',
        providerId: 'fake',
        kind: 'active_hours',
        enabled: true,
        timezone: 'America/New_York',
        windowKind: 'five_hour',
        periods: [{ start: '22:00', end: '02:00' }],
        updatedAtMs: now.getTime(),
      },
      provider: { ...provider, staleAfterSeconds: 300 },
      currentWindow: {
        providerId: 'fake',
        status: 'ACTIVE',
        observedAt: now.toISOString(),
        confidence: 'exact',
        expectedEndAt: {
          value: '2024-03-10T08:00:00.000Z',
          source: 'inferred',
          confidence: 'low',
          observedAt: now.toISOString(),
        },
      },
      referenceInstant: now,
      timezone: 'America/New_York',
    });
    expect(overnight).toContain('class="horizon-active-hours"');
    expect(overnight).toContain('Chosen active hours');
    expect(overnight).not.toContain('Expected current-window reset');
    expect(overnight).toContain('A fresh provider update reports a window in use.');

    const paused = renderScheduleHorizon({
      policy: {
        id: 'activation-fake',
        providerId: 'fake',
        kind: 'fixed',
        enabled: false,
        timezone: 'UTC',
        windowKind: 'five_hour',
        anchorLocalTime: '08:00',
        toleranceSeconds: 900,
        updatedAtMs: 1,
      },
      provider,
      currentWindow: { providerId: 'fake', status: 'INACTIVE', confidence: 'exact' },
      referenceInstant: new Date('2026-09-19T11:00:00.000Z'),
      timezone: 'UTC',
    });
    expect(paused).toContain('This schedule is paused.');
    expect(paused).not.toContain('horizon-projected');
  });
});

describe('schedule preview', () => {
  it('uses the scheduler resolver for an exact Sao Paulo occurrence', () => {
    const preview = previewTargetReset({
      localTime: '13:00',
      timeZone: 'America/Sao_Paulo',
      referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
    });

    expect(preview).toMatchObject({
      status: 'resolved',
      instantIso: '2026-09-19T16:00:00.000Z',
      resolution: 'exact',
    });
    expect(renderSchedulePreview(preview)).not.toContain('2026-09-19T16:00:00.000Z');
    expect(renderSchedulePreview(preview)).toContain('No time adjustment was needed.');
  });

  it.each([
    {
      label: 'forward gap',
      localTime: '02:30',
      timeZone: 'America/New_York',
      referenceInstant: '2024-03-10T12:00:00.000Z',
      resolution: 'nonexistent_shifted_to_next_valid',
    },
    {
      label: 'fall-back ambiguity',
      localTime: '01:30',
      timeZone: 'America/New_York',
      referenceInstant: '2024-11-03T12:00:00.000Z',
      resolution: 'ambiguous_earlier',
    },
  ])('labels $label in the preview', (input) => {
    const preview = previewTargetReset({
      ...input,
      referenceInstant: new Date(input.referenceInstant),
    });
    expect(preview.status).toBe('resolved');
    expect(preview.resolution).toBe(input.resolution);
    expect(renderSchedulePreview(preview)).toContain(input.resolution);
  });

  it('fails closed to unknown for invalid preview input', () => {
    const preview = previewTargetReset({
      localTime: 'not-time',
      timeZone: 'Not/Iana',
      referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
    });

    expect(preview).toMatchObject({ status: 'unknown', instantIso: null, resolution: null });
    expect(renderSchedulePreview(preview)).toContain('Preview unavailable');

    expect(
      previewTargetReset({
        localTime: '',
        timeZone: 'Not/Iana',
        referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
      }),
    ).toMatchObject({ requestedLocalTime: null });
  });

  it('shows unknown preview when a policy is only partially configured', () => {
    const html = renderSchedulePage({
      csrfToken,
      providers: [provider],
      policy: { targetResetLocalTime: '13:00' },
      referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
    });
    expect(html).toContain('Preview unavailable');
  });

  it('withholds a trigger candidate when duration confidence is too low', () => {
    const html = renderSchedulePage({
      csrfToken,
      providers: [{ ...provider, windows: [windowWithDuration('medium')] }],
      policy: {
        providerId: 'fake',
        windowKind: 'five_hour',
        targetResetLocalTime: '13:00',
        timezone: 'America/Sao_Paulo',
      },
      referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
    });
    expect(html).toContain(
      'The start time will appear when the window duration is reliable enough.',
    );
    expect(html).not.toContain('08:00');
  });
});
