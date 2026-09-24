import { escapeHtml } from './layout.js';
import { providerLogoUrl } from './presentation.js';

export interface ProviderPickerOption {
  value: string;
  label: string;
  kind?: string;
  configured?: boolean | null;
  statusLabel?: string | null;
}

export interface ProviderPickerInput {
  name: string;
  legend: string;
  options: readonly ProviderPickerOption[];
  selectedValue?: string | null;
  required?: boolean;
  describedBy?: string;
  helpText?: string;
  emptyText?: string;
}

export interface ProviderPickerLinksInput {
  legend: string;
  options: readonly ProviderPickerOption[];
  selectedValue?: string | null;
  getHref: (option: ProviderPickerOption) => string;
  emptyText?: string;
}

/** Render provider choices as a native radio group with a visual card treatment. */
export function renderProviderPicker(input: ProviderPickerInput): string {
  const describedBy = input.describedBy
    ? ` aria-describedby="${escapeHtml(input.describedBy)}"`
    : '';
  const helpText = input.helpText
    ? `<p class="field-help"${input.describedBy ? ` id="${escapeHtml(input.describedBy)}"` : ''}>${escapeHtml(input.helpText)}</p>`
    : '';
  const options = input.options.length
    ? `<div class="provider-picker-options">${input.options.map((option, index) => renderOption(input, option, index)).join('')}</div>`
    : `<p class="provider-picker-empty">${escapeHtml(input.emptyText ?? 'No providers available.')}</p>`;

  return `<fieldset class="provider-picker"${describedBy}><legend>${escapeHtml(input.legend)}</legend>${options}${helpText}</fieldset>`;
}

/** Render provider choices as immediate navigation links with the same card treatment. */
export function renderProviderPickerLinks(input: ProviderPickerLinksInput): string {
  const options = input.options.length
    ? `<div class="provider-picker-options">${input.options.map((option) => renderLinkOption(input, option)).join('')}</div>`
    : `<p class="provider-picker-empty">${escapeHtml(input.emptyText ?? 'No providers available.')}</p>`;

  return `<div class="provider-picker provider-picker-navigation"><span class="field-label">${escapeHtml(input.legend)}</span><nav aria-label="${escapeHtml(input.legend)}">${options}</nav></div>`;
}

function renderOption(
  input: ProviderPickerInput,
  option: ProviderPickerOption,
  index: number,
): string {
  const selected = option.value === input.selectedValue;
  const configured =
    option.configured === false ? 'false' : option.configured === true ? 'true' : 'unknown';
  const selectedClass = selected ? ' is-selected' : '';
  const configuredClass = option.configured === false ? ' is-unconfigured' : '';

  return `<label class="provider-picker-option${selectedClass}${configuredClass}" data-configured="${configured}"><input class="provider-picker-input" type="radio" id="${escapeHtml(input.name)}-${index}" name="${escapeHtml(input.name)}" value="${escapeHtml(option.value)}"${selected ? ' checked' : ''}${input.required ? ' required' : ''}><span class="provider-picker-card">${renderOptionContent(option)}</span></label>`;
}

function renderLinkOption(input: ProviderPickerLinksInput, option: ProviderPickerOption): string {
  const selected = option.value === input.selectedValue;
  const configured =
    option.configured === false ? 'false' : option.configured === true ? 'true' : 'unknown';
  const selectedClass = selected ? ' is-selected' : '';
  const configuredClass = option.configured === false ? ' is-unconfigured' : '';
  return `<a class="provider-picker-option provider-picker-option-link${selectedClass}${configuredClass}" href="${escapeHtml(input.getHref(option))}" data-configured="${configured}"${selected ? ' aria-current="page"' : ''}><span class="provider-picker-card">${renderOptionContent(option)}</span></a>`;
}

function renderOptionContent(option: ProviderPickerOption): string {
  const logoUrl = providerLogoUrl(option.value, option.kind);
  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="" width="34" height="34">`
    : `<span class="provider-picker-fallback" aria-hidden="true">${escapeHtml(option.value ? providerInitials(option.label) : 'ALL')}</span>`;
  const status =
    option.statusLabel !== undefined
      ? option.statusLabel
      : option.configured === false
        ? 'Set up in Settings'
        : option.configured === true
          ? 'Connected'
          : null;
  const statusMarkup = status
    ? `<span class="provider-picker-status">${escapeHtml(status)}</span>`
    : '';
  return `<span class="provider-picker-logo">${logo}</span><span class="provider-picker-copy"><span class="provider-picker-name">${escapeHtml(option.label)}</span>${statusMarkup}</span>`;
}

function providerInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'AI';
  return words.length > 1
    ? `${words[0]![0]}${words[1]![0]}`.toUpperCase()
    : words[0]!.slice(0, 2).toUpperCase();
}
