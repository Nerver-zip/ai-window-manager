import type { Confidence, ProviderCapabilities, WindowSnapshot } from '../domain/types.js';
import type { ActivationPolicy } from '../domain/types.js';
import { resolveLocalOccurrence, type LocalOccurrence } from '../scheduler/time.js';
import type { CurrentWindowState } from '../domain/types.js';
import type { PlannerDecision, UpcomingScheduleItem } from '../scheduler/planner.js';
import type { TimezoneSetting } from '../scheduler/policy.js';
import type { ProviderMode } from '../storage/repositories.js';
import { renderAppShell } from './ui/layout.js';
import {
  capabilityLabel,
  durationLabel,
  providerDisplayName,
  providerLogoUrl,
  timeZoneDisplayName,
  windowDisplayName,
} from './ui/presentation.js';

// These are browser hints only. settings-api.ts remains the server-side authority.
const MIN_POLL_INTERVAL_SECONDS = 30;
const MAX_POLL_INTERVAL_SECONDS = 86_400;
const MIN_TOLERANCE_SECONDS = 0;
const MAX_TOLERANCE_SECONDS = 3_600;
const KNOWN_DURATION_CONFIDENCES = new Set<Confidence>(['exact', 'high']);
const TIME_ZONE_CHOICES = [
  ['UTC', 'UTC'],
  ['America/Sao_Paulo', 'São Paulo / Brasília'],
  ['America/Buenos_Aires', 'Buenos Aires'],
  ['America/Mexico_City', 'Mexico City'],
  ['America/New_York', 'New York'],
  ['America/Chicago', 'Chicago'],
  ['America/Denver', 'Denver'],
  ['America/Los_Angeles', 'Los Angeles'],
  ['Europe/London', 'London'],
  ['Europe/Paris', 'Paris'],
  ['Europe/Berlin', 'Berlin'],
  ['Asia/Kolkata', 'Kolkata'],
  ['Asia/Singapore', 'Singapore'],
  ['Asia/Tokyo', 'Tokyo'],
  ['Australia/Sydney', 'Sydney'],
  ['Pacific/Auckland', 'Auckland'],
] as const;

export interface SettingsProviderView {
  id: string;
  kind: string;
  enabled: boolean;
  mode: ProviderMode;
  pollIntervalSeconds: number;
  capabilities?: ProviderCapabilities | undefined;
  windows?: readonly WindowSnapshot[] | undefined;
}

export interface SettingsPageInput {
  csrfToken: string;
  providers: readonly SettingsProviderView[];
  timezone?: TimezoneSetting;
  notice?: string;
}

export interface SchedulePageInput {
  csrfToken: string;
  providers: readonly SettingsProviderView[];
  policy?: Partial<SchedulePolicyView>;
  referenceInstant: Date;
  notice?: string;
}

export interface ActivationSchedulePageInput {
  csrfToken: string;
  providers: readonly SettingsProviderView[];
  policy?: ActivationPolicy;
  timezone?: TimezoneSetting;
  currentWindow?: CurrentWindowState;
  decision?: PlannerDecision | null;
  upcoming?: readonly UpcomingScheduleItem[];
  notice?: string;
}

/** Persisted, already-validated values supplied by settings-api.ts. */
export interface SchedulePolicyView {
  enabled: boolean;
  providerId: string;
  windowKind: string;
  targetResetLocalTime: string;
  timezone: string;
  toleranceSeconds: number;
}

