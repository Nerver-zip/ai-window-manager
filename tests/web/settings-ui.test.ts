import { describe, expect, it } from 'vitest';
import {
  previewTargetReset,
  renderSchedulePage,
  renderSettingsPage,
  renderSchedulePreview,
} from '../../src/web/settings-ui.js';

const csrfToken = 'csrf-token-for-test';
const provider = {
  id: 'fake',
  kind: 'fake',
  enabled: true,
  mode: 'monitor_only' as const,
  pollIntervalSeconds: 30,
};

describe('settings UI helpers', () => {
  it('renders empty settings safely and preserves false/automation selections', () => {
    const empty = renderSettingsPage({ csrfToken, providers: [], notice: 'saved' });
    expect(empty).toContain('no providers configured');
    expect(empty).toContain('saved');

    const html = renderSettingsPage({
      csrfToken,
      providers: [{ ...provider, enabled: false, mode: 'automation' }],
    });
    expect(html).toContain('value="false" selected');
    expect(html).toContain('value="automation" selected');
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
  });

  it('renders explicit unknown schedule data instead of zero values', () => {
    const html = renderSchedulePage({
      csrfToken,
      providers: [],
      referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
    });

    expect(html).toContain('Next occurrence: <strong>unknown</strong>');
    expect(html).toContain('no providers configured');
    expect(html).not.toContain('1970-01-01');
    expect(html).toContain('name="csrfToken"');
  });

  it('renders persisted schedule fields and a resolved preview without validating or saving', () => {
    const html = renderSchedulePage({
      csrfToken,
      providers: [provider],
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
    expect(html).toContain('Resolution');
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
    expect(renderSchedulePreview(preview)).toContain('<strong>unknown</strong>');

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
    expect(html).toContain('Next occurrence: <strong>unknown</strong>');
  });
});
