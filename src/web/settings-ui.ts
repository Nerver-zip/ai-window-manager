import type { Confidence, ProviderCapabilities, WindowSnapshot } from '../domain/types.js';
import type { ActivationPolicy } from '../domain/types.js';
import {
  localDateAt,
  resolveLocalOccurrence,
  resolveLocalOccurrenceOnDate,
  shiftLocalDate,
  type LocalOccurrence,
} from '../scheduler/time.js';
import type { CurrentWindowState } from '../domain/types.js';
import {
  upcomingSchedule,
  type PlannerDecision,
  type UpcomingScheduleItem,
} from '../scheduler/planner.js';
import { localTimeMinutes, type TimezoneSetting } from '../scheduler/policy.js';
import type { ProviderMode } from '../storage/repositories.js';
import { renderAppShell } from './ui/layout.js';
import { renderProviderPicker } from './ui/provider-picker.js';
import { renderAuthOnboarding, type AuthOnboardingInput } from './ui/auth-onboarding.js';
import {
  capabilityLabel,
  durationLabel,
  providerDisplayName,
  providerLogoUrl,
  timeZoneDisplayName,
  windowGroupDisplayName,
  windowDisplayName,
} from './ui/presentation.js';
import {
  observedWindowTargets,
  resolveWindowTarget,
  type WindowTargetDescriptor,
  type WindowTargetResolution,
} from './ui/window-targets.js';

// These are browser hints only. settings-api.ts remains the server-side authority.
const MIN_POLL_INTERVAL_SECONDS = 30;
const MAX_POLL_INTERVAL_SECONDS = 86_400;
const MIN_TOLERANCE_SECONDS = 0;
const MAX_TOLERANCE_SECONDS = 3_600;
const KNOWN_DURATION_CONFIDENCES = new Set<Confidence>(['exact', 'high']);
const TIME_ZONE_GROUPS = [
  [
    'Americas',
    [
      ['America/Sao_Paulo', 'São Paulo'],
      ['America/Buenos_Aires', 'Buenos Aires'],
      ['America/Mexico_City', 'Mexico City'],
      ['America/New_York', 'New York'],
      ['America/Chicago', 'Chicago'],
      ['America/Denver', 'Denver'],
      ['America/Los_Angeles', 'Los Angeles'],
      ['America/Anchorage', 'Anchorage'],
    ],
  ],
  [
    'Europe',
    [
      ['Europe/London', 'London'],
      ['Europe/Paris', 'Paris'],
      ['Europe/Berlin', 'Berlin'],
      ['Europe/Madrid', 'Madrid'],
      ['Europe/Helsinki', 'Helsinki'],
    ],
  ],
  [
    'Asia',
    [
      ['Asia/Kolkata', 'Kolkata'],
      ['Asia/Dubai', 'Dubai'],
      ['Asia/Singapore', 'Singapore'],
      ['Asia/Tokyo', 'Tokyo'],
      ['Asia/Seoul', 'Seoul'],
    ],
  ],
  [
    'Pacific',
    [
      ['Australia/Sydney', 'Sydney'],
      ['Pacific/Auckland', 'Auckland'],
      ['Pacific/Honolulu', 'Honolulu'],
    ],
  ],
  [
    'Africa',
    [
      ['Africa/Cairo', 'Cairo'],
      ['Africa/Johannesburg', 'Johannesburg'],
      ['Africa/Nairobi', 'Nairobi'],
    ],
  ],
  ['UTC', [['UTC', 'UTC']]],
] as const;
const DEFAULT_REFERENCE_INSTANT = new Date('2026-01-01T12:00:00.000Z');

export interface SettingsProviderView {
  id: string;
  kind: string;
  enabled: boolean;
  mode: ProviderMode;
  pollIntervalSeconds: number;
  capabilities?: ProviderCapabilities | undefined;
  windows?: readonly WindowSnapshot[] | undefined;
  staleAfterSeconds?: number | undefined;
  configured?: boolean | undefined;
  connectionLabel?: string | undefined;
  triggerModels?: { gemini: string; claudeGpt: string } | undefined;
}

