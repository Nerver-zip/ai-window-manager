const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  codex: 'Codex',
  fake: 'Test provider',
  antigravity: 'Antigravity',
  agy: 'Antigravity',
};

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: '5-hour window',
  weekly: 'Weekly window',
  seven_day: 'Weekly window',
};

const EVIDENCE_LABELS: Readonly<Record<string, string>> = {
  official_supported: 'Reported by provider',
  official_client_internal: 'Reported by provider',
  observed: 'Observed',
  inferred: 'Estimated',
  estimated: 'Estimated',
  manual: 'Set manually',
  unknown: 'Not available',
};

const CONFIDENCE_LABELS: Readonly<Record<string, string>> = {
  exact: 'High confidence',
  high: 'Good confidence',
  medium: 'Limited confidence',
  low: 'Low confidence',
  unknown: 'Not available',
};

const HEALTH_LABELS: Readonly<Record<string, string>> = {
  UP: 'Connected',
  DEGRADED: 'Needs attention',
  AUTH_REQUIRED: 'Sign-in required',
  UNAVAILABLE: 'Needs attention',
  ERROR: 'Needs attention',
  UNKNOWN: 'Waiting for first observation',
};

const MODE_LABELS: Readonly<Record<string, string>> = {
  monitor_only: 'Monitoring only',
  automation: 'Automatic actions enabled',
};

const PHASE_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  EXHAUSTED: 'Exhausted',
  RESET_DUE: 'Ready to reset',
  UNKNOWN: 'Not available',
};

const EVENT_LABELS: Readonly<Record<string, string>> = {
  action_claimed: 'Automatic action started',
  action_confirmed: 'Automatic action confirmed',
  action_dispatch_started: 'Automatic action started',
  action_failed_retryable: 'Automatic action will retry',
  action_failed_terminal: 'Automatic action failed',
  action_intent_planned: 'Automatic action planned',
  action_intent_claimed: 'Automatic action started',
  action_recovery_confirmed: 'Automatic action confirmed',
  action_recovery_started: 'Checking a previous automatic action',
  action_skipped: 'Automatic action skipped',
  action_succeeded: 'Automatic action completed',
  action_uncertain: 'Automatic action needs review',
  inspect_requested: 'Usage check requested',
  manual_trigger_rejected: 'Manual start not sent',
  manual_trigger_requested: 'Manual start requested',
  provider_settings_updated: 'Provider settings updated',
  provider_inspected: 'Provider checked',
  provider_inspection_failed: 'Provider check failed',
  provider_auth_required: 'Sign-in required',
  schedule_missed: 'Scheduled time missed',
  schedule_policy_updated: 'Schedule updated',
  scheduler_noop: 'Scheduling update',
  settings_changed: 'Settings updated',
  schedule_changed: 'Schedule updated',
  unexpected_reset_detected: 'Reset detected',
  external_window_started: 'Window started outside the app',
  timezone_updated: 'Time zone updated',
  schedule_policy_invalid: 'Schedule needs attention',
};

const EVENT_REASON_LABELS: Readonly<Record<string, string>> = {
  action_claimed: 'The scheduled start was sent to the provider.',
  action_confirmed: 'A fresh provider update confirmed the new window.',
  action_dispatch_started: 'The provider is processing the scheduled start.',
  action_failed_retryable: 'The start did not complete. A safe retry may be attempted.',
  action_failed_terminal: 'The start could not be completed. Review the provider status.',
  action_intent_claimed: 'The schedule reserved this start before contacting the provider.',
  action_intent_planned: 'A new window is planned according to your schedule.',
  action_recovery_confirmed: 'A fresh check confirmed the new window after restart.',
  action_recovery_started: 'The app is checking whether an earlier start completed.',
  action_skipped: 'This start was skipped because it was no longer safe to run.',
  action_succeeded: 'The provider accepted the request; a fresh update will confirm the result.',
  action_uncertain:
    'The result could not be confirmed. The app will not send the request again automatically.',
  external_window_started: 'A new usage window started outside this app.',
  inspect_requested: 'The app was asked to check for updated usage information.',
  manual_trigger_rejected: 'A manual start was not sent because its safety checks did not pass.',
  manual_trigger_requested: 'A manual request to start a new window was received.',
  provider_auth_required: 'Sign in with the provider’s official app to resume updates.',
  provider_inspection_failed:
    'The latest usage check failed. The last saved reading is kept until a fresh check succeeds.',
  provider_settings_updated: 'Your provider settings were saved.',
  schedule_changed: 'Your schedule was updated.',
  schedule_missed: 'The planned time passed. No late start was sent.',
  schedule_policy_updated: 'Your schedule settings were saved.',
  schedule_policy_invalid: 'Review your schedule to resume automatic starts.',
  settings_changed: 'Your settings were updated.',
  unexpected_reset_detected: 'The provider reported a changed reset time.',
  timezone_updated: 'Your time zone was updated.',
};

