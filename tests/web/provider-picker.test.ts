import { describe, expect, it } from 'vitest';
import {
  renderProviderPicker,
  renderProviderPickerLinks,
} from '../../src/web/ui/provider-picker.js';

describe('provider picker', () => {
  it('renders a labelled, keyboard-accessible radio card group with connection states', () => {
    const html = renderProviderPicker({
      name: 'provider',
      legend: 'Provider <selection>',
      selectedValue: 'codex',
      required: true,
      describedBy: 'provider-help',
      helpText: 'Choose & connect a provider.',
      options: [
        { value: 'codex', label: 'Codex', kind: 'codex', configured: true },
        {
          value: 'antigravity',
          label: 'Antigravity',
          kind: 'antigravity',
          configured: false,
          statusLabel: 'Sign in <first>',
        },
        { value: '', label: 'All providers', configured: null, statusLabel: null },
        { value: 'local', label: 'Local provider' },
        { value: 'single', label: 'X' },
        { value: 'blank', label: '' },
      ],
    });

    expect(html).toContain('<fieldset class="provider-picker" aria-describedby="provider-help">');
    expect(html).toContain('<legend>Provider &lt;selection&gt;</legend>');
    expect(html).toContain('id="provider-0" name="provider" value="codex" checked required');
    expect(html).toContain('/assets/images/providers/codex.png');
    expect(html).toContain('data-configured="true"');
    expect(html).toContain('Connected');
    expect(html).toContain(
      'class="provider-picker-option is-unconfigured" data-configured="false"',
    );
    expect(html).toContain('Sign in &lt;first&gt;');
    expect(html).toContain('aria-hidden="true">ALL</span>');
    expect(html).toContain('aria-hidden="true">LP</span>');
    expect(html).toContain('aria-hidden="true">X</span>');
    expect(html).toContain('aria-hidden="true">AI</span>');
    expect(html).toContain('id="provider-help">Choose &amp; connect a provider.</p>');
  });

  it('renders an explicit empty state without creating an unusable required radio', () => {
    const html = renderProviderPicker({
      name: 'provider',
      legend: 'Provider',
      options: [],
      emptyText: 'No providers configured',
    });

    expect(html).toContain('No providers configured');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('aria-describedby');

    const defaultEmptyHtml = renderProviderPicker({
      name: 'provider',
      legend: 'Provider',
      options: [],
    });
    expect(defaultEmptyHtml).toContain('No providers available.');
  });

  it('keeps a single optional provider selectable without imposing form validation', () => {
    const html = renderProviderPicker({
      name: 'provider',
      legend: 'Provider',
      helpText: 'Connect this provider in Settings.',
      options: [{ value: 'fake', label: 'Test provider', configured: false }],
    });

    expect(html).toContain('name="provider" value="fake"');
    expect(html).toContain('Set up in Settings');
    expect(html).toContain('<p class="field-help">Connect this provider in Settings.</p>');
    expect(html).not.toContain(' required');
  });

  it('renders immediate provider navigation with selected, unconfigured and unknown states', () => {
    const html = renderProviderPickerLinks({
      legend: 'Usage provider',
      selectedValue: 'agy',
      getHref: (option) => `/usage?provider=${encodeURIComponent(option.value)}`,
      options: [
        { value: 'agy', label: 'Antigravity', kind: 'antigravity', configured: true },
        { value: 'codex', label: 'Codex', kind: 'codex', configured: false },
        { value: 'legacy', label: 'Local', configured: null },
      ],
    });

    expect(html).toContain('aria-label="Usage provider"');
    expect(html).toContain('href="/usage?provider=agy"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-configured="true"');
    expect(html).toContain('data-configured="false"');
    expect(html).toContain('data-configured="unknown"');
    expect(html).toContain('Connected');
    expect(html).toContain('Set up in Settings');
    expect(html).not.toContain('checked');
  });

  it('shows a useful default empty state for a navigation picker', () => {
    const html = renderProviderPickerLinks({
      legend: 'Usage provider',
      options: [],
      getHref: () => '/usage',
    });

    expect(html).toContain('No providers available.');
    expect(html).not.toContain('<a ');
  });
});