export interface SettingsPageInput {
  csrfToken: string;
  providers: readonly SettingsProviderView[];
  authProviders?: readonly AuthOnboardingInput[];
  timezone?: TimezoneSetting;
  referenceInstant?: Date;
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
  selectedProviderId?: string;
  policy?: ActivationPolicy;
  timezone?: TimezoneSetting;
  currentWindow?: CurrentWindowState;
  decision?: PlannerDecision | null;
  upcoming?: readonly UpcomingScheduleItem[];
  referenceInstant?: Date;
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
  const providerId = policy?.providerId ?? input.selectedProviderId ?? input.providers[0]?.id ?? '';
  const selectedProvider = input.providers.find((provider) => provider.id === providerId);
  const configuredWindowKind = policy && 'windowKind' in policy ? policy.windowKind : undefined;
  const windowTargets = observedWindowTargets(providerId, selectedProvider?.windows);
  const targetResolution = resolveWindowTarget(configuredWindowKind, windowTargets);
  const timezone = input.timezone?.timezone ?? policy?.timezone ?? '';
  const kind = policy?.kind ?? 'manual';
  const noObservedTargets = windowTargets.length === 0;
  const currentWindow = input.currentWindow;
  const decision = input.decision;
  const providerPicker = renderProviderPicker({
    name: 'providerId',
    legend: 'Provider',
    options: input.providers.map((provider) => ({
      value: provider.id,
      label: providerDisplayName(provider.id, provider.kind),
      kind: provider.kind,
      ...(provider.configured !== undefined ? { configured: provider.configured } : {}),
      ...(provider.connectionLabel ? { statusLabel: provider.connectionLabel } : {}),
    })),
    selectedValue: providerId,
    required: input.providers.length > 0,
    describedBy: 'activation-policy-provider-help',
    helpText: 'Choose a provider to load its saved schedule. This does not save changes.',
    emptyText: 'No providers configured',
  });
  const policyOptions = [
    ['auto', 'Whenever possible', 'Start when a new window is safely available.', 'bolt'],
    ['custom_schedule', 'At specific times', 'Choose one or more times of day.', 'calendar'],
    ['fixed', 'On a repeating cycle', 'Use the same local start time each cycle.', 'repeat'],
    ['active_hours', 'Within active hours', 'Only start during the hours you choose.', 'clock'],
    ['manual', 'Only when I ask', 'Keep monitoring; never start automatically.', 'hand'],
  ] as const;
  const windowField = renderWindowTargetField(
    selectedProvider,
    windowTargets,
    targetResolution,
    'Choose the exact provider-reported window this schedule should manage.',
  );
  const tolerance = policy && 'toleranceSeconds' in policy ? policy.toleranceSeconds : 15 * 60;
  const anchor = policy?.kind === 'fixed' ? policy.anchorLocalTime : '18:00';
  const customTimes = policy?.kind === 'custom_schedule' ? policy.times : ['08:00', '18:00'];
  const activePeriods =
    policy?.kind === 'active_hours' ? policy.periods : [{ start: '08:00', end: '18:00' }];
  const timezoneText = timezone
    ? timeZoneDisplayName(timezone)
    : 'Choose a time zone in Settings before enabling a time-based policy.';
  const automaticPolicySelected = kind !== 'manual';
  const targetBlocksAutomaticPolicy =
    automaticPolicySelected && targetResolution.status !== 'resolved';
  const previewPolicy = targetBlocksAutomaticPolicy
    ? undefined
    : policy && targetResolution.status === 'resolved' && 'windowKind' in policy
      ? { ...policy, windowKind: targetResolution.target.windowKind }
      : policy;
  const scheduleExplanation = targetBlocksAutomaticPolicy
    ? renderUnresolvedScheduleExplanation(windowTargets, targetResolution)
    : renderPlannerPreview(decision);

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
        <div class="card-header"><div class="heading-copy"><p class="eyebrow">Your preference</p><h2 id="activation-policy-title">When should a new window start?</h2><p class="muted">Choose a pattern. We only start when fresh usage information and provider safety checks allow it.</p></div></div>
        <form class="schedule-provider-selection" method="get" action="/schedule" data-provider-picker-auto-submit>
          ${providerPicker}
          <noscript><div class="form-actions"><button type="submit">View provider schedule</button></div></noscript>
        </form>
        <form method="post" action="/schedule" data-policy-form data-schedule-preview-form>
          ${csrfInput(csrfToken)}
          <input type="hidden" name="providerId" value="${escapeAttribute(providerId)}">
          <input type="hidden" name="timezone" value="${escapeAttribute(timezone)}">
          <input type="hidden" name="toleranceSeconds" value="${tolerance}">
          <fieldset class="policy-choice-group"><legend>How should a new window start?</legend><p class="field-help">Choose a pattern. You can change it later without affecting the current window.</p><div class="policy-choice-grid">${policyOptions.map(([value, label, description, icon]) => renderPolicyChoice(value, label, description, icon, kind === value, noObservedTargets && value !== 'manual')).join('')}</div></fieldset>
          <p class="field-help" id="activation-policy-timezone"><strong>Time zone:</strong> ${escapeHtml(timezoneText)} · <a href="/settings">Change</a></p>
          ${windowField}
          ${renderPolicyFields('auto', kind === 'auto' && !noObservedTargets, '<p class="policy-guidance">The service checks for a newly available window and starts it only when fresh provider data and provider safety checks agree.</p>')}
          ${renderPolicyFields('custom_schedule', kind === 'custom_schedule' && !noObservedTargets, `<div class="policy-controls-grid">${renderPolicyListField('custom-times', 'Daily start times', 'times', customTimes, 'time', 'Times use your saved local time zone.', 'custom-times-help', true)}</div><p class="policy-guidance">A scheduled time is an opportunity, not a guarantee. The service checks periodically and still requires fresh, safe provider data.</p>`)}
          ${renderPolicyFields('fixed', kind === 'fixed' && !noObservedTargets, `<div class="policy-controls-grid">${renderField('fixed-anchor', 'Cycle start time', `<input id="fixed-anchor" name="anchorLocalTime" type="time" value="${escapeAttribute(anchor)}" step="60" required>`, 'The local time to use for each cycle.', 'fixed-anchor-help')}</div><p class="policy-guidance">Missed starts are skipped, never caught up unexpectedly.</p>`)}
          ${renderPolicyFields('active_hours', kind === 'active_hours' && !noObservedTargets, `<div class="policy-controls-grid">${renderActiveHoursField(activePeriods)}</div><p class="policy-guidance">The service avoids starting a full window when too little of your chosen period remains.</p>`)}
          ${renderPolicyFields('manual', kind === 'manual', '<p class="policy-guidance">Monitoring continues. The service will not start a window automatically.</p>')}
          <div class="form-actions"><button type="submit"${input.providers.length ? '' : ' disabled'}>Save schedule</button></div>
        </form>
      </section>
      <section class="card schedule-horizon-card" aria-labelledby="horizon-title"><div class="card-header"><div class="heading-copy"><p class="eyebrow">Next 24 hours</p><h2 id="horizon-title">Your schedule at a glance</h2><p class="muted">Times are shown in ${escapeHtml(timezone ? timeZoneDisplayName(timezone) : 'your saved time zone')}. Start markers are opportunities, not guaranteed actions.</p></div></div><div data-schedule-horizon>${renderScheduleHorizon({ policy: previewPolicy, provider: selectedProvider, currentWindow, referenceInstant: input.referenceInstant ?? DEFAULT_REFERENCE_INSTANT, timezone })}</div><p class="visually-hidden" data-preview-status role="status" aria-live="polite"></p></section>
      <section class="schedule-details" aria-labelledby="schedule-details-title"><p class="eyebrow">Safety check</p><h2 id="schedule-details-title">What happens next</h2>${scheduleExplanation}</section>
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
  const selectedSnapshot = provider?.windows?.find(
    (window) => window.windowKind === currentWindow.windowKind,
  );
  const windowLabel = currentWindow.windowKind
    ? windowDisplayName(
        provider?.id ?? '',
        currentWindow.windowKind,
        selectedSnapshot?.durationSeconds?.value,
      )
    : 'No window selected';
  const groupLabel = currentWindow.windowKind
    ? windowGroupDisplayName(currentWindow.windowKind)
    : null;
  const targetLabel = groupLabel ? `${groupLabel} · ${windowLabel}` : windowLabel;
  return `<div class="current-window-read"><div><span class="eyebrow">${escapeHtml(label)}</span><strong class="current-window-status">${escapeHtml(status)}</strong><p class="muted">${escapeHtml(targetLabel)}</p></div>${details}</div>`;
}

