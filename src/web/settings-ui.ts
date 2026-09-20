import { resolveLocalOccurrence, type LocalOccurrence } from '../scheduler/time.js';
import type { ProviderMode } from '../storage/repositories.js';

// These are browser hints only. settings-api.ts remains the server-side authority.
const MIN_POLL_INTERVAL_SECONDS = 30;
const MAX_POLL_INTERVAL_SECONDS = 86_400;
const MIN_TOLERANCE_SECONDS = 0;
const MAX_TOLERANCE_SECONDS = 3_600;

export interface SettingsProviderView {
  id: string;
  kind: string;
  enabled: boolean;
  mode: ProviderMode;
  pollIntervalSeconds: number;
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
  message: string;
}

/**
 * Resolve the schedule preview with the same IANA/DST rules used by the scheduler.
 * Invalid or incomplete input is represented as unknown instead of being guessed.
 */
export function previewTargetReset(input: {
  localTime: string;
  timeZone: string;
  referenceInstant: Date;
}): SchedulePreview {
  try {
    const occurrence = resolveLocalOccurrence(input);
    return resolvedPreview(occurrence);
  } catch {
    return {
      status: 'unknown',
      instantIso: null,
      localDate: null,
      requestedLocalTime: input.localTime || null,
      resolvedLocalTime: null,
      resolution: null,
      message: 'unknown — enter a valid local time and IANA timezone',
    };
  }
}

export function renderSettingsPage(input: SettingsPageInput): string {
  const csrfToken = escapeHtml(input.csrfToken);
  const notice = input.notice ? `<p class="notice">${escapeHtml(input.notice)}</p>` : '';
  const providerSections = input.providers.length
    ? input.providers.map((provider) => renderProviderForm(provider, csrfToken)).join('\n')
    : '<p>Provider settings: <strong>unknown</strong> — no providers configured.</p>';

  return pageDocument(
    'Settings',
    `${notice}<h1>Settings</h1><p>Only non-secret runtime settings are editable here.</p>${providerSections}`,
  );
}

export function renderSchedulePage(input: SchedulePageInput): string {
  const csrfToken = escapeHtml(input.csrfToken);
  const policy = input.policy ?? {};
  const providerId = stringValue(policy.providerId);
  const windowKind = stringValue(policy.windowKind);
  const targetResetLocalTime = stringValue(policy.targetResetLocalTime);
  const timezone = stringValue(policy.timezone);
  const toleranceSeconds = numberValue(policy.toleranceSeconds);
  const preview =
    targetResetLocalTime && timezone
      ? previewTargetReset({
          localTime: targetResetLocalTime,
          timeZone: timezone,
          referenceInstant: input.referenceInstant,
        })
      : unknownPreview(targetResetLocalTime || null);
  const notice = input.notice ? `<p class="notice">${escapeHtml(input.notice)}</p>` : '';
  const providerOptions = input.providers.length
    ? input.providers
        .map(
          (provider) =>
            `<option value="${escapeAttribute(provider.id)}"${
              provider.id === providerId ? ' selected' : ''
            }>${escapeHtml(provider.id)} (${escapeHtml(provider.kind)})</option>`,
        )
        .join('')
    : '<option value="">unknown — no providers configured</option>';

  return pageDocument(
    'Schedule',
    `${notice}<h1>Target-reset schedule</h1>
      <p>Schedules are stored as local wall-clock time plus an IANA timezone.</p>
      <form method="post" action="/schedule">
        ${csrfInput(csrfToken)}
        <label>Enabled <select name="enabled">${booleanOptions(policy.enabled)}</select></label>
        <label>Provider <select name="providerId">${providerOptions}</select></label>
        <label>Window kind <input name="windowKind" value="${escapeAttribute(windowKind)}" placeholder="unknown" maxlength="64"></label>
        <label>Target reset local time <input name="targetResetLocalTime" value="${escapeAttribute(targetResetLocalTime)}" placeholder="HH:mm" pattern="(?:[01]\\d|2[0-3]):[0-5]\\d"></label>
        <label>Timezone <input name="timezone" value="${escapeAttribute(timezone)}" placeholder="IANA timezone" maxlength="128"></label>
        <label>Tolerance (seconds) <input name="toleranceSeconds" type="number" min="${MIN_TOLERANCE_SECONDS}" max="${MAX_TOLERANCE_SECONDS}" value="${
          toleranceSeconds === null ? '' : toleranceSeconds
        }"></label>
        <button type="submit">Save schedule</button>
      </form>
      <section aria-label="Schedule preview"><h2>Preview</h2>${renderSchedulePreview(preview)}</section>`,
  );
}

export function renderSchedulePreview(preview: SchedulePreview): string {
  if (preview.status === 'unknown') {
    return `<p>Next occurrence: <strong>unknown</strong> — ${escapeHtml(preview.message)}</p>`;
  }

  const adjustment = preview.resolution === 'exact' ? '' : ` (${escapeHtml(preview.resolution)})`;
  return `<dl><dt>Next occurrence</dt><dd>${escapeHtml(preview.instantIso)}${adjustment}</dd><dt>Local date</dt><dd>${escapeHtml(preview.localDate)} at ${escapeHtml(preview.resolvedLocalTime)}</dd><dt>Resolution</dt><dd>${escapeHtml(preview.resolution)} — ${escapeHtml(preview.message)}</dd></dl>`;
}

function renderProviderForm(provider: SettingsProviderView, csrfToken: string): string {
  return `<section aria-label="Provider ${escapeHtml(provider.id)}"><h2>${escapeHtml(
    provider.id,
  )} <small>(${escapeHtml(provider.kind)})</small></h2>
    <form method="post" action="/settings/providers/${encodeURIComponent(provider.id)}">
      ${csrfInput(csrfToken)}
      <label>Enabled <select name="enabled">${booleanOptions(provider.enabled)}</select></label>
      <label>Mode <select name="mode"><option value="monitor_only"${
        provider.mode === 'monitor_only' ? ' selected' : ''
      }>monitor only</option><option value="automation"${
        provider.mode === 'automation' ? ' selected' : ''
      }>automation</option></select></label>
      <label>Poll interval (seconds) <input name="pollIntervalSeconds" type="number" min="${MIN_POLL_INTERVAL_SECONDS}" max="${MAX_POLL_INTERVAL_SECONDS}" value="${escapeAttribute(
        String(provider.pollIntervalSeconds),
      )}"></label>
      <button type="submit">Save provider settings</button>
    </form></section>`;
}

function resolvedPreview(occurrence: LocalOccurrence): SchedulePreview {
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
    message,
  };
}

function unknownPreview(requestedLocalTime: string | null): SchedulePreview {
  return {
    status: 'unknown',
    instantIso: null,
    localDate: null,
    requestedLocalTime,
    resolvedLocalTime: null,
    resolution: null,
    message: 'unknown — enter a local time and IANA timezone',
  };
}

function booleanOptions(value: unknown): string {
  return `<option value="true"${value === true ? ' selected' : ''}>yes</option><option value="false"${
    value === false ? ' selected' : ''
  }>no</option>`;
}

function csrfInput(token: string): string {
  return `<input type="hidden" name="csrfToken" value="${token}">`;
}

function pageDocument(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title></head><body>${body}</body></html>`;
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