const REASON_LABELS: Readonly<Record<string, string>> = {
  TARGET_RESET_WINDOW_MATCH: 'The window can start before the target reset.',
  TARGET_NOT_DUE: 'It is not time yet.',
  TARGET_MISSED: 'The planned time has passed, so nothing was started unexpectedly.',
  WINDOW_DURATION_UNKNOWN: 'The window duration is not available yet.',
  WINDOW_DURATION_CONFIDENCE_TOO_LOW: 'The window duration is not reliable enough yet.',
  WINDOW_PHASE_CONFIDENCE_TOO_LOW: 'The window state is not reliable enough yet.',
  WINDOW_NOT_INACTIVE: 'The current window is still active.',
  OBSERVATION_STALE: 'The saved data is too old to safely plan an action.',
  OBSERVATION_MISSING: 'Waiting for the first valid provider update.',
  WINDOW_NOT_REPORTED: 'The selected usage window was not reported by the provider.',
  TRIGGER_CAPABILITY_UNAVAILABLE: 'Automatic action is unavailable for this provider.',
  AUTOMATION_DISABLED: 'Monitoring is enabled, but automatic actions are turned off.',
  POLICY_DISABLED: 'This activation policy is turned off.',
  MANUAL_POLICY: 'New windows are started only by you.',
  MONITORING_UNAVAILABLE: 'Provider monitoring is unavailable.',
  CURRENT_WINDOW_ACTIVE: 'A usage window is already active.',
  SCHEDULED_ANCHOR: 'A scheduled activation time is ready.',
  ANCHOR_NOT_DUE: 'The next scheduled activation time has not arrived.',
  ANCHOR_SKIPPED_ACTIVE_WINDOW: 'A window was already active at the scheduled time.',
  ANCHOR_EXPIRED: 'The scheduled activation time has passed.',
  NEXT_ANCHOR: 'Waiting for the next scheduled activation time.',
  ACTION_ALREADY_PENDING: 'An activation is already waiting for this schedule.',
  ACTIVE_HOURS_COVERAGE: 'The active-hours period has enough time remaining.',
  ACTIVE_HOURS_TOO_SHORT: 'There is not enough active time left to start a full window.',
  AUTO_WINDOW_AVAILABLE: 'The provider is ready for an automatic activation.',
  INVALID_ACTIVATION_POLICY: 'The saved activation policy needs attention.',
};

const ERROR_LABELS: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: 'Sign-in is required in the official provider client.',
  PROVIDER_UNAVAILABLE: 'The provider is temporarily unavailable.',
  INSPECTION_FAILED: 'The latest provider check failed.',
  INVALID_PROVIDER_RESPONSE: 'The provider returned data that could not be verified.',
};

export function providerDisplayName(id: string, kind?: string): string {
  const key = kind === 'codex' || id === 'codex' ? 'codex' : kind === 'fake' ? 'fake' : id;
  return PROVIDER_LABELS[key] ?? humanizeIdentifier(kind ?? id, 'Provider');
}

export function providerLogoUrl(id: string, kind?: string): string | undefined {
  const normalized = (kind ?? id).trim().toLowerCase();
  if (normalized === 'codex') return '/assets/images/providers/codex.png';
  if (normalized === 'agy' || normalized === 'antigravity')
    return '/assets/images/providers/agy.png';
  return undefined;
}

export function timeZoneDisplayName(timeZone: string): string {
  if (!timeZone) return 'Local time';
  if (timeZone === 'UTC' || timeZone.endsWith('/UTC')) return 'UTC';
  const city = timeZone.split('/').filter(Boolean).at(-1)?.replaceAll('_', ' ');
  if (!city) return 'Local time';
  return city.replace(/\b\w/g, (character) => character.toUpperCase()).replace(/^Sao /, 'São ');
}