function renderPlannerPreview(decision: PlannerDecision | null | undefined): string {
  return decision
    ? `<p class="schedule-explanation"><strong>${escapeHtml(decisionLabel(decision.kind))}.</strong> ${escapeHtml(plannerReasonLabel(decision.reasonCode))}</p>`
    : '<p class="schedule-explanation">Waiting for the provider’s first update. No start can be planned until usage data is available.</p>';
}

export interface ScheduleHorizonInput {
  policy: ActivationPolicy | undefined;
  provider: SettingsProviderView | undefined;
  currentWindow: CurrentWindowState | undefined;
  referenceInstant: Date;
  timezone: string;
}

export function renderScheduleHorizon(input: ScheduleHorizonInput): string {
  const { policy, provider, currentWindow, referenceInstant, timezone } = input;
  const horizonMs = 24 * 60 * 60 * 1000;
  const endMs = referenceInstant.getTime() + horizonMs;
  const selectedKind = policy && 'windowKind' in policy ? policy.windowKind : undefined;
  const selectedWindow = provider?.windows?.find((window) => window.windowKind === selectedKind);
  const duration = selectedWindow?.durationSeconds;
  const durationSeconds =
    duration && ['exact', 'high'].includes(duration.confidence) ? duration.value : undefined;
  const ageSeconds = currentWindow?.observedAt
    ? Math.max(0, (referenceInstant.getTime() - Date.parse(currentWindow.observedAt)) / 1000)
    : Number.POSITIVE_INFINITY;
  const currentIsFresh = Boolean(
    currentWindow?.status === 'ACTIVE' &&
    provider?.staleAfterSeconds !== undefined &&
    ageSeconds <= provider.staleAfterSeconds,
  );
  const schedule = policy ? upcomingSchedule(policy, referenceInstant, durationSeconds, 32) : [];
  const milestones: { at: string; label: string; type: 'start' | 'reset' }[] = [];
  for (const item of schedule) {
    const at = Date.parse(item.at);
    if (Number.isFinite(at) && at >= referenceInstant.getTime() && at <= endMs) {
      milestones.push({ at: item.at, label: 'Scheduled start opportunity', type: 'start' });
    }
  }
  const resetFact = currentWindow?.expectedEndAt;
  const resetAt =
    currentIsFresh && resetFact && ['exact', 'high'].includes(resetFact.confidence)
      ? resetFact.value
      : undefined;
  const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
  if (Number.isFinite(resetMs) && resetMs >= referenceInstant.getTime() && resetMs <= endMs) {
    milestones.push({
      at: resetAt as string,
      label: 'Expected current-window reset',
      type: 'reset',
    });
  }
  milestones.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const visibleMilestones = milestones.slice(0, 3);
  const xFor = (instantMs: number) =>
    40 + Math.max(0, Math.min(1, (instantMs - referenceInstant.getTime()) / horizonMs)) * 920;
  const projectedSegments = schedule
    .filter((item) => item.kind === 'start')
    .map((item) => {
      const startMs = Date.parse(item.at);
      if (startMs < referenceInstant.getTime() || startMs > endMs || !durationSeconds) return '';
      const x = xFor(startMs);
      const right = xFor(Math.min(endMs, startMs + durationSeconds * 1000));
      return `<rect class="horizon-projected" x="${x.toFixed(1)}" y="41" width="${Math.max(2, right - x).toFixed(1)}" height="14" rx="4"/>`;
    })
    .join('');
  const currentEndX =
    currentIsFresh && Number.isFinite(resetMs) ? xFor(Math.min(endMs, resetMs)) : 40;
  const currentSegment =
    currentIsFresh && currentEndX > 40
      ? `<rect class="horizon-current" x="40" y="41" width="${(currentEndX - 40).toFixed(1)}" height="14" rx="4"/>`
      : '';
  const activeHoursSegments =
    policy?.kind === 'active_hours'
      ? renderActiveHoursSegments(policy, referenceInstant, endMs, xFor)
      : '';
  const markerSvg = milestones
    .map((item) => {
      const x = xFor(Date.parse(item.at)).toFixed(1);
      return `<line class="horizon-marker horizon-marker-${item.type}" x1="${x}" y1="27" x2="${x}" y2="62"/><circle class="horizon-marker-dot horizon-marker-${item.type}" cx="${x}" cy="48" r="4"/>`;
    })
    .join('');
  const nowLine = '<line class="horizon-now" x1="40" y1="19" x2="40" y2="68"/>';
  const ticks = [0, 6, 12, 18, 24]
    .map((hour) => {
      const x = 40 + (hour / 24) * 920;
      return `<line class="horizon-tick" x1="${x}" y1="36" x2="${x}" y2="62"/>`;
    })
    .join('');
  const axis = [0, 6, 12, 18, 24]
    .map((hour) => {
      const tickAt = new Date(referenceInstant.getTime() + hour * 60 * 60 * 1000);
      return `<span>${escapeHtml(formatUpcomingTime(tickAt.toISOString(), timezone || 'UTC'))}</span>`;
    })
    .join('');
  const opportunitiesInView = schedule.filter((item) => {
    const at = Date.parse(item.at);
    return Number.isFinite(at) && at >= referenceInstant.getTime() && at <= endMs;
  }).length;
  const stateNote =
    !policy || policy.kind === 'manual'
      ? 'No automatic start is scheduled.'
      : !policy.enabled
        ? 'This schedule is paused.'
        : policy.kind === 'auto'
          ? 'A start may happen when a fresh update confirms a new window is available.'
          : opportunitiesInView === 0
            ? 'No start opportunity falls within this 24-hour view.'
            : `${opportunitiesInView} start ${opportunitiesInView === 1 ? 'opportunity' : 'opportunities'} in this view.`;
  const milestonesHtml = visibleMilestones.length
    ? `<ol class="horizon-milestones">${visibleMilestones.map((item) => `<li><time datetime="${escapeAttribute(item.at)}">${escapeHtml(formatReadableInstant(item.at, timezone || 'UTC'))}</time><span>${escapeHtml(item.label)}</span></li>`).join('')}</ol>`
    : `<p class="horizon-empty">${escapeHtml(stateNote)}</p>`;
  const stateDescription = currentIsFresh
    ? 'A fresh provider update reports a window in use.'
    : currentWindow?.status === 'ACTIVE'
      ? 'The last report showed a window in use, but it is too old to project.'
      : 'No current active window is projected.';
  const title = `24-hour schedule view. ${stateDescription} ${stateNote}`;
  const selectedHoursLegend =
    policy?.kind === 'active_hours'
      ? '<span><i class="horizon-legend-hours"></i>Chosen active hours</span>'
      : '';
  return `<div class="schedule-horizon"><div class="horizon-timeline-head"><strong>Now</strong><span>Next 24 hours</span></div><div class="horizon-chart-wrap"><svg class="schedule-horizon-chart" viewBox="0 0 1000 92" role="img" aria-label="${escapeAttribute(title)}"><title>${escapeHtml(title)}</title>${activeHoursSegments}<line class="horizon-track" x1="40" y1="48" x2="960" y2="48"/>${currentSegment}${projectedSegments}${ticks}${markerSvg}${nowLine}</svg><div class="horizon-axis" aria-hidden="true">${axis}</div></div><div class="horizon-legend">${selectedHoursLegend}<span><i class="horizon-legend-current"></i>Current window</span><span><i class="horizon-legend-projected"></i>Projected coverage</span><span><i class="horizon-legend-start"></i>Start opportunity</span></div><h3 class="horizon-milestones-title">Next milestones</h3>${milestonesHtml}<p class="field-help horizon-safety-note">${escapeHtml(stateDescription)} Schedule markers are opportunities; the service checks periodically and verifies safety before starting.</p></div>`;
}

