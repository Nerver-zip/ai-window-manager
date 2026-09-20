import { describe, expect, it } from 'vitest';
import {
  previewTargetReset,
  renderSchedulePage,
  renderSettingsPage,
  renderSchedulePreview,
} from '../../src/web/settings-ui.js';
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
      ],
    });
    expect(html).toContain('value="false" selected');
    expect(html).toContain('value="automation" selected');
    expect(html).toContain('Capability summary');
  });

  it('renders only safe fields with hidden CSRF inputs and escaped values', () => {
    const html = renderSettingsPage({
      csrfToken,
      providers: [{ ...provider, id: 'fake<&' }],
      notice: '<script>bad</script>',
    });

    expect(html).toContain('name="csrfToken"');
    expect(html).toContain('fake&lt;&amp;');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).toContain('name="pollIntervalSeconds"');
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
    expect(html).toContain('does not advertise a supported trigger capability');

    const unknown = renderSettingsPage({ csrfToken, providers: [provider] });
    expect(unknown).toContain('Capability data is unavailable');
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
    expect(html).toContain('2026-09-19T16:00:00.000Z');
    expect(html).toContain('Candidate trigger');
    expect(html).toContain('08:00');
    expect(html).toContain('5h window');
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

    expect(html).toContain('Automation eligible');
    expect(html).toContain('automation ready');
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
    expect(renderSchedulePreview(preview)).toContain('2026-09-19T16:00:00.000Z');
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
    expect(html).toContain('Candidate withheld');
    expect(html).not.toContain('08:00');
  });
});