export function windowDisplayName(
  providerId: string,
  windowKind: string,
  durationSeconds?: number,
): string {
  const providerWindow =
    providerId === 'codex' && windowKind.endsWith('_primary')
      ? 'five_hour'
      : providerId === 'codex' && windowKind.endsWith('_secondary')
        ? 'weekly'
        : windowKind;
  if (WINDOW_LABELS[providerWindow]) return WINDOW_LABELS[providerWindow];
  if (durationSeconds === 18_000) return '5-hour window';
  if (durationSeconds === 604_800) return 'Weekly window';
  return 'Usage window';
}

export function evidenceLabel(source: string): string {
  return EVIDENCE_LABELS[source] ?? 'Not available';
}

export function confidenceLabel(confidence: string): string {
  return CONFIDENCE_LABELS[confidence] ?? 'Not available';
}

export function factQualifier(source: string, confidence: string): string {
  return `${evidenceLabel(source)} · ${confidenceLabel(confidence)}`;
}

export function isEstimatedSource(source: string): boolean {
  return source === 'inferred' || source === 'estimated';
}

export function healthLabel(health: string): string {
  return HEALTH_LABELS[health] ?? 'Needs attention';
}

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? 'Monitoring only';
}

export function effectiveModeLabel(mode: string, triggerSupported: boolean | undefined): string {
  if (mode === 'automation' && triggerSupported === true) return 'Automatic actions enabled';
  if (mode === 'automation' && triggerSupported === false) return 'Automatic actions unavailable';
  return 'Monitoring only';
}

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? 'Not available';
}

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? 'Activity update';
}

export function reasonLabel(reason: string | null): string {
  return reason
    ? (REASON_LABELS[reason] ?? 'No additional explanation is available.')
    : 'Not available';
}

export function eventReasonLabel(type: string, reasonCode: string | null): string {
  if (reasonCode && Object.hasOwn(REASON_LABELS, reasonCode)) return REASON_LABELS[reasonCode]!;
  return EVENT_REASON_LABELS[type] ?? 'More details are not available for this update.';
}

export function errorLabel(error: string | null): string {
  return error ? (ERROR_LABELS[error] ?? 'The provider needs attention.') : 'None';
}

export function severityLabel(severity: string): string {
  switch (severity) {
    case 'warn':
      return 'Warning';
    case 'error':
      return 'Needs attention';
    case 'debug':
      return 'Details';
    default:
      return 'Info';
  }
}

export function capabilityLabel(capability: 'usageRead' | 'resetRead' | 'windowTrigger'): string {
  switch (capability) {
    case 'usageRead':
      return 'Usage information';
    case 'resetRead':
      return 'Reset time';
    case 'windowTrigger':
      return 'Automatic actions';
  }
}

export function capabilityContractLabel(contract: string): string {
  switch (contract) {
    case 'official_supported':
    case 'official_client_internal':
      return 'Reported by provider';
    case 'observed_undocumented':
      return 'Provider behavior observed';
    default:
      return 'Support status not available';
  }
}

export function capabilityDescription(
  capability: 'usageRead' | 'resetRead' | 'windowTrigger',
  supported: boolean,
): string {
  if (!supported) {
    switch (capability) {
      case 'usageRead':
        return 'Usage information is not available from this provider.';
      case 'resetRead':
        return 'The provider does not currently report reset times.';
      case 'windowTrigger':
        return 'This provider cannot start a new usage window automatically.';
    }
  }

  switch (capability) {
    case 'usageRead':
      return 'Usage information comes from the provider’s official client.';
    case 'resetRead':
      return 'Reset time is shown when the provider reports it.';
    case 'windowTrigger':
      return 'The app may start a new window when the schedule and safety checks allow it.';
  }
}

export function durationLabel(seconds: number): string {
  if (seconds === 18_000) return '5 hours';
  if (seconds === 604_800) return '7 days';
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export function humanizeIdentifier(value: string, fallback: string): string {
  const cleaned = value.replaceAll(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.replace(/\b\w/g, (character) => character.toUpperCase());
}