function renderActiveHoursSegments(
  policy: Extract<ActivationPolicy, { kind: 'active_hours' }>,
  referenceInstant: Date,
  endMs: number,
  xFor: (instantMs: number) => number,
): string {
  const startDate = localDateAt(referenceInstant, policy.timezone);
  const segments: string[] = [];
  for (let dayOffset = -1; dayOffset <= 2; dayOffset += 1) {
    const localDate = shiftLocalDate(startDate, dayOffset);
    for (const period of policy.periods) {
      const starts = resolveLocalOccurrenceOnDate({
        localDate,
        localTime: period.start,
        timeZone: policy.timezone,
      }).instant.getTime();
      const endDate =
        localTimeMinutes(period.end) <= localTimeMinutes(period.start)
          ? shiftLocalDate(localDate, 1)
          : localDate;
      const ends = resolveLocalOccurrenceOnDate({
        localDate: endDate,
        localTime: period.end,
        timeZone: policy.timezone,
      }).instant.getTime();
      const leftMs = Math.max(referenceInstant.getTime(), starts);
      const rightMs = Math.min(endMs, ends);
      if (rightMs <= leftMs) continue;
      const left = xFor(leftMs);
      const right = xFor(rightMs);
      segments.push(
        `<rect class="horizon-active-hours" x="${left.toFixed(1)}" y="34" width="${(right - left).toFixed(1)}" height="28" rx="6"/>`,
      );
    }
  }
  return segments.join('');
}

function renderPolicyFields(kind: string, active: boolean, content: string): string {
  const state = active ? '' : ' hidden aria-hidden="true"';
  return `<div class="policy-fields" data-policy-fields="${escapeAttribute(kind)}"${state}>${active ? content : disableFormControls(content)}</div>`;
}

