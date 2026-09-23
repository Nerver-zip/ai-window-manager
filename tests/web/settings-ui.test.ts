import { describe, expect, it } from 'vitest';
import {
  previewTargetReset,
  renderActivationSchedulePage,
  renderSchedulePage,
  renderSettingsPage,
  renderSchedulePreview,
} from '../../src/web/settings-ui.js';
import { APP_JS } from '../../src/web/ui/chart-interactions.js';
import type { ProviderCapabilities, WindowSnapshot } from '../../src/domain/types.js';

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

    expect(html).toContain('Automatic starts allowed');
    expect(html).toContain('Automatic starts off');
    expect(html).toContain('May use provider quota when a window starts.');
    expect(html).not.toContain('Reported by provider');
    expect(html).not.toContain('official_supported');
    expect(html).not.toContain('consumesQuota');
  });

  it('renders human activation controls with hidden policy fields disabled', () => {
    const html = renderActivationSchedulePage({
      csrfToken,
      providers: [{ ...provider, windows: [windowWithDuration('exact')] }],
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
    expect(html).toContain('data-policy-fields="custom_schedule" hidden');
    expect(html).toContain('data-policy-fields="custom_schedule" hidden aria-hidden="true"');
    expect(html).toMatch(/<input disabled[^>]*name="times"/);
    expect(html).not.toContain('reasonCode');
    expect(html).not.toContain('exact confidence');
    expect(html).not.toContain('confidence');
    expect(html).toContain('Next scheduled start');
    expect(html).toContain('name="toleranceSeconds" value="900"');
    expect(html).not.toContain('Tolerance</label>');
  });

  it('ships progressive policy and one-time timezone detection behavior', () => {
    expect(APP_JS).toContain('[data-policy-form]');
    expect(APP_JS).toContain('control.disabled = !active');
    expect(APP_JS).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
    expect(APP_JS).toContain("select.dataset.timezoneAutoDetect !== 'true'");
    expect(APP_JS).toContain("select.value === 'custom'");
    expect(APP_JS).toContain('customInput.required = useCustom');
    expect(APP_JS).toContain("source.value = 'detected'");
    expect(APP_JS).toContain('[data-chart-range-select]');
    expect(APP_JS).toContain('form.requestSubmit()');
    expect(APP_JS).toContain('[data-refresh-preset]');

    const manualSettings = renderSettingsPage({
      csrfToken,
      providers: [],
      timezone: { timezone: 'America/Sao_Paulo', source: 'manual' },
    });
    expect(manualSettings).toContain('data-timezone-auto-detect="false"');
  });

  it('offers human-readable timezone choices and an advanced custom location field', () => {
    const preset = renderSettingsPage({
      csrfToken,
      providers: [],
      timezone: { timezone: 'America/Sao_Paulo', source: 'manual' },
    });
    expect(preset).toContain(
      '<option value="America/Sao_Paulo" selected>São Paulo / Brasília</option>',
    );
    expect(preset).toContain('name="timezoneChoice"');
    expect(preset).toContain('Another location…');
    expect(preset).toContain('placeholder="e.g. Europe/Madrid"');
    expect(preset).not.toContain('value="America/Sao_Paulo">America/Sao_Paulo</option>');

    const custom = renderSettingsPage({
      csrfToken,
      providers: [],
      timezone: { timezone: 'Europe/Madrid', source: 'manual' },
    });
    expect(custom).toContain('<details data-timezone-custom open>');
    expect(custom).toContain('value="Europe/Madrid" placeholder="e.g. Europe/Madrid"');
  });

  it('groups the provider settings heading for readable narrow layouts', () => {
    const html = renderSettingsPage({
      csrfToken,
      providers: [provider],
      timezone: { timezone: 'America/Sao_Paulo', source: 'manual' },
    });

    expect(html).toContain(
      '<div class="section-heading"><div class="heading-copy"><p class="eyebrow">Provider connection</p><h2 id="provider-settings-title">Connection and monitoring</h2></div>',
    );
  });

  it('explains missing or uncertain selected windows in human language', () => {
    const html = renderActivationSchedulePage({
      csrfToken,
      providers: [{ ...provider, windows: [windowWithDuration('exact')] }],
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
    expect(html).toContain('This provider cannot start a new window automatically.');

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
