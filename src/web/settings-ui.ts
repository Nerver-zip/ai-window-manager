import type { Confidence, ProviderCapabilities, WindowSnapshot } from '../domain/types.js';
import { resolveLocalOccurrence, type LocalOccurrence } from '../scheduler/time.js';
import type { ProviderMode } from '../storage/repositories.js';
import { renderAppShell } from './ui/layout.js';
import {
  capabilityDescription,
  capabilityContractLabel,
  capabilityLabel,
  durationLabel,
  effectiveModeLabel,
  providerDisplayName,
  windowDisplayName,
} from './ui/presentation.js';

// These are browser hints only. settings-api.ts remains the server-side authority.
const MIN_POLL_INTERVAL_SECONDS = 30;
const MAX_POLL_INTERVAL_SECONDS = 86_400;
const MIN_TOLERANCE_SECONDS = 0;
const MAX_TOLERANCE_SECONDS = 3_600;
const KNOWN_DURATION_CONFIDENCES = new Set<Confidence>(['exact', 'high']);

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
  notice?: string;
}

export interface SchedulePageInput {
  csrfToken: string;
  providers: readonly SettingsProviderView[];
  policy?: Partial<SchedulePolicyView>;
  referenceInstant: Date;
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
  const providerSections = input.providers.length
    ? input.providers.map((provider) => renderProviderCard(provider, csrfToken)).join('\n')
    : renderEmptyState(
        'No providers configured',
        'Add a provider through service configuration before changing runtime settings.',
      );

  return renderAppShell({
    page: 'settings',
    title: 'Settings',
    description: 'Control what is monitored and how often it refreshes.',
    content: `<div class="settings-page">${input.notice ? renderNotice(input.notice) : ''}
      <section aria-labelledby="provider-settings-title">
        <div class="section-heading"><p class="eyebrow">Provider connection</p><h2 id="provider-settings-title">Connection and monitoring</h2><p class="muted">Only non-secret settings are editable here. Sign-in stays with the official provider client.</p></div>
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
    ? `<option value="automation"${provider.mode === 'automation' ? ' selected' : ''}>Automatic actions</option>`
    : `<option value="automation"${provider.mode === 'automation' ? ' selected' : ''} disabled>Automatic actions unavailable</option>`;
  const automationHelp = canAutomate
    ? 'The app may start a new usage window when the schedule and safety checks allow it. This can use provider quota.'
    : provider.capabilities
      ? 'Automatic actions are unavailable because this provider does not support them.'
      : 'Automatic actions remain unavailable until this provider can be verified.';
  const displayName = providerDisplayName(provider.id, provider.kind);

  return `<article class="card provider-settings" aria-labelledby="provider-${id}-title">
    <header class="provider-header"><div><p class="eyebrow">Provider</p><h3 id="provider-${id}-title">${escapeHtml(displayName)}</h3><p class="provider-meta">${provider.enabled ? 'Monitoring enabled' : 'Monitoring paused'}</p></div><div class="badges" aria-label="${escapeHtml(displayName)} status"><span class="badge ${provider.enabled ? 'badge-success' : ''}">${provider.enabled ? 'Monitoring enabled' : 'Monitoring paused'}</span><span class="badge">${escapeHtml(effectiveModeLabel(provider.mode, provider.capabilities?.windowTrigger.supported))}</span></div></header>
    <form method="post" action="/settings/providers/${escapeAttribute(encodeURIComponent(provider.id))}">
      ${csrfInput(csrfToken)}
      <fieldset><legend>Provider controls</legend><div class="form-grid">
        ${renderField(`provider-${id}-enabled`, 'Monitoring', `<select id="provider-${id}-enabled" name="enabled" aria-describedby="provider-${id}-enabled-help">${booleanOptions(provider.enabled, 'On', 'Paused')}</select>`, 'Paused providers keep their saved history but are not checked for new usage.', `provider-${id}-enabled-help`)}
        ${renderField(`provider-${id}-mode`, 'Automatic actions', `<select id="provider-${id}-mode" name="mode" aria-describedby="provider-${id}-mode-help"><option value="monitor_only"${provider.mode === 'monitor_only' ? ' selected' : ''}>Monitoring only</option>${automationOption}</select>`, automationHelp, `provider-${id}-mode-help`)}
        ${renderField(`provider-${id}-poll`, 'Refresh interval', `<input id="provider-${id}-poll" name="pollIntervalSeconds" type="number" min="${MIN_POLL_INTERVAL_SECONDS}" max="${MAX_POLL_INTERVAL_SECONDS}" value="${escapeAttribute(String(provider.pollIntervalSeconds))}" aria-describedby="provider-${id}-poll-help" required>`, `How often the app checks this provider, from ${MIN_POLL_INTERVAL_SECONDS} to ${MAX_POLL_INTERVAL_SECONDS} seconds.`, `provider-${id}-poll-help`)}
      </div></fieldset>
      <div class="form-actions"><button type="submit">Save provider settings</button></div>
    </form>
    <section aria-labelledby="provider-${id}-capabilities-title"><h4 id="provider-${id}-capabilities-title">What this provider supports</h4>${renderCapabilitySummary(provider.capabilities)}</section>
  </article>`;
}

function renderCapabilitySummary(capabilities: ProviderCapabilities | undefined): string {
  if (!capabilities)
    return '<p class="unknown"><span class="badge">Not available</span> We could not verify this provider yet, so it remains monitoring-only.</p>';
  return `<dl>${renderCapabilityRow('usageRead', capabilities.usageRead)}${renderCapabilityRow('resetRead', capabilities.resetRead)}${renderCapabilityRow('windowTrigger', capabilities.windowTrigger, capabilities.windowTrigger.consumesQuota)}</dl>`;
}

function renderCapabilityRow(
  capabilityName: 'usageRead' | 'resetRead' | 'windowTrigger',
  capability: ProviderCapabilities['usageRead'] | ProviderCapabilities['windowTrigger'],
  consumesQuota?: boolean | 'unknown',
): string {
  const status = capability.supported ? 'Available' : 'Unavailable';
  const quota =
    consumesQuota === true
      ? ' · May use provider quota'
      : consumesQuota === false
        ? ' · Does not use provider quota'
        : consumesQuota === 'unknown'
          ? ' · Quota impact not available'
          : '';
  return `<div><dt>${escapeHtml(capabilityLabel(capabilityName))}</dt><dd><span class="badge ${capability.supported ? 'badge-success' : 'badge-warning'}">${status}</span> <span class="muted">· ${escapeHtml(capabilityContractLabel(capability.contract))}${escapeHtml(quota)}</span><br><small>${escapeHtml(capabilityDescription(capabilityName, capability.supported))}</small></dd></div>`;
}

function renderProviderOption(provider: SettingsProviderView, selectedProviderId: string): string {
  const state =
    provider.mode === 'automation' && provider.capabilities?.windowTrigger.supported === true
      ? 'Automatic actions available'
      : 'Monitoring only';
  return `<option value="${escapeAttribute(provider.id)}"${provider.id === selectedProviderId ? ' selected' : ''}>${escapeHtml(providerDisplayName(provider.id, provider.kind))} · ${state}</option>`;
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