function renderPolicyChoice(
  value: string,
  title: string,
  description: string,
  icon: string,
  selected: boolean,
  disabled = false,
): string {
  const icons: Record<string, string> = {
    bolt: '<path d="M13 2 4 14h7l-1 8 10-13h-7z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    repeat:
      '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    hand: '<path d="M8 11V5a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 5-3 8-8 8h-1c-2 0-3-1-4-3l-3-5a2 2 0 0 1 4-2l1 2"/>',
  };
  const id = `policy-kind-${value}`;
  return `<label class="policy-choice${selected ? ' is-selected' : ''}" data-policy-choice><input id="${id}" type="radio" name="policyKind" value="${escapeAttribute(value)}"${selected ? ' checked' : ''}${disabled ? ' disabled' : ''} required><span class="policy-choice-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[icon] ?? ''}</svg></span><span class="policy-choice-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></span><span class="policy-choice-indicator" aria-hidden="true"></span></label>`;
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
  withPresets = false,
): string {
  const items = values.length ? values : [''];
  const presets = withPresets
    ? `<div class="schedule-presets" aria-label="Suggested times">${[
        ['09:00', 'Morning'],
        ['14:00', 'Afternoon'],
        ['18:00', 'Evening'],
      ]
        .map(
          ([time, title]) =>
            `<button type="button" class="button button-secondary" data-time-preset="${time}">${title} <span>${time}</span></button>`,
        )
        .join('')}</div>`
    : '';
  return `<div class="field dynamic-list-field"><span class="field-label">${escapeHtml(label)}</span><div id="${escapeAttribute(id)}" class="dynamic-list" data-schedule-list data-list-name="${escapeAttribute(name)}" data-list-kind="${kind}" aria-describedby="${escapeAttribute(helpId)}">${items.map((value, index) => renderPolicyListItem(id, name, kind, value, index)).join('')}<div class="dynamic-list-actions"><button class="button button-secondary dynamic-list-add" type="button" data-list-add>Add a time</button>${presets}</div><span class="field-help" id="${escapeAttribute(helpId)}">${escapeHtml(help)}</span></div></div>`;
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
  return `<div class="dynamic-list-item${kind === 'time' ? ' time-chip' : ''}" data-list-item><label for="${escapeAttribute(`${id}-${index}`)}">${escapeHtml(label)}<input id="${escapeAttribute(`${id}-${index}`)}" name="${escapeAttribute(name)}" type="${type}" value="${escapeAttribute(value)}"${placeholder ? ` placeholder="${placeholder}"` : ''} required data-list-value></label><button class="button button-secondary dynamic-list-remove" type="button" data-list-remove>Remove</button></div>`;
}

function renderActiveHoursField(periods: readonly { start: string; end: string }[]): string {
  const values = periods.length ? periods : [{ start: '', end: '' }];
  const items = values
    .map(
      (period, index) =>
        `<div class="dynamic-list-item active-period-item" data-list-item><label for="active-hours-periods-start-${index}">From<input id="active-hours-periods-start-${index}" name="periodStarts" type="time" value="${escapeAttribute(period.start)}" required data-period-start></label><label for="active-hours-periods-end-${index}">To<input id="active-hours-periods-end-${index}" name="periodEnds" type="time" value="${escapeAttribute(period.end)}" required data-period-end></label><button class="button button-secondary dynamic-list-remove" type="button" data-list-remove aria-label="Remove active-hours period ${index + 1}">Remove</button></div>`,
    )
    .join('');
  return `<div class="field dynamic-list-field"><span class="field-label">Active hours</span><div id="active-hours-periods" class="dynamic-list" data-schedule-list data-list-name="periods" data-list-kind="period" aria-describedby="active-hours-periods-help">${items}<div class="dynamic-list-actions"><button class="button button-secondary dynamic-list-add" type="button" data-list-add>Add a time range</button><div class="schedule-presets" aria-label="Suggested active hours"><button type="button" class="button button-secondary" data-period-preset-start="08:00" data-period-preset-end="18:00">Workday <span>08:00–18:00</span></button><button type="button" class="button button-secondary" data-period-preset-start="13:00" data-period-preset-end="22:00">Afternoon / night <span>13:00–22:00</span></button></div></div><span class="field-help" id="active-hours-periods-help">Choose the local hours when a new window may start.</span></div></div>`;
}

function renderWindowTargetField(
  provider: SettingsProviderView | undefined,
  targets: readonly WindowTargetDescriptor[],
  resolution: WindowTargetResolution,
  helpText: string,
): string {
  const selectedWindowKind = resolution.status === 'resolved' ? resolution.target.windowKind : '';
  const select = renderWindowTargetControl(targets, selectedWindowKind, targets.length > 0);
  const selectedTarget = resolution.status === 'resolved' ? resolution.target : undefined;
  const selectedGroupLabel = selectedTarget?.groupLabel;
  const selectedTargetSummary = selectedTarget
    ? `<p class="managed-window-summary"><span class="field-label">Currently managing</span><strong>${escapeHtml(selectedGroupLabel ? `${selectedGroupLabel} · ${selectedTarget.label}` : selectedTarget.label)}</strong></p>`
    : '';
  const triggerModel = triggerModelForTarget(provider, selectedTarget);
  const triggerModelNote = triggerModel
    ? `<p class="managed-window-model"><span class="field-label">Trigger model</span><code>${escapeHtml(triggerModel)}</code></p>`
    : '';
  const resolutionNote = renderWindowTargetResolutionNote(resolution, targets.length);
  const sideEffectWarning = crossWindowSideEffectWarning(provider);
  const sideEffectNote = sideEffectWarning
    ? `<p class="policy-guidance" role="note">${escapeHtml(sideEffectWarning)}</p>`
    : '';
  return `<div class="managed-window-target">${renderField('schedule-window-kind', 'Usage window', select, helpText, 'schedule-window-kind-help')}${selectedTargetSummary}${triggerModelNote}${resolutionNote}${sideEffectNote}</div>`;
}

function triggerModelForTarget(
  provider: SettingsProviderView | undefined,
  target: WindowTargetDescriptor | undefined,
): string | undefined {
  if (
    !provider ||
    provider.kind !== 'antigravity' ||
    provider.capabilities?.windowTrigger.supported !== true ||
    !provider.triggerModels
  ) {
    return undefined;
  }
  if (target?.groupLabel === 'Gemini Models') return provider.triggerModels.gemini;
  if (target?.groupLabel === 'Claude and GPT Models') return provider.triggerModels.claudeGpt;
  return undefined;
}

