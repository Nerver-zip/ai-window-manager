import type { Confidence, ProviderCapabilities, WindowSnapshot } from '../domain/types.js';
import { resolveLocalOccurrence, type LocalOccurrence } from '../scheduler/time.js';
import type { ProviderMode } from '../storage/repositories.js';
import { renderAppShell } from './ui/layout.js';

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
    description: 'Configure provider polling and safe automation boundaries.',
    content: `<div class="settings-page">${input.notice ? renderNotice(input.notice) : ''}
      <section aria-labelledby="provider-settings-title">
        <div class="section-heading"><p class="eyebrow">Runtime configuration</p><h2 id="provider-settings-title">Provider settings</h2><p class="muted">Only non-secret settings are editable here. Provider authentication stays owned by the official client.</p></div>
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
    description: 'Position a known usage window around a local reset target.',
    content: `<div class="schedule-page">${input.notice ? renderNotice(input.notice) : ''}
      <div class="schedule-layout">
        <section class="card" aria-labelledby="schedule-config-title">
          <div class="card-header"><p class="eyebrow">Policy</p><h2 id="schedule-config-title">Target-reset schedule</h2><p class="muted">Choose a local reset target. The scheduler keeps timezone and DST decisions explicit.</p></div>
          <form method="post" action="/schedule">
            ${csrfInput(csrfToken)}
            <fieldset>
              <legend>Schedule configuration</legend>
              <div class="form-grid">
                ${renderField('schedule-enabled', 'Enabled', `<select id="schedule-enabled" name="enabled" aria-describedby="schedule-enabled-help">${booleanOptions(policy.enabled)}</select>`, 'When disabled, the policy is retained but no action intent is created.', 'schedule-enabled-help')}
                ${renderField('schedule-provider', 'Provider', `<select id="schedule-provider" name="providerId" aria-describedby="schedule-provider-help" required>${providerOptions}</select>`, 'The provider whose usage window supplies the preview and scheduling facts.', 'schedule-provider-help')}
                ${renderField('schedule-window-kind', 'Window', `<input id="schedule-window-kind" name="windowKind" value="${escapeAttribute(windowKind)}" placeholder="five_hour" maxlength="64" pattern="[a-z0-9][a-z0-9_-]*" aria-describedby="schedule-window-kind-help" required>`, 'Use the provider window kind exactly as observed, for example five_hour.', 'schedule-window-kind-help')}
                ${renderField('schedule-target-reset', 'Target reset', `<input id="schedule-target-reset" name="targetResetLocalTime" type="time" value="${escapeAttribute(targetResetLocalTime)}" step="60" aria-describedby="schedule-target-reset-help" required>`, 'The local wall-clock time the selected window should reset around.', 'schedule-target-reset-help')}
                ${renderField('schedule-timezone', 'Timezone', `<input id="schedule-timezone" name="timezone" value="${escapeAttribute(timezone)}" placeholder="America/Sao_Paulo" maxlength="128" aria-describedby="schedule-timezone-help" required>`, 'Use an IANA timezone so daylight-saving transitions remain explicit.', 'schedule-timezone-help')}
                ${renderField('schedule-tolerance', 'Tolerance', `<input id="schedule-tolerance" name="toleranceSeconds" type="number" min="${MIN_TOLERANCE_SECONDS}" max="${MAX_TOLERANCE_SECONDS}" value="${toleranceSeconds === null ? '' : toleranceSeconds}" aria-describedby="schedule-tolerance-help" required>`, 'How close to the target trigger the scheduler may consider the policy due, in seconds.', 'schedule-tolerance-help')}
              </div>
            </fieldset>
            <div class="form-actions"><button type="submit">Save schedule</button></div>
          </form>
        </section>
        <aside class="card schedule-preview" aria-labelledby="schedule-preview-title">
          <div class="card-header"><p class="eyebrow">Live preview</p><h2 id="schedule-preview-title">Next schedule</h2><p class="muted">Preview uses persisted observations only and never inspects a provider.</p></div>
          ${renderSchedulePreview(preview)}
          ${renderScheduleSafety(selectedProvider)}
        </aside>
      </div>
    </div>`,
  });
}

export function renderSchedulePreview(preview: SchedulePreview): string {
  if (preview.status === 'unknown') {
    return `<div class="schedule-preview schedule-preview--unknown"><p class="badge">Preview unavailable</p><p>${escapeHtml(preview.message)}</p>${renderCandidateMetric(preview)}</div>`;
  }

  const resolution = resolutionLabel(preview.resolution);
  return `<div class="schedule-preview schedule-preview--resolved">
    <div class="form-grid">
      <div class="preview-metric"><span class="muted">Target reset</span><strong class="preview-time">${escapeHtml(preview.resolvedLocalTime ?? 'unknown')}</strong><span class="muted">${escapeHtml(preview.localDate ?? 'local date unknown')} local</span></div>
      ${renderCandidateMetric(preview)}
      <div class="preview-metric"><span class="muted">Timezone</span><strong>${escapeHtml(preview.timeZone ?? 'unknown')}</strong><span class="muted">IANA local time</span></div>
      <div class="preview-metric"><span class="muted">DST resolution</span><strong data-resolution="${escapeAttribute(preview.resolution ?? 'unknown')}">${escapeHtml(resolution)}</strong><span class="muted">${escapeHtml(preview.message)}</span></div>
    </div>
    <details><summary>Technical details</summary><dl><dt>Target instant</dt><dd>${escapeHtml(preview.instantIso)}</dd><dt>Requested local time</dt><dd>${escapeHtml(preview.requestedLocalTime)}</dd><dt>Resolution</dt><dd>${escapeHtml(preview.resolution)}</dd></dl></details>
  </div>`;
}

function renderProviderCard(provider: SettingsProviderView, csrfToken: string): string {
  const id = safeId(provider.id);
  const canAutomate = provider.capabilities?.windowTrigger.supported === true;
  const automationOption = canAutomate
    ? `<option value="automation"${provider.mode === 'automation' ? ' selected' : ''}>Automation</option>`
    : `<option value="automation"${provider.mode === 'automation' ? ' selected' : ''} disabled>Automation unavailable</option>`;
  const automationHelp = canAutomate
    ? 'Automation is supported by this provider. Any trigger may consume provider quota; review the capability summary below.'
    : provider.capabilities
      ? 'Automation is disabled because this provider does not advertise a supported trigger capability.'
      : 'Capability data is unavailable, so automation remains disabled until the provider can be verified.';

  return `<article class="card provider-settings" aria-labelledby="provider-${id}-title">
    <header class="provider-header"><div><p class="eyebrow">Provider</p><h3 id="provider-${id}-title">${escapeHtml(provider.id)}</h3><p class="provider-meta">${escapeHtml(provider.kind)}</p></div><div class="badges" aria-label="${escapeHtml(provider.id)} status"><span class="badge ${provider.enabled ? 'badge-success' : ''}">${provider.enabled ? 'Enabled' : 'Disabled'}</span><span class="badge">${provider.mode === 'automation' ? 'Automation' : 'Monitor only'}</span></div></header>
    <form method="post" action="/settings/providers/${escapeAttribute(encodeURIComponent(provider.id))}">
      ${csrfInput(csrfToken)}
      <fieldset><legend>Runtime settings</legend><div class="form-grid">
        ${renderField(`provider-${id}-enabled`, 'Enabled', `<select id="provider-${id}-enabled" name="enabled" aria-describedby="provider-${id}-enabled-help">${booleanOptions(provider.enabled)}</select>`, 'Disabled providers retain history but are not polled by the reconciler.', `provider-${id}-enabled-help`)}
        ${renderField(`provider-${id}-mode`, 'Operating mode', `<select id="provider-${id}-mode" name="mode" aria-describedby="provider-${id}-mode-help"><option value="monitor_only"${provider.mode === 'monitor_only' ? ' selected' : ''}>Monitor only</option>${automationOption}</select>`, automationHelp, `provider-${id}-mode-help`)}
        ${renderField(`provider-${id}-poll`, 'Poll interval', `<input id="provider-${id}-poll" name="pollIntervalSeconds" type="number" min="${MIN_POLL_INTERVAL_SECONDS}" max="${MAX_POLL_INTERVAL_SECONDS}" value="${escapeAttribute(String(provider.pollIntervalSeconds))}" aria-describedby="provider-${id}-poll-help" required>`, `How often to refresh this provider, from ${MIN_POLL_INTERVAL_SECONDS} to ${MAX_POLL_INTERVAL_SECONDS} seconds.`, `provider-${id}-poll-help`)}
      </div></fieldset>
      <div class="form-actions"><button type="submit">Save provider settings</button></div>
    </form>
    <section aria-labelledby="provider-${id}-capabilities-title"><h4 id="provider-${id}-capabilities-title">Capability summary</h4>${renderCapabilitySummary(provider.capabilities)}</section>
  </article>`;
}

function renderCapabilitySummary(capabilities: ProviderCapabilities | undefined): string {
  if (!capabilities)
    return '<p class="unknown"><span class="badge">Unknown</span> Capability status is unavailable. This provider remains monitor-only in the UI.</p>';
  return `<dl>${renderCapabilityRow('Usage inspection', capabilities.usageRead)}${renderCapabilityRow('Reset timing', capabilities.resetRead)}${renderCapabilityRow('Window trigger', capabilities.windowTrigger, capabilities.windowTrigger.consumesQuota)}</dl>`;
}

function renderCapabilityRow(
  label: string,
  capability: ProviderCapabilities['usageRead'] | ProviderCapabilities['windowTrigger'],
  consumesQuota?: boolean | 'unknown',
): string {
  const status = capability.supported ? 'Supported' : 'Unavailable';
  const quota =
    consumesQuota === true
      ? ' · consumes quota'
      : consumesQuota === false
        ? ' · no quota consumption declared'
        : consumesQuota === 'unknown'
          ? ' · quota impact unknown'
          : '';
  return `<div><dt>${escapeHtml(label)}</dt><dd><span class="badge ${capability.supported ? 'badge-success' : 'badge-warning'}">${status}</span> <span class="muted">${escapeHtml(contractLabel(capability.contract))}${escapeHtml(quota)}</span>${capability.notes ? `<br><small>${escapeHtml(capability.notes)}</small>` : ''}</dd></div>`;
}

function renderProviderOption(provider: SettingsProviderView, selectedProviderId: string): string {
  const state =
    provider.mode === 'automation' && provider.capabilities?.windowTrigger.supported === true
      ? 'automation ready'
      : 'monitor only';
  return `<option value="${escapeAttribute(provider.id)}"${provider.id === selectedProviderId ? ' selected' : ''}>${escapeHtml(provider.id)} (${escapeHtml(provider.kind)} · ${state})</option>`;
}

function renderScheduleSafety(provider: SettingsProviderView | undefined): string {
  if (!provider)
    return '<p class="notice"><span class="badge">Action unavailable</span> Select a provider to evaluate automation readiness.</p>';
  if (provider.capabilities?.windowTrigger.supported !== true)
    return '<p class="notice"><span class="badge">Monitor only</span> The schedule can be evaluated, but this provider has no supported automatic dispatch capability.</p>';
  if (provider.mode !== 'automation' || !provider.enabled)
    return '<p class="notice"><span class="badge badge-warning">Manual only</span> The schedule can be evaluated, but automatic dispatch is disabled in provider settings.</p>';
  return '<p class="notice"><span class="badge badge-success">Automation eligible</span> Eligibility still depends on fresh observations and scheduler safety gates.</p>';
}

function renderCandidateMetric(preview: SchedulePreview): string {
  if (!preview.candidateTriggerInstantIso || !preview.candidateTriggerLocalTime)
    return `<div class="preview-metric"><span class="muted">Candidate trigger</span><strong>Unknown</strong><span class="muted">${escapeHtml(preview.candidateMessage ?? 'Candidate unavailable.')}</span></div>`;
  const date = preview.candidateTriggerLocalDate
    ? `${preview.candidateTriggerLocalDate} local`
    : 'local date unknown';
  return `<div class="preview-metric"><span class="muted">Candidate trigger</span><strong class="preview-time">${escapeHtml(preview.candidateTriggerLocalTime)}</strong><span class="muted">${escapeHtml(date)} · ${escapeHtml(formatDuration(preview.windowDurationSeconds ?? 0))} window</span></div>`;
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
      candidateMessage: 'No matching observed window duration is available yet.',
    };
  if (!KNOWN_DURATION_CONFIDENCES.has(duration.confidence))
    return {
      ...preview,
      candidateMessage: 'Candidate withheld — window duration confidence must be high or exact.',
    };
  const candidateInstant = new Date(Date.parse(preview.instantIso ?? '') - duration.value * 1000);
  if (!Number.isFinite(candidateInstant.getTime()) || !preview.timeZone)
    return {
      ...preview,
      candidateMessage: 'Candidate unknown — the target instant cannot be projected safely.',
    };
  const local = localParts(candidateInstant, preview.timeZone);
  return {
    ...preview,
    candidateTriggerInstantIso: candidateInstant.toISOString(),
    candidateTriggerLocalDate: local.date,
    candidateTriggerLocalTime: local.time,
    windowDurationSeconds: duration.value,
    windowDurationConfidence: duration.confidence,
    candidateMessage: `${duration.confidence} confidence duration`,
  };
}

function resolvedPreview(occurrence: LocalOccurrence, timeZone: string): SchedulePreview {
  const message = occurrence.wasAdjusted
    ? 'nonexistent local time shifted to the first valid instant'
    : occurrence.wasAmbiguous
      ? 'ambiguous local time resolved to the earlier occurrence'
      : 'exact local occurrence';
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
    candidateMessage: 'No matching observed window duration is available yet.',
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
    message: timeZone
      ? 'unknown — enter a valid local time'
      : 'unknown — enter a local time and IANA timezone',
    candidateTriggerInstantIso: null,
    candidateTriggerLocalDate: null,
    candidateTriggerLocalTime: null,
    windowDurationSeconds: null,
    windowDurationConfidence: null,
    candidateMessage: 'Candidate unavailable until the target reset is resolved.',
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
function booleanOptions(value: unknown): string {
  return `<option value="true"${value === true ? ' selected' : ''}>Enabled</option><option value="false"${value === false ? ' selected' : ''}>Disabled</option>`;
}

function contractLabel(contract: ProviderCapabilities['usageRead']['contract']): string {
  switch (contract) {
    case 'official_supported':
      return 'officially supported';
    case 'official_client_internal':
      return 'official client surface';
    case 'observed_undocumented':
      return 'observed / undocumented';
    case 'unknown':
      return 'contract unknown';
  }
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

function formatDuration(seconds: number): string {
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
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
