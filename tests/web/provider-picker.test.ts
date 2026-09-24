import { describe, expect, it } from 'vitest';
import { renderProviderPicker } from '../../src/web/ui/provider-picker.js';

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
  });

  it('keeps a single optional provider selectable without imposing form validation', () => {
    const html = renderProviderPicker({
      name: 'provider',
      legend: 'Provider',
      options: [{ value: 'fake', label: 'Test provider', configured: false }],
    });

    expect(html).toContain('name="provider" value="fake"');
    expect(html).toContain('Set up in Settings');
    expect(html).not.toContain(' required');
  });
});
