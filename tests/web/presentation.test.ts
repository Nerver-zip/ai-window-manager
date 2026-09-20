import { describe, expect, it } from 'vitest';
import {
  capabilityDescription,
  capabilityContractLabel,
  capabilityLabel,
  confidenceLabel,
  durationLabel,
  effectiveModeLabel,
  errorLabel,
  eventLabel,
  evidenceLabel,
  factQualifier,
  healthLabel,
  humanizeIdentifier,
  isEstimatedSource,
  modeLabel,
  phaseLabel,
  providerDisplayName,
  reasonLabel,
  severityLabel,
  windowDisplayName,
} from '../../src/web/ui/presentation.js';

describe('human-facing presentation labels', () => {
  it.each([
    ['codex', undefined, 'Codex'],
    ['codex', 'other', 'Codex'],
    ['test-provider', 'fake', 'Test provider'],
    ['my_provider', 'custom', 'Custom'],
    ['', undefined, 'Provider'],
  ])('labels provider %s/%s as %s', (id, kind, expected) => {
    expect(providerDisplayName(id, kind)).toBe(expected);
  });

  it.each([
    ['codex', 'codex_primary', undefined, '5-hour window'],
    ['codex', 'codex_secondary', undefined, 'Weekly window'],
    ['fake', 'five_hour', undefined, '5-hour window'],
    ['fake', 'weekly', undefined, 'Weekly window'],
    ['fake', 'seven_day', undefined, 'Weekly window'],
    ['custom', 'anything', 18_000, '5-hour window'],
    ['custom', 'anything', 604_800, 'Weekly window'],
    ['custom', 'anything', 86_400, 'Usage window'],
  ])('labels window %s/%s as %s', (provider, kind, duration, expected) => {
    expect(windowDisplayName(provider, kind, duration)).toBe(expected);
  });

  it.each([
    ['official_supported', 'Reported by provider'],
    ['official_client_internal', 'Reported by provider'],
    ['observed', 'Observed'],
    ['inferred', 'Estimated'],
    ['estimated', 'Estimated'],
    ['manual', 'Set manually'],
    ['unknown', 'Not available'],
    ['future', 'Not available'],
  ])('labels evidence %s', (source, expected) => {
    expect(evidenceLabel(source)).toBe(expected);
  });

  it.each([
    ['exact', 'High confidence'],
    ['high', 'Good confidence'],
    ['medium', 'Limited confidence'],
    ['low', 'Low confidence'],
    ['unknown', 'Not available'],
    ['future', 'Not available'],
  ])('labels confidence %s', (confidence, expected) => {
    expect(confidenceLabel(confidence)).toBe(expected);
  });

  it('combines evidence and confidence without exposing internal names', () => {
    expect(factQualifier('official_client_internal', 'high')).toBe(
      'Reported by provider · Good confidence',
    );
    expect(isEstimatedSource('inferred')).toBe(true);
    expect(isEstimatedSource('estimated')).toBe(true);
    expect(isEstimatedSource('observed')).toBe(false);
  });

  it.each([
    ['UP', 'Connected'],
    ['DEGRADED', 'Needs attention'],
    ['AUTH_REQUIRED', 'Sign-in required'],
    ['UNAVAILABLE', 'Needs attention'],
    ['ERROR', 'Needs attention'],
    ['UNKNOWN', 'Waiting for first observation'],
    ['future', 'Needs attention'],
  ])('labels health %s', (health, expected) => {
    expect(healthLabel(health)).toBe(expected);
  });

  it.each([
    ['monitor_only', 'Monitoring only'],
    ['automation', 'Automatic actions enabled'],
    ['future', 'Monitoring only'],
  ])('labels mode %s', (mode, expected) => {
    expect(modeLabel(mode)).toBe(expected);
  });

  it.each([
    ['automation', true, 'Automatic actions enabled'],
    ['automation', false, 'Automatic actions unavailable'],
    ['automation', undefined, 'Monitoring only'],
    ['monitor_only', true, 'Monitoring only'],
  ] as const)('labels effective mode %s/%s', (mode, supported, expected) => {
    expect(effectiveModeLabel(mode, supported)).toBe(expected);
  });

  it.each([
    ['ACTIVE', 'Active'],
    ['INACTIVE', 'Inactive'],
    ['EXHAUSTED', 'Exhausted'],
    ['RESET_DUE', 'Ready to reset'],
    ['UNKNOWN', 'Not available'],
    ['future', 'Not available'],
  ])('labels phase %s', (phase, expected) => {
    expect(phaseLabel(phase)).toBe(expected);
  });

  it.each([
    ['provider_inspected', 'Provider checked'],
    ['provider_inspection_failed', 'Provider check failed'],
    ['provider_auth_required', 'Sign-in required'],
    ['action_intent_planned', 'Automatic action planned'],
    ['schedule_missed', 'Scheduled time missed'],
    ['scheduler_noop', 'Scheduling update'],
    ['future', 'Activity update'],
  ])('labels event %s', (event, expected) => {
    expect(eventLabel(event)).toBe(expected);
  });

  it('keeps scheduler explanations understandable', () => {
    expect(reasonLabel('TARGET_RESET_WINDOW_MATCH')).toBe(
      'The window can start before the target reset.',
    );
    expect(reasonLabel('OBSERVATION_STALE')).toContain('too old');
    expect(reasonLabel('TRIGGER_CAPABILITY_UNAVAILABLE')).toContain('unavailable');
    expect(reasonLabel('AUTOMATION_DISABLED')).toContain('turned off');
    expect(reasonLabel(null)).toBe('Not available');
    expect(reasonLabel('future')).toBe('No additional explanation is available.');
  });

  it.each([
    ['AUTH_REQUIRED', 'Sign-in is required in the official provider client.'],
    ['PROVIDER_UNAVAILABLE', 'The provider is temporarily unavailable.'],
    ['INSPECTION_FAILED', 'The latest provider check failed.'],
    ['INVALID_PROVIDER_RESPONSE', 'The provider returned data that could not be verified.'],
    [null, 'None'],
    ['future', 'The provider needs attention.'],
  ])('labels error %s', (error, expected) => {
    expect(errorLabel(error)).toBe(expected);
  });

  it.each([
    ['warn', 'Warning'],
    ['error', 'Needs attention'],
    ['debug', 'Details'],
    ['info', 'Info'],
    ['future', 'Info'],
  ])('labels severity %s', (severity, expected) => {
    expect(severityLabel(severity)).toBe(expected);
  });

  it.each([
    ['usageRead', 'Usage information'],
    ['resetRead', 'Reset time'],
    ['windowTrigger', 'Automatic actions'],
  ] as const)('labels capability %s', (capability, expected) => {
    expect(capabilityLabel(capability)).toBe(expected);
  });

  it.each([
    ['official_supported', 'Reported by provider'],
    ['official_client_internal', 'Reported by provider'],
    ['observed_undocumented', 'Provider behavior observed'],
    ['unknown', 'Support status not available'],
  ])('labels capability contract %s', (contract, expected) => {
    expect(capabilityContractLabel(contract)).toBe(expected);
  });

  it.each([
    ['usageRead', true, 'Usage information comes from the provider’s official client.'],
    ['resetRead', true, 'Reset time is shown when the provider reports it.'],
    [
      'windowTrigger',
      true,
      'The app may start a new window when the schedule and safety checks allow it.',
    ],
    ['usageRead', false, 'Usage information is not available from this provider.'],
    ['resetRead', false, 'The provider does not currently report reset times.'],
    ['windowTrigger', false, 'This provider cannot start a new usage window automatically.'],
  ] as const)(
    'describes capability %s/%s without implementation details',
    (capability, supported, expected) => {
      expect(capabilityDescription(capability, supported)).toBe(expected);
    },
  );

  it.each([
    [18_000, '5 hours'],
    [604_800, '7 days'],
    [172_800, '2 days'],
    [7_200, '2 hours'],
    [120, '2 minutes'],
    [17, '17 seconds'],
  ])('formats duration %s', (seconds, expected) => {
    expect(durationLabel(seconds)).toBe(expected);
  });

  it('humanizes safe identifiers and uses a fallback for empty values', () => {
    expect(humanizeIdentifier('some_window-kind', 'Fallback')).toBe('Some Window Kind');
    expect(humanizeIdentifier('   ', 'Fallback')).toBe('Fallback');
  });
});