function renderWindowTargetResolutionNote(
  resolution: WindowTargetResolution,
  targetCount: number,
): string {
  if (targetCount === 0) {
    return '<p class="field-help" role="status">Waiting for a provider-reported usage window. No target has been invented; automatic schedules are unavailable until an exact window is reported.</p>';
  }
  if (resolution.status === 'resolved' && resolution.source === 'legacy') {
    return `<p class="field-help" role="status">The saved ${escapeHtml(resolution.target.label.toLowerCase())} preference matches the only reported window of this cadence. Saving will associate it with that exact window.</p>`;
  }
  if (resolution.status === 'ambiguous') {
    const matches = resolution.matches
      .map((target) => escapeHtml(windowTargetSummary(target, resolution.matches)))
      .join(', ');
    return `<p class="field-help" role="alert">The saved ${escapeHtml(cadenceLabel(resolution.legacyCadence).toLowerCase())} target matches multiple reported windows (${matches}). Choose the exact window below; the schedule will not guess.</p>`;
  }
  if (resolution.status === 'unresolved') {
    return '<p class="field-help" role="alert">The saved target is not currently reported by this provider. Choose one of the exact reported windows before saving automatic scheduling.</p>';
  }
  if (resolution.status === 'none') {
    return '<p class="field-help">Choose one exact reported window. The first window is never selected automatically.</p>';
  }
  return '';
}

function renderUnresolvedScheduleExplanation(
  targets: readonly WindowTargetDescriptor[],
  resolution: WindowTargetResolution,
): string {
  if (targets.length === 0) {
    return '<p class="schedule-explanation">Waiting for a provider-reported usage window. No automatic start can be planned until one is available.</p>';
  }
  if (resolution.status === 'ambiguous') {
    return '<p class="schedule-explanation">Choose one exact reported window to resolve this schedule. No target will be guessed.</p>';
  }
  return '<p class="schedule-explanation">Choose an exact provider-reported window before this automatic schedule can be evaluated.</p>';
}

function windowTargetSummary(
  target: WindowTargetDescriptor,
  peers: readonly WindowTargetDescriptor[],
): string {
  const groupPeers = peers.filter((peer) => peer.groupLabel === target.groupLabel);
  const label = windowTargetOptionLabel(target, groupPeers);
  return target.groupLabel ? `${target.groupLabel} · ${label}` : label;
}

function windowTargetOptionLabel(
  target: WindowTargetDescriptor,
  peers: readonly WindowTargetDescriptor[],
): string {
  const sameLabel = peers.filter((peer) => peer.label === target.label);
  if (sameLabel.length <= 1) return target.label;
  const ordinal = sameLabel.findIndex((peer) => peer.windowKind === target.windowKind) + 1;
  return `${target.label} · Window ${ordinal}`;
}

function cadenceLabel(cadence: 'five_hour' | 'weekly'): string {
  return cadence === 'five_hour' ? '5-hour window' : 'Weekly window';
}

function crossWindowSideEffectWarning(provider: SettingsProviderView | undefined): string {
  const kind = `${provider?.kind ?? ''} ${provider?.id ?? ''}`.toLowerCase();
  if (kind.includes('antigravity') || kind.includes('agy')) {
    return 'A start may use quota in both the 5-hour and weekly windows in this group. The selected group chooses the model family; it does not limit which of that family’s quotas the provider charges.';
  }
  if (kind.includes('codex')) {
    return 'This choice controls which Codex window the schedule follows; a start request may still count against more than one Codex quota window.';
  }
  if ((provider?.windows?.length ?? 0) > 1) {
    return 'A start request may affect other quota windows too. This choice controls scheduling and confirmation, not provider-side quota isolation.';
  }
  return '';
}