export function renderActivationSchedulePage(input: ActivationSchedulePageInput): string {
  const csrfToken = escapeHtml(input.csrfToken);
  const policy = input.policy;
  const providerId = policy?.providerId ?? input.providers[0]?.id ?? '';
  const selectedProvider = input.providers.find((provider) => provider.id === providerId);
  const selectedWindowKind =
    policy && 'windowKind' in policy
      ? policy.windowKind
      : (selectedProvider?.windows?.[0]?.windowKind ?? 'five_hour');
  const timezone = input.timezone?.timezone ?? policy?.timezone ?? '';
  const kind = policy?.kind ?? 'manual';
  const currentWindow = input.currentWindow;
  const decision = input.decision;
  const upcoming = input.upcoming ?? [];
  const providerOptions = input.providers.length
    ? input.providers.map((provider) => renderProviderOption(provider, providerId)).join('')
    : '<option value="">No providers configured</option>';
  const policyOptions = [
    [
      'auto',
      'When a new window is available',
      'Start when the provider is ready and safety checks pass.',
    ],
    ['fixed', 'On a regular cycle', 'Repeat a start at the same local time each cycle.'],
    ['custom_schedule', 'At chosen times', 'Start only near the local times you choose.'],
    ['active_hours', 'During selected hours', 'Start only during the hours you choose.'],
    ['manual', 'Manual only', 'Keep monitoring, but leave starting windows to you.'],
  ] as const;
  const policyOptionsHtml = policyOptions
    .map(
      ([value, label]) =>
        `<option value="${value}"${kind === value ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const windowControl = renderWindowControl(selectedProvider, selectedWindowKind ?? 'five_hour');
  const tolerance = policy && 'toleranceSeconds' in policy ? policy.toleranceSeconds : 15 * 60;
  const anchor = policy?.kind === 'fixed' ? policy.anchorLocalTime : '18:00';
  const customTimes = policy?.kind === 'custom_schedule' ? policy.times : ['08:00', '18:00'];
  const activePeriods =
    policy?.kind === 'active_hours'
      ? policy.periods.map((period) => `${period.start}-${period.end}`)
      : ['08:00-12:00', '18:00-00:00'];
  const timezoneText = timezone
    ? timeZoneDisplayName(timezone)
    : 'Choose a time zone in Settings before enabling a time-based policy.';

  return renderAppShell({
    page: 'schedule',
    title: 'Schedule',
    description: 'Choose when a new usage window should start.',
    content: `<div class="settings-page">${input.notice ? renderNotice(input.notice) : ''}
      <section class="card current-window-summary" aria-labelledby="current-window-title">
        <div class="card-header"><div class="heading-copy"><p class="eyebrow">Usage right now</p><h2 id="current-window-title">Current window</h2><p class="muted">This is the latest saved usage information from your provider.</p></div></div>
        ${renderCurrentWindowSummary(currentWindow, selectedProvider, timezone)}
      </section>
      <section class="card" aria-labelledby="activation-policy-title">
        <div class="card-header"><div class="heading-copy"><p class="eyebrow">Your preference</p><h2 id="activation-policy-title">Automatic window activation</h2><p class="muted">Choose when a new window may start. Safety checks still apply before anything happens.</p></div></div>
        <form method="post" action="/schedule" data-policy-form>
          ${csrfInput(csrfToken)}
          <input type="hidden" name="timezone" value="${escapeAttribute(timezone)}">
          <input type="hidden" name="toleranceSeconds" value="${tolerance}">
          <div class="form-grid">
            ${renderField('activation-policy-provider', 'Provider', `<select id="activation-policy-provider" name="providerId" required>${providerOptions}</select>`, 'Choose the provider this policy controls.', 'activation-policy-provider-help')}
            ${renderField('activation-policy-kind', 'How should new windows start?', `<select id="activation-policy-kind" name="policyKind" data-policy-kind required>${policyOptionsHtml}</select>`, 'Choose a simple schedule preference. You can change it without changing the current window.', 'activation-policy-kind-help')}
          </div>
          <p class="field-help" id="activation-policy-timezone"><strong>Time zone:</strong> ${escapeHtml(timezoneText)} · <a href="/settings">Change</a></p>
          ${renderPolicyFields('auto', kind === 'auto', renderPolicyWindowField(windowControl, 'auto-window'))}
          ${renderPolicyFields('fixed', kind === 'fixed', `<div class="form-grid">${renderPolicyWindowField(windowControl, 'fixed-window')}${renderField('fixed-anchor', 'Cycle start time', `<input id="fixed-anchor" name="anchorLocalTime" type="time" value="${escapeAttribute(anchor)}" step="60">`, 'Local time to start each cycle.', 'fixed-anchor-help')}</div>`)}
          ${renderPolicyFields('custom_schedule', kind === 'custom_schedule', `<div class="form-grid">${renderPolicyWindowField(windowControl, 'custom-window')}${renderPolicyListField('custom-times', 'Daily start times', 'times', customTimes, 'time', 'Choose one or more local times.', 'custom-times-help')}</div>`)}
          ${renderPolicyFields('active_hours', kind === 'active_hours', `<div class="form-grid">${renderPolicyWindowField(windowControl, 'active-hours-window')}${renderPolicyListField('active-hours-periods', 'Active hours', 'periods', activePeriods, 'period', 'Use local ranges such as 08:00-12:00. Add or remove periods as needed.', 'active-hours-periods-help')}</div><p class="field-help">The application avoids starting a full window when too little useful coverage remains.</p>`)}
          ${renderPolicyFields('manual', kind === 'manual', '<p class="notice">Monitoring continues. New windows start only when you choose.</p>')}
          <div class="form-actions"><button type="submit">Save schedule</button></div>
        </form>
      </section>
      <section class="card" aria-labelledby="upcoming-title"><div class="card-header"><div class="heading-copy"><p class="eyebrow">Next step</p><h2 id="upcoming-title">Next scheduled start</h2><p class="muted">Based on your saved schedule and the latest provider update.</p></div></div>${renderPlannerPreview(upcoming, decision, timezone)}</section>
    </div>`,
  });
}

function renderCurrentWindowSummary(
  currentWindow: CurrentWindowState | undefined,
  provider: SettingsProviderView | undefined,
  timeZone: string,
): string {
  if (!currentWindow)
    return '<p class="empty-state">Select a provider to see the current observed window.</p>';
  const label = provider ? providerDisplayName(provider.id, provider.kind) : 'Provider';
  const statusLabels: Record<CurrentWindowState['status'], string> = {
    ACTIVE: 'In use',
    INACTIVE: 'Available',
    UNKNOWN: 'Not available',
    UNAVAILABLE: 'Monitoring unavailable',
  };
  const status = statusLabels[currentWindow.status];
  const details = currentWindow.expectedEndAt
    ? `<p class="muted"><span>Expected reset</span><br><time datetime="${escapeAttribute(currentWindow.expectedEndAt.value)}">${escapeHtml(formatReadableInstant(currentWindow.expectedEndAt.value, timeZone))}</time></p>`
    : '<p class="muted">Expected reset is not available yet.</p>';
  const windowLabel = currentWindow.windowKind
    ? windowDisplayName(provider?.id ?? '', currentWindow.windowKind)
    : 'No window selected';
  return `<div class="current-window-read"><div><span class="eyebrow">${escapeHtml(label)}</span><strong class="current-window-status">${escapeHtml(status)}</strong><p class="muted">${escapeHtml(windowLabel)}</p></div>${details}</div>`;
}

function renderPlannerPreview(
  upcoming: readonly UpcomingScheduleItem[],
  decision: PlannerDecision | null | undefined,
  timezone: string,
): string {
  const next = upcoming[0]?.at ?? decision?.anchorAt ?? decision?.nextAnchorAt ?? null;
  const nextLabel = upcoming[0]?.kind === 'wait' ? 'Next available time' : 'Next planned start';
  const nextMarkup = next
    ? `<div class="next-start-preview"><span class="eyebrow">${nextLabel}</span><strong><time datetime="${escapeAttribute(next)}">${escapeHtml(formatUpcomingTime(next, timezone))}</time></strong><span class="muted">${escapeHtml(timezone || 'Local time')}</span></div>`
    : '<p class="empty-state">No start time is scheduled yet.</p>';
  const status = decision
    ? `<p class="schedule-explanation"><strong>${escapeHtml(decisionLabel(decision.kind))}.</strong> ${escapeHtml(plannerReasonLabel(decision.reasonCode))}</p>`
    : '<p class="schedule-explanation">Waiting for the provider’s first update.</p>';
  const laterItems =
    upcoming.length > 1
      ? `<details><summary>More scheduled times</summary><ol class="upcoming-list">${upcoming
          .slice(1)
          .map(
            (item) =>
              `<li><time datetime="${escapeAttribute(item.at)}">${escapeHtml(formatUpcomingTime(item.at, timezone))}</time><span>${escapeHtml(item.label === 'Start window' ? 'Start a new window' : item.label)}</span></li>`,
          )
          .join('')}</ol></details>`
      : '';
  return `<div class="schedule-preview-body">${nextMarkup}${status}${laterItems}</div>`;
}

function renderPolicyFields(kind: string, active: boolean, content: string): string {
  const state = active ? '' : ' hidden aria-hidden="true"';
  return `<div class="policy-fields" data-policy-fields="${escapeAttribute(kind)}"${state}>${active ? content : disableFormControls(content)}</div>`;
}

function disableFormControls(content: string): string {
  return content.replace(/<(input|select|textarea|button)(\s|>)/g, '<$1 disabled$2');
}

function renderPolicyListField(
  id: string,
  label: string,
  name: string,
  values: readonly string[],
  kind: 'time' | 'period',
  help: string,
  helpId: string,
): string {
  const items = values.length ? values : [''];
  return `<div class="field dynamic-list-field"><span class="field-label">${escapeHtml(label)}</span><div id="${escapeAttribute(id)}" class="dynamic-list" data-schedule-list data-list-name="${escapeAttribute(name)}" data-list-kind="${kind}" aria-describedby="${escapeAttribute(helpId)}">${items.map((value, index) => renderPolicyListItem(id, name, kind, value, index)).join('')}<button class="button button-secondary dynamic-list-add" type="button" data-list-add>Add another</button><span class="field-help" id="${escapeAttribute(helpId)}">${escapeHtml(help)}</span></div></div>`;
}

function renderPolicyListItem(
  id: string,
  name: string,
  kind: 'time' | 'period',
  value: string,
  index: number,
): string {
  const label = kind === 'time' ? `Time ${index + 1}` : `Period ${index + 1}`;
  const type = kind === 'time' ? 'time' : 'text';
  const placeholder = kind === 'time' ? '' : '08:00-12:00';
  return `<div class="dynamic-list-item" data-list-item><label for="${escapeAttribute(`${id}-${index}`)}">${escapeHtml(label)}<input id="${escapeAttribute(`${id}-${index}`)}" name="${escapeAttribute(name)}" type="${type}" value="${escapeAttribute(value)}"${placeholder ? ` placeholder="${placeholder}"` : ''} required data-list-value></label><button class="button button-secondary dynamic-list-remove" type="button" data-list-remove>Remove</button></div>`;
}

function renderPolicyWindowField(control: string, idPrefix: string): string {
  return renderField(
    `${idPrefix}-kind`,
    'Usage window',
    control
      .replaceAll('schedule-window-kind-help', `${idPrefix}-help`)
      .replaceAll('schedule-window-kind', `${idPrefix}-kind`),
    'Choose the provider window this policy should cover.',
    `${idPrefix}-help`,
  );
}

function plannerReasonLabel(reasonCode: string): string {
  const labels: Record<string, string> = {
    POLICY_DISABLED: 'Automatic starts are turned off.',
    MANUAL_POLICY: 'New windows are started only by you.',
    AUTOMATION_DISABLED: 'Monitoring continues, but automatic starts are turned off.',
    TRIGGER_CAPABILITY_UNAVAILABLE: 'This provider cannot start a window automatically.',
    MONITORING_UNAVAILABLE: 'Provider monitoring is unavailable.',
    WINDOW_PHASE_CONFIDENCE_TOO_LOW: 'The current window state is not reliable enough yet.',
    WINDOW_NOT_REPORTED: 'The selected usage window is not reported by this provider.',
    WINDOW_NOT_INACTIVE: 'The current window is not confirmed inactive.',
    OBSERVATION_STALE: 'The latest provider update is too old to plan safely.',
    OBSERVATION_MISSING: 'Waiting for the first valid provider update.',
    CURRENT_WINDOW_ACTIVE: 'A window is already active.',
    WINDOW_DURATION_UNKNOWN: 'The window duration is not available yet.',
    WINDOW_DURATION_CONFIDENCE_TOO_LOW: 'The window duration is not reliable enough yet.',
    SCHEDULED_ANCHOR: 'The scheduled time is ready.',
    ANCHOR_NOT_DUE: 'The next scheduled time has not arrived.',
    ANCHOR_SKIPPED_ACTIVE_WINDOW: 'A window was already active at that scheduled time.',
    ANCHOR_EXPIRED: 'The scheduled time was missed; waiting for the next one.',
    NEXT_ANCHOR: 'Waiting for the next scheduled time.',
    ACTION_ALREADY_PENDING: 'An automatic start is already safely waiting.',
    ACTIVE_HOURS_COVERAGE: 'The current active period has enough time remaining.',
    ACTIVE_HOURS_TOO_SHORT: 'There is not enough time left in this active period.',
    AUTO_WINDOW_AVAILABLE: 'The provider is ready for a safe automatic start.',
  };
  return labels[reasonCode] ?? 'No additional explanation is available.';
}

function formatReadableInstant(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: timeZone || 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function decisionLabel(kind: PlannerDecision['kind']): string {
  switch (kind) {
    case 'START':
      return 'A start is planned';
    case 'SKIP':
      return 'This anchor is skipped';
    case 'WAIT':
      return 'Waiting for the next safe opportunity';
    default:
      return 'No automatic start';
  }
}

function formatUpcomingTime(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export interface SchedulePreview {
  status: 'resolved' | 'unknown';
  instantIso: string | null;
  localDate: string | null;
  requestedLocalTime: string | null;
  resolvedLocalTime: string | null;
  resolution: LocalOccurrence['resolution'] | null;
  timeZone?: string | null;
  message: string;
  candidateTriggerInstantIso?: string | null;
  candidateTriggerLocalDate?: string | null;
  candidateTriggerLocalTime?: string | null;
  windowDurationSeconds?: number | null;
  windowDurationConfidence?: Confidence | null;
  candidateMessage?: string;
}

/** Resolve with the same IANA/DST rules used by the scheduler. */
export function previewTargetReset(input: {
  localTime: string;
  timeZone: string;
  referenceInstant: Date;
}): SchedulePreview {
  try {
    return resolvedPreview(resolveLocalOccurrence(input), input.timeZone);
  } catch {
    return unknownPreview(input.localTime || null, input.timeZone || null);
  }
}

export function renderSettingsPage(input: SettingsPageInput): string {
  const csrfToken = escapeHtml(input.csrfToken);
  const timezoneValue = input.timezone?.timezone ?? '';
  const timezoneIsPreset = TIME_ZONE_CHOICES.some(([zone]) => zone === timezoneValue);
  const timezoneOptions = TIME_ZONE_CHOICES.map(
    ([zone, label]) =>
      `<option value="${escapeAttribute(zone)}"${zone === timezoneValue ? ' selected' : ''}>${escapeHtml(label)}</option>`,
  ).join('');
  const timezoneField = `<select id="account-timezone" name="timezoneChoice" data-timezone-select data-timezone-auto-detect="${input.timezone ? 'false' : 'true'}" required><option value=""${timezoneValue ? '' : ' selected'} disabled>Choose a time zone</option>${timezoneOptions}<option value="custom"${timezoneValue && !timezoneIsPreset ? ' selected' : ''}>Another location…</option></select><details data-timezone-custom${!timezoneIsPreset && timezoneValue ? ' open' : ''}><summary>Use another time zone</summary><label for="custom-timezone">Time zone for another location</label><input id="custom-timezone" name="customTimezone" data-timezone-custom-input value="${escapeAttribute(timezoneIsPreset ? '' : timezoneValue)}" placeholder="e.g. Europe/Madrid" maxlength="128"><p class="field-help">Enter the time zone used by your location.</p></details>`;
  const providerSections = input.providers.length
    ? input.providers.map((provider) => renderProviderCard(provider, csrfToken)).join('\n')
    : renderEmptyState(
        'No providers configured',
        'Add a provider through service configuration before changing runtime settings.',
      );

  return renderAppShell({
    page: 'settings',
    title: 'Settings',
    description: 'Choose what to monitor, when to check, and your local time zone.',
    content: `<div class="settings-page">${input.notice ? renderNotice(input.notice) : ''}
      <section class="card timezone-settings" aria-labelledby="timezone-settings-title"><div class="card-header"><div class="heading-copy"><p class="eyebrow">Dates and schedules</p><h2 id="timezone-settings-title">Time zone</h2><p class="muted">Used for schedule times and dates shown in the app. It stays saved until you change it.</p></div></div><form method="post" action="/settings/timezone" data-timezone-settings><input type="hidden" name="csrfToken" value="${csrfToken}"><div class="form-grid">${renderField('account-timezone', 'Your time zone', timezoneField, 'Choose a nearby city, or use another time zone if yours is not listed.', 'account-timezone-help')}</div><input type="hidden" name="source" value="manual"><p class="field-help" data-timezone-status aria-live="polite"></p><div class="form-actions"><button type="submit">Save time zone</button></div></form></section>
      <section aria-labelledby="provider-settings-title">
        <div class="section-heading"><div class="heading-copy"><p class="eyebrow">Provider connection</p><h2 id="provider-settings-title">Connection and monitoring</h2></div><p class="muted">Only non-secret settings are editable here. Sign-in stays with the official provider client.</p></div>
        <div class="settings-stack">${providerSections}</div>
      </section>
    </div>`,
  });
}

export function renderSchedulePage(input: SchedulePageInput): string {
  const csrfToken = escapeHtml(input.csrfToken);
  const policy = input.policy ?? {};
  const providerId = stringValue(policy.providerId);
  const windowKind = stringValue(policy.windowKind);
  const targetResetLocalTime = stringValue(policy.targetResetLocalTime);
  const timezone = stringValue(policy.timezone);
  const toleranceSeconds = numberValue(policy.toleranceSeconds);
  const selectedProvider = input.providers.find((provider) => provider.id === providerId);
  const basePreview =
    targetResetLocalTime && timezone
      ? previewTargetReset({
          localTime: targetResetLocalTime,
          timeZone: timezone,
          referenceInstant: input.referenceInstant,
        })
      : unknownPreview(targetResetLocalTime || null, timezone || null);
  const preview = addWindowCandidate(basePreview, selectedProvider, windowKind);
  const providerOptions = input.providers.length
    ? input.providers.map((provider) => renderProviderOption(provider, providerId)).join('')
    : '<option value="">No providers configured</option>';

  return renderAppShell({
    page: 'schedule',
    title: 'Schedule',
    description: 'Choose when a usage window should be ready for a fresh start.',
    content: `<div class="schedule-page">${input.notice ? renderNotice(input.notice) : ''}
      <div class="schedule-layout">
        <section class="card" aria-labelledby="schedule-config-title">
          <header class="card-header"><div class="heading-copy"><p class="eyebrow">Reset plan</p><h2 id="schedule-config-title">Plan a window reset</h2><p class="muted">Choose a local reset time. The preview uses the latest saved provider update and never checks the provider itself.</p></div></header>
          <form method="post" action="/schedule">
            ${csrfInput(csrfToken)}
            <fieldset>
              <legend>Reset plan</legend>
              <div class="form-grid">
                ${renderField('schedule-enabled', 'Plan status', `<select id="schedule-enabled" name="enabled" aria-describedby="schedule-enabled-help">${booleanOptions(policy.enabled, 'Active', 'Paused')}</select>`, 'Pause this plan without deleting it or changing its saved values.', 'schedule-enabled-help')}
                ${renderField('schedule-provider', 'Provider', `<select id="schedule-provider" name="providerId" aria-describedby="schedule-provider-help" required>${providerOptions}</select>`, 'Choose which connected provider supplies the usage information.', 'schedule-provider-help')}
                ${renderField('schedule-window-kind', 'Usage window', renderWindowControl(selectedProvider, windowKind), 'Choose the window whose reset you want to plan around.', 'schedule-window-kind-help')}
                ${renderField('schedule-target-reset', 'Reset time', `<input id="schedule-target-reset" name="targetResetLocalTime" type="time" value="${escapeAttribute(targetResetLocalTime)}" step="60" aria-describedby="schedule-target-reset-help" required>`, 'The local time when this usage window is expected to reset.', 'schedule-target-reset-help')}
                ${renderField('schedule-timezone', 'Timezone', `<input id="schedule-timezone" name="timezone" value="${escapeAttribute(timezone)}" placeholder="America/Sao_Paulo" maxlength="128" aria-describedby="schedule-timezone-help" required>`, 'Use an IANA timezone so daylight-saving transitions remain explicit.', 'schedule-timezone-help')}
                ${renderField('schedule-tolerance', 'Timing tolerance', `<input id="schedule-tolerance" name="toleranceSeconds" type="number" min="${MIN_TOLERANCE_SECONDS}" max="${MAX_TOLERANCE_SECONDS}" value="${toleranceSeconds === null ? '' : toleranceSeconds}" aria-describedby="schedule-tolerance-help" required>`, 'How many seconds of variation are acceptable around the planned start.', 'schedule-tolerance-help')}
              </div>
            </fieldset>
            <div class="form-actions"><button type="submit">Save schedule</button></div>
          </form>
        </section>
        <aside class="card schedule-preview" aria-labelledby="schedule-preview-title">
          <header class="card-header"><div class="heading-copy"><p class="eyebrow">Live preview</p><h2 id="schedule-preview-title">What happens next</h2><p class="muted">This preview uses saved observations only and never checks the provider itself.</p></div></header>
          ${renderSchedulePreview(preview)}
          ${renderScheduleSafety(selectedProvider)}
        </aside>
      </div>
    </div>`,
  });
}

export function renderSchedulePreview(preview: SchedulePreview): string {
  if (preview.status === 'unknown') {
    return `<div class="schedule-preview-body schedule-preview--unknown"><p class="badge">Preview unavailable</p><p>${escapeHtml(preview.message)}</p>${renderCandidateMetric(preview)}</div>`;
  }

  const resolution = resolutionLabel(preview.resolution);
  return `<div class="schedule-preview-body schedule-preview--resolved">
    <div class="form-grid">
      <div class="preview-metric"><span class="muted">Reset time</span><strong class="preview-time">${escapeHtml(preview.resolvedLocalTime ?? 'Not available yet')}</strong><span class="muted">${escapeHtml(preview.localDate ?? 'Local date not available')}</span></div>
      ${renderCandidateMetric(preview)}
      <div class="preview-metric"><span class="muted">Timezone</span><strong>${escapeHtml(preview.timeZone ?? 'Not available yet')}</strong><span class="muted">Local time zone</span></div>
      <div class="preview-metric"><span class="muted">Time adjustment</span><strong data-resolution="${escapeAttribute(preview.resolution ?? 'unknown')}">${escapeHtml(resolution)}</strong><span class="muted">${escapeHtml(preview.message)}</span></div>
    </div>
    <details><summary>How the time was resolved</summary><p class="muted">${escapeHtml(preview.message)}</p></details>
  </div>`;
}

function renderProviderCard(provider: SettingsProviderView, csrfToken: string): string {
  const id = safeId(provider.id);
  const canAutomate = provider.capabilities?.windowTrigger.supported === true;
  const automationOption = canAutomate
    ? `<option value="automation"${provider.mode === 'automation' ? ' selected' : ''}>Allow automatic starts</option>`
    : `<option value="automation"${provider.mode === 'automation' ? ' selected' : ''} disabled>Automatic starts unavailable</option>`;
  const automationHelp = canAutomate
    ? 'The app may start a new window when your schedule and safety checks allow it. This uses provider quota.'
    : provider.capabilities
      ? 'This provider cannot start a new window automatically.'
      : 'Automatic starts are unavailable until this provider is verified.';
  const displayName = providerDisplayName(provider.id, provider.kind);
  const logoUrl = providerLogoUrl(provider.id, provider.kind);
  const logoHtml = logoUrl
    ? `<img class="provider-logo" src="${logoUrl}" alt="" width="34" height="34">`
    : '';
  const pollPreset = [60, 300, 900].includes(provider.pollIntervalSeconds)
    ? String(provider.pollIntervalSeconds)
    : 'custom';
  const customIntervalDisabled = pollPreset !== 'custom' ? ' disabled' : '';
  const automaticStartsLabel = !provider.enabled
    ? 'Automatic starts paused'
    : provider.mode === 'automation'
      ? canAutomate
        ? 'Automatic starts allowed'
        : 'Automatic starts unavailable'
      : canAutomate
        ? 'Automatic starts off'
        : 'Monitoring only';

  return `<article class="card provider-settings" aria-labelledby="provider-${id}-title">
    <header class="provider-header"><div class="provider-identity">${logoHtml}<div><p class="eyebrow">Provider</p><h3 id="provider-${id}-title">${escapeHtml(displayName)}</h3></div></div><div class="badges" aria-label="${escapeHtml(displayName)} status"><span class="badge ${provider.enabled ? 'badge-success' : 'badge-warning'}">${provider.enabled ? 'Monitoring on' : 'Monitoring paused'}</span><span class="badge">${automaticStartsLabel}</span></div></header>
    <form method="post" action="/settings/providers/${escapeAttribute(encodeURIComponent(provider.id))}">
      ${csrfInput(csrfToken)}
      <fieldset><legend>Provider controls</legend><div class="form-grid">
        ${renderField(`provider-${id}-enabled`, 'Check this provider', `<select id="provider-${id}-enabled" name="enabled" aria-describedby="provider-${id}-enabled-help">${booleanOptions(provider.enabled, 'On', 'Paused')}</select>`, 'Paused providers keep their saved history but are not checked for new usage.', `provider-${id}-enabled-help`)}
        ${renderField(`provider-${id}-mode`, 'Start windows automatically', `<select id="provider-${id}-mode" name="mode" aria-describedby="provider-${id}-mode-help"><option value="monitor_only"${provider.mode === 'monitor_only' ? ' selected' : ''}>No, only monitor</option>${automationOption}</select>`, automationHelp, `provider-${id}-mode-help`)}
        ${renderPollIntervalField(provider, id, pollPreset, customIntervalDisabled)}
      </div></fieldset>
      <div class="form-actions"><button type="submit">Save settings</button></div>
    </form>
    <details class="capability-details"><summary>What this provider can do</summary>${renderCapabilitySummary(provider.capabilities)}</details>
  </article>`;
}

function renderPollIntervalField(
  provider: SettingsProviderView,
  id: string,
  preset: string,
  customDisabled: string,
): string {
  const options = [
    ['60', 'Every minute'],
    ['300', 'Every 5 minutes'],
    ['900', 'Every 15 minutes'],
    ['custom', 'Custom interval'],
  ] as const;
  return `<div class="field refresh-interval-field"><label for="provider-${id}-poll-preset">Check for updates</label><select id="provider-${id}-poll-preset" name="refreshIntervalPreset" data-refresh-preset aria-describedby="provider-${id}-poll-help">${options.map(([value, label]) => `<option value="${value}"${preset === value ? ' selected' : ''}>${label}</option>`).join('')}</select><p class="field-help" id="provider-${id}-poll-help">How often to look for new usage information.</p><details data-refresh-custom${preset === 'custom' ? ' open' : ''}><summary>Custom interval</summary><label for="provider-${id}-poll-custom">Seconds</label><input id="provider-${id}-poll-custom" name="customPollIntervalSeconds" type="number" min="${MIN_POLL_INTERVAL_SECONDS}" max="${MAX_POLL_INTERVAL_SECONDS}" value="${escapeAttribute(String(provider.pollIntervalSeconds))}"${customDisabled} required><p class="field-help">Choose from ${MIN_POLL_INTERVAL_SECONDS} seconds to 24 hours.</p></details></div>`;
}

function renderCapabilitySummary(capabilities: ProviderCapabilities | undefined): string {
  if (!capabilities)
    return '<p class="unknown"><span class="badge">Not verified</span> We could not check this provider yet.</p>';
  return `<dl>${renderCapabilityRow('usageRead', capabilities.usageRead)}${renderCapabilityRow('resetRead', capabilities.resetRead)}${renderCapabilityRow('windowTrigger', capabilities.windowTrigger, capabilities.windowTrigger.consumesQuota)}</dl>`;
}

function renderCapabilityRow(
  capabilityName: 'usageRead' | 'resetRead' | 'windowTrigger',
  capability: ProviderCapabilities['usageRead'] | ProviderCapabilities['windowTrigger'],
  consumesQuota?: boolean | 'unknown',
): string {
  const status = capability.supported ? 'Available' : 'Not available';
  const quota =
    consumesQuota === true
      ? 'May use provider quota when a window starts.'
      : consumesQuota === false
        ? 'Starting a window does not use provider quota.'
        : consumesQuota === 'unknown'
          ? 'Quota use has not been confirmed.'
          : '';
  const description =
    capabilityName === 'usageRead'
      ? capability.supported
        ? 'Usage readings are available.'
        : 'Usage readings are not available.'
      : capabilityName === 'resetRead'
        ? capability.supported
          ? 'Reset time is shown when the provider reports it.'
          : 'Reset time is not available from this provider.'
        : capability.supported
          ? 'New windows can start automatically when your schedule allows it.'
          : 'This provider cannot start new windows automatically.';
  const extra = [description, quota].filter(Boolean).join(' ');
  return `<div><dt>${escapeHtml(capabilityLabel(capabilityName))}</dt><dd><span class="badge ${capability.supported ? 'badge-success' : 'badge-warning'}">${status}</span><br><small>${escapeHtml(extra)}</small></dd></div>`;
}

function renderProviderOption(provider: SettingsProviderView, selectedProviderId: string): string {
  return `<option value="${escapeAttribute(provider.id)}"${provider.id === selectedProviderId ? ' selected' : ''}>${escapeHtml(providerDisplayName(provider.id, provider.kind))}</option>`;
}

function renderScheduleSafety(provider: SettingsProviderView | undefined): string {
  if (!provider)
    return '<p class="notice"><span class="badge">Waiting for a provider</span> Select a provider to see whether automatic actions are available.</p>';
  if (provider.capabilities?.windowTrigger.supported !== true)
    return '<p class="notice"><span class="badge">Monitoring only</span> The schedule can be evaluated, but this provider cannot start a new window automatically.</p>';
  if (provider.mode !== 'automation' || !provider.enabled)
    return '<p class="notice"><span class="badge badge-warning">Automatic actions off</span> The schedule can be evaluated, but this provider is set to monitoring only.</p>';
  return '<p class="notice"><span class="badge badge-success">Automatic actions available</span> Fresh usage information and the safety checks still need to agree before anything starts.</p>';
}

function renderCandidateMetric(preview: SchedulePreview): string {
  if (!preview.candidateTriggerInstantIso || !preview.candidateTriggerLocalTime)
    return `<div class="preview-metric"><span class="muted">Planned start</span><strong>Not available yet</strong><span class="muted">${escapeHtml(preview.candidateMessage ?? 'A planned start is not available yet.')}</span></div>`;
  const date = preview.candidateTriggerLocalDate
    ? `${preview.candidateTriggerLocalDate} local time`
    : 'Local date not available';
  return `<div class="preview-metric"><span class="muted">Planned start</span><strong class="preview-time">${escapeHtml(preview.candidateTriggerLocalTime)}</strong><span class="muted">${escapeHtml(date)} · ${escapeHtml(durationLabel(preview.windowDurationSeconds ?? 0))}</span></div>`;
}

function addWindowCandidate(
  preview: SchedulePreview,
  provider: SettingsProviderView | undefined,
  windowKind: string,
): SchedulePreview {
  if (preview.status !== 'resolved') return preview;
  const duration = provider?.windows?.find(
    (window) => window.windowKind === windowKind,
  )?.durationSeconds;
  if (!duration || !Number.isFinite(duration.value) || duration.value <= 0)
    return {
      ...preview,
      candidateMessage: 'The selected window duration is not available yet.',
    };
  if (!KNOWN_DURATION_CONFIDENCES.has(duration.confidence))
    return {
      ...preview,
      candidateMessage: 'The start time will appear when the window duration is reliable enough.',
    };
  const candidateInstant = new Date(Date.parse(preview.instantIso ?? '') - duration.value * 1000);
  if (!Number.isFinite(candidateInstant.getTime()) || !preview.timeZone)
    return {
      ...preview,
      candidateMessage: 'The start time cannot be calculated safely yet.',
    };
  const local = localParts(candidateInstant, preview.timeZone);
  return {
    ...preview,
    candidateTriggerInstantIso: candidateInstant.toISOString(),
    candidateTriggerLocalDate: local.date,
    candidateTriggerLocalTime: local.time,
    windowDurationSeconds: duration.value,
    windowDurationConfidence: duration.confidence,
    candidateMessage: `Based on a ${durationLabel(duration.value)} window.`,
  };
}

function resolvedPreview(occurrence: LocalOccurrence, timeZone: string): SchedulePreview {
  const message = occurrence.wasAdjusted
    ? 'This time was moved to the first valid local time after a daylight-saving change.'
    : occurrence.wasAmbiguous
      ? 'This repeated local time uses the earlier occurrence.'
      : 'No time adjustment was needed.';
  return {
    status: 'resolved',
    instantIso: occurrence.instant.toISOString(),
    localDate: occurrence.localDate,
    requestedLocalTime: occurrence.requestedLocalTime,
    resolvedLocalTime: occurrence.resolvedLocalTime,
    resolution: occurrence.resolution,
    timeZone,
    message,
    candidateTriggerInstantIso: null,
    candidateTriggerLocalDate: null,
    candidateTriggerLocalTime: null,
    windowDurationSeconds: null,
    windowDurationConfidence: null,
    candidateMessage: 'The selected window duration is not available yet.',
  };
}

function unknownPreview(
  requestedLocalTime: string | null,
  timeZone: string | null,
): SchedulePreview {
  return {
    status: 'unknown',
    instantIso: null,
    localDate: null,
    requestedLocalTime,
    resolvedLocalTime: null,
    resolution: null,
    timeZone,
    message: timeZone ? 'Enter a valid local time.' : 'Enter a local time and timezone.',
    candidateTriggerInstantIso: null,
    candidateTriggerLocalDate: null,
    candidateTriggerLocalTime: null,
    windowDurationSeconds: null,
    windowDurationConfidence: null,
    candidateMessage: 'The planned start will appear after the reset time is resolved.',
  };
}

function renderField(
  id: string,
  label: string,
  control: string,
  help: string,
  helpId: string,
): string {
  return `<div><label for="${escapeAttribute(id)}">${escapeHtml(label)}</label>${control}<p class="field-help" id="${escapeAttribute(helpId)}">${escapeHtml(help)}</p></div>`;
}

function renderNotice(notice: string): string {
  return `<div class="notice" role="status">${escapeHtml(notice)}</div>`;
}
function renderEmptyState(title: string, message: string): string {
  return `<div class="empty-state"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`;
}
function csrfInput(token: string): string {
  return `<input type="hidden" name="csrfToken" value="${token}">`;
}
function booleanOptions(
  value: unknown,
  enabledLabel = 'Enabled',
  disabledLabel = 'Disabled',
): string {
  return `<option value="true"${value === true ? ' selected' : ''}>${escapeHtml(enabledLabel)}</option><option value="false"${value === false ? ' selected' : ''}>${escapeHtml(disabledLabel)}</option>`;
}

function renderWindowControl(
  provider: SettingsProviderView | undefined,
  selectedWindowKind: string,
): string {
  const candidates = [
    'five_hour',
    'weekly',
    ...(provider?.windows?.map((window) => window.windowKind).filter((kind) => kind.length > 0) ??
      []),
  ].filter((kind, index, all) => all.indexOf(kind) === index);
  if (selectedWindowKind && !candidates.includes(selectedWindowKind)) {
    candidates.unshift(selectedWindowKind);
  }
  const options = candidates
    .map((kind) => {
      const duration = provider?.windows?.find((window) => window.windowKind === kind)
        ?.durationSeconds?.value;
      const label = windowDisplayName(provider?.id ?? '', kind, duration);
      return `<option value="${escapeAttribute(kind)}"${kind === selectedWindowKind ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');
  return `<select id="schedule-window-kind" name="windowKind" aria-describedby="schedule-window-kind-help" required>${selectedWindowKind ? '' : '<option value="" selected disabled>Choose a usage window</option>'}${options}</select>`;
}

function resolutionLabel(resolution: LocalOccurrence['resolution'] | null): string {
  switch (resolution) {
    case 'nonexistent_shifted_to_next_valid':
      return 'Adjusted after DST gap';
    case 'ambiguous_earlier':
      return 'Earlier DST occurrence';
    case 'exact':
      return 'Exact';
    default:
      return 'Unknown';
  }
}

function localParts(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.get('year') ?? '????'}-${values.get('month') ?? '??'}-${values.get('day') ?? '??'}`,
    time: `${values.get('hour') ?? '??'}:${values.get('minute') ?? '??'}`,
  };
}

function safeId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, '-');
}
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
function escapeHtml(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