function plannerReasonLabel(reasonCode: string): string {
  const labels: Record<string, string> = {
    POLICY_DISABLED: 'Automatic starts are turned off.',
    MANUAL_POLICY: 'New windows are started only by you.',
    AUTOMATION_DISABLED: 'Monitoring continues, but automatic starts are turned off.',
    TRIGGER_CAPABILITY_UNAVAILABLE: 'This provider cannot start a window automatically.',
    WINDOW_TARGET_NOT_SELECTED: 'Choose one reported usage window for this schedule.',
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

function timeZoneOffsetLabel(timeZone: string, instant: Date): string {
  try {
    const value = new Intl.DateTimeFormat('en', {
      timeZone,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(instant)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (!value || value === 'GMT' || value === 'UTC') return 'UTC+00:00';
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
    return match
      ? `UTC${match[1]}${match[2]?.padStart(2, '0')}:${match[3] ?? '00'}`
      : value.replace(/^GMT/, 'UTC');
  } catch {
    return 'offset unavailable';
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
  const referenceInstant = input.referenceInstant ?? DEFAULT_REFERENCE_INSTANT;
  const knownZones = new Set<string>(
    TIME_ZONE_GROUPS.flatMap(([, zones]) => zones.map(([zone]) => zone)),
  );
  const timezoneOptions = TIME_ZONE_GROUPS.map(
    ([region, zones]) =>
      `<optgroup label="${region}">${zones.map(([zone, label]) => `<option value="${escapeAttribute(zone)}"${zone === timezoneValue ? ' selected' : ''}>${escapeHtml(label)} (${escapeHtml(timeZoneOffsetLabel(zone, referenceInstant))})</option>`).join('')}</optgroup>`,
  ).join('');
  const savedZoneOption =
    timezoneValue && !knownZones.has(timezoneValue)
      ? `<optgroup label="Saved location"><option value="${escapeAttribute(timezoneValue)}" selected>${escapeHtml(timezoneValue)} (${escapeHtml(timeZoneOffsetLabel(timezoneValue, referenceInstant))})</option></optgroup>`
      : '';
  const timezoneField = `<select id="account-timezone" name="timezoneChoice" data-timezone-select data-timezone-auto-detect="${input.timezone ? 'false' : 'true'}" required><option value=""${timezoneValue ? '' : ' selected'} disabled>Choose your local time zone</option>${timezoneOptions}${savedZoneOption}</select>`;
  const authProviders = new Map<string, AuthOnboardingInput>(
    (input.authProviders ?? []).map((provider) => [provider.providerId, provider] as const),
  );
  const providerSections = input.providers.length
    ? input.providers
        .map((provider) => renderProviderCard(provider, csrfToken, authProviders.get(provider.id)))
        .join('\n')
    : renderEmptyState(
        'No providers configured',
        'Add a provider through service configuration before changing runtime settings.',
      );

  return renderAppShell({
    page: 'settings',
    title: 'Settings',
    description: 'Choose what to monitor, when to check, and your local time zone.',
    content: `<div class="settings-page">${input.notice ? renderNotice(input.notice) : ''}
      <section class="card timezone-settings" aria-labelledby="timezone-settings-title"><div class="card-header"><div class="heading-copy"><p class="eyebrow">Dates and schedules</p><h2 id="timezone-settings-title">Time Zone</h2><p class="muted">Schedules and window resets are displayed in this time zone.</p></div></div><form method="post" action="/settings/timezone" data-timezone-settings><input type="hidden" name="csrfToken" value="${csrfToken}"><div class="form-grid">${renderField('account-timezone', 'Your time zone', timezoneField, 'Choose a city in your region. The current UTC offset is shown beside each choice.', 'account-timezone-help')}</div><input type="hidden" name="source" value="manual"><p class="field-help timezone-detection-status" data-timezone-status aria-live="polite"></p><div class="form-actions"><button type="submit">Save time zone</button></div></form></section>
      <section aria-labelledby="provider-settings-title">
        <div class="section-heading"><div class="heading-copy"><p class="eyebrow">Accounts</p><h2 id="provider-settings-title">Providers</h2><p class="muted">Manage connected accounts and update frequencies.</p></div></div>
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
  const windowTargets = observedWindowTargets(providerId, selectedProvider?.windows);
  const targetResolution = resolveWindowTarget(windowKind || undefined, windowTargets);
  const selectedWindowKind =
    targetResolution.status === 'resolved' ? targetResolution.target.windowKind : '';
  const basePreview =
    targetResetLocalTime && timezone
      ? previewTargetReset({
          localTime: targetResetLocalTime,
          timeZone: timezone,
          referenceInstant: input.referenceInstant,
        })
      : unknownPreview(targetResetLocalTime || null, timezone || null);
  const preview = addWindowCandidate(basePreview, selectedProvider, selectedWindowKind);
  const providerPicker = renderProviderPicker({
    name: 'providerId',
    legend: 'Provider',
    options: input.providers.map((provider) => ({
      value: provider.id,
      label: providerDisplayName(provider.id, provider.kind),
      kind: provider.kind,
      ...(provider.configured !== undefined ? { configured: provider.configured } : {}),
      ...(provider.connectionLabel ? { statusLabel: provider.connectionLabel } : {}),
    })),
    selectedValue: providerId,
    required: input.providers.length > 0,
    describedBy: 'schedule-provider-help',
    helpText: 'Choose which connected provider supplies the usage information.',
    emptyText: 'No providers configured',
  });

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
                ${providerPicker}
                ${renderWindowTargetField(selectedProvider, windowTargets, targetResolution, 'Choose the exact provider-reported window whose reset you want to plan around.')}
                ${renderField('schedule-target-reset', 'Reset time', `<input id="schedule-target-reset" name="targetResetLocalTime" type="time" value="${escapeAttribute(targetResetLocalTime)}" step="60" aria-describedby="schedule-target-reset-help" required>`, 'The local time when this usage window is expected to reset.', 'schedule-target-reset-help')}
                ${renderField('schedule-timezone', 'Timezone', `<input id="schedule-timezone" name="timezone" value="${escapeAttribute(timezone)}" placeholder="America/Sao_Paulo" maxlength="128" aria-describedby="schedule-timezone-help" required>`, 'Use an IANA timezone so daylight-saving transitions remain explicit.', 'schedule-timezone-help')}
                ${renderField('schedule-tolerance', 'Timing tolerance', `<input id="schedule-tolerance" name="toleranceSeconds" type="number" min="${MIN_TOLERANCE_SECONDS}" max="${MAX_TOLERANCE_SECONDS}" value="${toleranceSeconds === null ? '' : toleranceSeconds}" aria-describedby="schedule-tolerance-help" required>`, 'How many seconds of variation are acceptable around the planned start.', 'schedule-tolerance-help')}
              </div>
            </fieldset>
            <div class="form-actions"><button type="submit"${windowTargets.length ? '' : ' disabled'}>Save schedule</button></div>
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

function renderProviderCard(
  provider: SettingsProviderView,
  csrfToken: string,
  authProvider?: AuthOnboardingInput,
): string {
  const id = safeId(provider.id);
  const connection = providerConnectionState(provider, authProvider);
  const canAutomate = provider.capabilities?.windowTrigger.supported === true;
  const automationOption = canAutomate
    ? `<option value="automation"${provider.mode === 'automation' ? ' selected' : ''}>On (auto-start allowed)</option>`
    : `<option value="automation"${provider.mode === 'automation' ? ' selected' : ''} disabled>Automatic start unavailable</option>`;
  const automationHelp = canAutomate
    ? 'A new window may start when your schedule and safety checks allow it. This can use your provider’s allowance.'
    : provider.capabilities
      ? 'Automatic starts are not available for this provider.'
      : 'Connect and verify this provider before automatic starts are available.';
  const displayName = providerDisplayName(provider.id, provider.kind);
  const logoUrl = providerLogoUrl(provider.id, provider.kind);
  const logoHtml = logoUrl
    ? `<img class="provider-logo" src="${logoUrl}" alt="" width="34" height="34">`
    : '';
  const connected = connection.ready;
  const authPanel = authProvider
    ? renderAuthOnboarding({ ...authProvider, reconnect: connected })
    : '';
  const authArea = authPanel
    ? `<${connected ? 'details class="provider-reconnect"' : 'div class="provider-auth-area"'} data-provider-auth-area>${connected ? '<summary>Reconnect account</summary>' : ''}${authPanel}${connected ? '</details>' : '</div>'}`
    : '';
  const controlsLocked = authProvider !== undefined && !connected;
  const pollPreset = [60, 300, 900].includes(provider.pollIntervalSeconds)
    ? String(provider.pollIntervalSeconds)
    : 'custom';
  const customIntervalDisabled = pollPreset !== 'custom' ? ' disabled' : '';

  return `<article class="card provider-settings" aria-labelledby="provider-${id}-title" data-provider-connected="${connected ? 'true' : 'false'}">
    <header class="provider-header"><div class="provider-identity">${logoHtml}<div><p class="eyebrow">Provider</p><h3 id="provider-${id}-title">${escapeHtml(displayName)}</h3></div></div><span class="badge provider-connection-badge" data-provider-connection-status data-connection-state="${connection.state}" aria-label="${escapeHtml(displayName)} account status"><span class="online-indicator" aria-hidden="true"></span><span data-provider-connection-label>${escapeHtml(connection.label)}</span></span></header>
    ${authArea}
    <p class="provider-monitoring-note" data-provider-monitoring-note${controlsLocked ? '' : ' hidden'}>Connect your account to customize monitoring settings.</p>
    <form method="post" action="/settings/providers/${escapeAttribute(encodeURIComponent(provider.id))}" data-provider-settings-form${controlsLocked ? ' hidden' : ''}>
      ${csrfInput(csrfToken)}
      <fieldset><legend>Monitoring settings</legend><div class="form-grid">
        ${renderField(`provider-${id}-enabled`, 'Monitoring', `<select id="provider-${id}-enabled" name="enabled" aria-describedby="provider-${id}-enabled-help">${booleanOptions(provider.enabled, 'On', 'Paused')}</select>`, 'Turn off monitoring to pause new usage checks.', `provider-${id}-enabled-help`)}
        ${renderField(`provider-${id}-mode`, 'Automatic window start', `<select id="provider-${id}-mode" name="mode" aria-describedby="provider-${id}-mode-help"><option value="monitor_only"${provider.mode === 'monitor_only' ? ' selected' : ''}>Off (monitoring only)</option>${automationOption}</select>`, automationHelp, `provider-${id}-mode-help`)}
        ${renderPollIntervalField(provider, id, pollPreset, customIntervalDisabled)}
      </div></fieldset>
      <div class="form-actions"><button type="submit">Save settings</button></div>
    </form>
    <details class="capability-details"><summary>What this provider can do</summary>${renderCapabilitySummary(provider.capabilities)}</details>
  </article>`;
}

function providerConnectionState(
  provider: SettingsProviderView,
  authProvider?: AuthOnboardingInput,
): {
  state: 'connected' | 'connecting' | 'required' | 'disconnected';
  label: string;
  ready: boolean;
} {
  const authStatus = authProvider?.status;
  if (authStatus?.state === 'SUCCEEDED' || authStatus?.reasonCode === 'ALREADY_AUTHENTICATED') {
    return { state: 'connected', label: 'Connected', ready: true };
  }
  if (authStatus && ['STARTING', 'AWAITING_USER_ACTION', 'VERIFYING'].includes(authStatus.state)) {
    const wasConnected =
      provider.configured === true && provider.connectionLabel !== 'Sign in to connect';
    return { state: 'connecting', label: 'Signing in…', ready: wasConnected };
  }
  if (
    authStatus?.reasonCode === 'AUTH_REQUIRED' ||
    provider.connectionLabel === 'Sign in to connect'
  ) {
    return { state: 'required', label: 'Sign-in required', ready: false };
  }
  if (
    provider.configured === true ||
    provider.connectionLabel === 'Connected' ||
    provider.connectionLabel === 'Needs attention'
  ) {
    return { state: 'connected', label: 'Connected', ready: true };
  }
  return { state: 'disconnected', label: 'Not connected', ready: false };
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

function renderWindowTargetControl(
  targets: readonly WindowTargetDescriptor[],
  selectedWindowKind: string,
  required: boolean,
): string {
  if (targets.length === 0) {
    return '<select id="schedule-window-kind" name="windowKind" aria-describedby="schedule-window-kind-help" disabled><option value="" selected>No provider window reported</option></select>';
  }

  const grouped = new Map<string | null, WindowTargetDescriptor[]>();
  for (const target of targets) {
    const group = target.groupLabel;
    const entries = grouped.get(group) ?? [];
    entries.push(target);
    grouped.set(group, entries);
  }

  const options = [...grouped.entries()]
    .map(([group, groupTargets]) => {
      const rendered = groupTargets
        .map((target) => {
          const label = windowTargetOptionLabel(target, groupTargets);
          return `<option value="${escapeAttribute(target.windowKind)}"${target.windowKind === selectedWindowKind ? ' selected' : ''}>${escapeHtml(label)}</option>`;
        })
        .join('');
      return group
        ? `<optgroup label="${escapeAttribute(group)}">${rendered}</optgroup>`
        : rendered;
    })
    .join('');
  const placeholder = selectedWindowKind
    ? ''
    : '<option value="" selected disabled>Choose a reported usage window</option>';
  return `<select id="schedule-window-kind" name="windowKind" aria-describedby="schedule-window-kind-help"${required ? ' required' : ''}>${placeholder}${options}</select>`;
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
