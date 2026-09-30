import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { APP_JS } from '../../src/web/ui/chart-interactions.js';
import { PROGRESSIVE_INTERACTIONS_JS } from '../../src/web/ui/progressive-interactions.js';

type Listener = (event: Record<string, unknown>) => void;

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }

  remove(value: string): void {
    this.values.delete(value);
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }
}

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly childNodes: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly listeners = new Map<string, Listener[]>();
  ownerDocument: FakeDocument | null;
  parent: FakeElement | null = null;
  isConnected = true;
  disabled = false;
  href = '';
  target = '';
  name = '';
  value = '';
  type = '';
  tagName: string;
  focusedWith: { preventScroll?: boolean } | undefined;
  private text = '';

  constructor(tagName = 'div', ownerDocument: FakeDocument | null = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get id(): string {
    return this.attributes.get('id') ?? '';
  }

  set id(value: string) {
    this.attributes.set('id', value);
  }

  get textContent(): string {
    return this.text + this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.text = value;
    this.childNodes.length = 0;
  }

  matches(selector: string): boolean {
    if (selector === 'form') return this.tagName === 'FORM';
    if (selector === 'a' || selector === 'button') return this.tagName === selector.toUpperCase();
    if (selector === '[data-awm-soft-nav]') return this.dataset.awmSoftNav !== undefined;
    if (selector === '[data-awm-region]') return Boolean(this.dataset.awmRegion);
    if (selector === '[data-awm-focus-key]') return Boolean(this.dataset.awmFocusKey);
    if (selector === '[id]') return Boolean(this.id);
    if (selector === 'script') return this.tagName === 'SCRIPT';
    if (selector === '[data-awm-interaction-error]')
      return Boolean(this.dataset.awmInteractionError);
    if (selector === '[data-awm-announcement]') return Boolean(this.dataset.awmAnnouncement);
    if (selector === '[data-awm-focus-fallback]') return Boolean(this.dataset.awmFocusFallback);
    if (selector === '[role="alert"]') return this.attributes.get('role') === 'alert';
    if (selector === 'h1' || selector === 'h2' || selector === 'h3')
      return this.tagName === selector.toUpperCase();
    if (selector.startsWith('.')) {
      return (this.attributes.get('class') ?? '').split(/\s+/).includes(selector.slice(1));
    }
    if (selector.startsWith('[data-') && selector.endsWith(']')) {
      const key = selector
        .slice(6, -1)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      return this.dataset[key] !== undefined;
    }
    return false;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const descendants = this.childNodes.flatMap((child) => [
      child,
      ...child.querySelectorAll(selector),
    ]);
    return descendants.filter((child) => child.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      return this.dataset[key] ?? null;
    }
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      this.dataset[key] = value;
      return;
    }
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      delete this.dataset[key];
      return;
    }
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  contains(node: FakeElement): boolean {
    return node === this || this.childNodes.some((child) => child.contains(node));
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: Record<string, unknown> & { type: string }): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.childNodes.push(node);
    }
  }

  prepend(node: FakeElement): void {
    node.parent = this;
    this.childNodes.unshift(node);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.childNodes.length = 0;
    this.text = '';
    this.append(...nodes);
  }

  replaceWith(replacement: FakeElement): void {
    if (this.parent) {
      const index = this.parent.childNodes.indexOf(this);
      this.parent.childNodes[index] = replacement;
      replacement.parent = this.parent;
    } else {
      this.ownerDocument?.replaceRegion(this, replacement);
    }
    this.isConnected = false;
    replacement.isConnected = true;
  }

  remove(): void {
    if (this.parent) {
      const index = this.parent.childNodes.indexOf(this);
      if (index >= 0) this.parent.childNodes.splice(index, 1);
    }
    this.isConnected = false;
  }

  cloneNode(): FakeElement {
    const clone = new FakeElement(this.tagName, this.ownerDocument);
    Object.assign(clone.dataset, this.dataset);
    for (const [name, value] of this.attributes) clone.attributes.set(name, value);
    clone.textContent = this.text;
    clone.disabled = this.disabled;
    clone.href = this.href;
    clone.target = this.target;
    clone.name = this.name;
    clone.value = this.value;
    clone.type = this.type;
    for (const child of this.childNodes) clone.append(child.cloneNode());
    return clone;
  }

  focus(options?: { preventScroll?: boolean }): void {
    this.focusedWith = options;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }
}

class FakeRegion extends FakeElement {
  constructor(target: string, ownerDocument: FakeDocument | null, text = '') {
    super('section', ownerDocument);
    this.dataset.awmRegion = target;
    this.textContent = text;
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Listener[]>();
  readonly regions: FakeRegion[];
  readonly status = new FakeElement('div', this);
  activeElement: FakeElement | null = null;
  title = 'AI Window Manager';

  constructor(regions: FakeRegion[]) {
    this.regions = regions;
    for (const region of regions) region.ownerDocument = this;
    this.status.dataset.awmInteractionStatus = '';
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: Record<string, unknown> & { type: string }): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '[data-awm-region]') return this.regions;
    return this.regions.flatMap((region) => region.querySelectorAll(selector));
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === '[data-awm-interaction-status]') return this.status;
    if (selector === 'title') return new FakeElement('title', this);
    return null;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  importNode(node: FakeElement): FakeElement {
    const clone = node.cloneNode();
    clone.ownerDocument = this;
    return clone;
  }

  replaceRegion(current: FakeElement, replacement: FakeElement): void {
    const index = this.regions.indexOf(current);
    if (index >= 0) this.regions[index] = replacement;
    replacement.ownerDocument = this;
  }
}

class FakeForm extends FakeElement {
  readonly entries: Array<[string, string]>;
  readonly submitButton: FakeElement;
  method: string;
  action: string;
  enctype = 'application/x-www-form-urlencoded';

  constructor(
    document: FakeDocument,
    input: {
      mode: 'navigation' | 'mutation';
      target: string;
      method: string;
      action: string;
      entries?: Array<[string, string]>;
    },
  ) {
    super('form', document);
    this.dataset.awmEnhance = input.mode;
    this.dataset.awmTarget = input.target;
    this.method = input.method;
    this.action = input.action;
    this.entries = input.entries ?? [];
    this.submitButton = new FakeElement('button', document);
    this.submitButton.type = 'submit';
    this.submitButton.dataset.awmPendingLabel = input.mode === 'mutation' ? 'Saving…' : '';
    this.submitButton.textContent = input.mode === 'mutation' ? 'Save' : 'Filter';
    this.submitButton.name = 'action';
    this.submitButton.value = 'save';
    this.append(this.submitButton);
  }

  matches(selector: string): boolean {
    if (selector === 'form[data-awm-enhance]') return Boolean(this.dataset.awmEnhance);
    return super.matches(selector);
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === 'button[type="submit"], input[type="submit"]') return this.submitButton;
    return super.querySelector(selector);
  }

  requestSubmit(): void {
    if (this.ownerDocument) submit(this.ownerDocument, this, null);
  }
}

class FakeFormData {
  private readonly values: Array<[string, string]>;

  constructor(form: FakeForm, submitter?: FakeElement) {
    this.values = [...form.entries];
    if (submitter?.name) this.values.push([submitter.name, submitter.value]);
  }

  entries(): Array<[string, string]> {
    return this.values;
  }

  append(key: string, value: string): void {
    this.values.push([key, value]);
  }
}

class FakeCustomEvent {
  readonly type: string;
  readonly detail: Record<string, unknown>;

  constructor(type: string, options: { detail: Record<string, unknown> }) {
    this.type = type;
    this.detail = options.detail;
  }
}

class FakeParsedDocument {
  readonly region: FakeRegion;
  readonly title: FakeElement;

  constructor(
    target: string,
    text: string,
    document: FakeDocument,
    title: string,
    focusId?: string,
    polling?: { pollState?: string; pollHref?: string; announcement?: string },
    focusKey?: string,
  ) {
    this.region = new FakeRegion(target, document, text);
    if (polling?.pollState) this.region.dataset.awmPollState = polling.pollState;
    if (polling?.pollHref) this.region.dataset.awmPollHref = polling.pollHref;
    if (polling?.announcement) {
      const announcement = new FakeElement('p', document);
      announcement.dataset.awmAnnouncement = 'true';
      announcement.textContent = polling.announcement;
      this.region.append(announcement);
    }
    if (focusId || focusKey) {
      const control = new FakeElement('select', document);
      if (focusId) control.id = focusId;
      if (focusKey) control.dataset.awmFocusKey = focusKey;
      this.region.append(control);
    }
    this.title = new FakeElement('title', document);
    this.title.textContent = title;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === '[data-awm-region]' ? [this.region] : [];
  }

  querySelector(selector: string): FakeElement | null {
    return selector === 'title' ? this.title : null;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(input: { token: string; url: string; status?: number }) {
  const status = input.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: input.url,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: () => Promise.resolve(input.token),
  };
}

function submit(
  document: FakeDocument,
  form: FakeForm,
  submitter: FakeElement | null = form.submitButton,
): { defaultPrevented: boolean } {
  const event = {
    type: 'submit',
    target: form,
    submitter,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  document.dispatchEvent(event);
  return event;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createRuntime(input: {
  target: string;
  pollState?: string;
  pollHref?: string;
  fetch: (url: string, options: Record<string, unknown>) => Promise<ReturnType<typeof response>>;
  pages?: Map<
    string,
    {
      target: string;
      text: string;
      title?: string;
      focusId?: string;
      focusKey?: string;
      pollState?: string;
      pollHref?: string;
      announcement?: string;
    }
  >;
}) {
  const region = new FakeRegion(input.target, null, 'Initial state');
  if (input.pollState) region.dataset.awmPollState = input.pollState;
  if (input.pollHref) region.dataset.awmPollHref = input.pollHref;
  const document = new FakeDocument([region]);
  const location = {
    origin: 'http://awm.test',
    href: 'http://awm.test/settings',
    assignCalls: [] as string[],
    reloadCalls: 0,
    assign(value: string) {
      this.assignCalls.push(value);
    },
    reload() {
      this.reloadCalls += 1;
    },
  };
  const history = {
    state: null as unknown,
    pushed: [] as string[],
    replaced: [] as string[],
    pushState(_state: unknown, _title: string, url: string) {
      this.pushed.push(url);
    },
    replaceState(_state: unknown, _title: string, url: string) {
      this.replaced.push(url);
    },
  };
  const pages =
    input.pages ??
    new Map<
      string,
      {
        target: string;
        text: string;
        title?: string;
        focusId?: string;
        focusKey?: string;
        pollState?: string;
        pollHref?: string;
        announcement?: string;
      }
    >();
  class TestParser {
    parseFromString(token: string) {
      const page = pages.get(token);
      if (!page) throw new Error('missing fake SSR page');
      return new FakeParsedDocument(
        page.target,
        page.text,
        document,
        page.title ?? 'Updated page',
        page.focusId,
        page,
        page.focusKey,
      );
    }
  }
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const window = {
    location,
    addEventListener: (type: string, listener: Listener) =>
      document.addEventListener('window:' + type, listener),
    setTimeout: (callback: () => void) => {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  new Script(PROGRESSIVE_INTERACTIONS_JS).runInNewContext({
    document,
    window,
    history,
    fetch: input.fetch,
    URL,
    URLSearchParams,
    FormData: FakeFormData,
    AbortController,
    DOMParser: TestParser,
    CustomEvent: FakeCustomEvent,
  });
  return { document, history, location, region, timers };
}

function enhanceLogsFilterForm(
  runtime: ReturnType<typeof createRuntime>,
  initial: { providerId: string; range: string },
) {
  const form = new FakeForm(runtime.document, {
    mode: 'navigation',
    target: 'logs-results',
    method: 'get',
    action: 'http://awm.test/logs',
    entries: [
      ['tag', 'trigger'],
      ['type', 'scheduler_noop'],
      ['provider', initial.providerId],
      ['range', initial.range],
    ],
  });
  form.dataset.providerPickerAutoSubmit = '';

  const codex = new FakeElement('input', runtime.document);
  codex.attributes.set('class', 'provider-picker-input');
  codex.id = 'provider-codex';
  const antigravity = new FakeElement('input', runtime.document);
  antigravity.attributes.set('class', 'provider-picker-input');
  antigravity.id = 'provider-antigravity';
  const range = new FakeElement('select', runtime.document);
  range.dataset.chartRangeSelect = '';
  range.dataset.awmFocusKey = 'logs-range';
  range.name = 'range';
  range.value = initial.range;
  form.append(codex, antigravity, range);
  runtime.region.append(form);

  new Script(APP_JS).runInNewContext({ document: runtime.document, window: {} });
  return { form, codex, antigravity, range };
}

async function runNextTimer(timers: Map<number, () => void>): Promise<void> {
  const next = timers.entries().next().value as [number, () => void] | undefined;
  if (!next) throw new Error('No timer is scheduled');
  timers.delete(next[0]);
  next[1]();
  await flushPromises();
}

describe('progressive SSR interaction runtime', () => {
  it.each([
    { changed: 'provider' as const, expectedProvider: 'codex', expectedRange: '24h' },
    { changed: 'range' as const, expectedProvider: 'antigravity', expectedRange: '3h' },
  ])(
    'applies Logs $changed changes through one partial GET while preserving filters and focus',
    async ({ changed, expectedProvider, expectedRange }) => {
      const requests: Array<{ url: string; options: Record<string, unknown> }> = [];
      const pending = deferred<ReturnType<typeof response>>();
      const runtime = createRuntime({
        target: 'logs-results',
        pages: new Map([
          [
            'updated',
            {
              target: 'logs-results',
              text: 'Updated activity log results',
              ...(changed === 'range' ? { focusKey: 'logs-range' } : { focusId: 'provider-codex' }),
            },
          ],
        ]),
        fetch: (url, options) => {
          requests.push({ url, options });
          return pending.promise;
        },
      });
      runtime.location.href =
        'http://awm.test/logs?range=24h&page=4&provider=antigravity&tag=trigger&type=scheduler_noop';
      const { form, codex, antigravity, range } = enhanceLogsFilterForm(runtime, {
        providerId: 'antigravity',
        range: '24h',
      });
      const activeControl = changed === 'provider' ? codex : range;
      runtime.document.activeElement = activeControl;

      if (changed === 'provider') {
        form.entries[2] = ['provider', 'codex'];
        codex.dispatchEvent({ type: 'change' });
      } else {
        form.entries[3] = ['range', '3h'];
        range.value = '3h';
        range.dispatchEvent({ type: 'change' });
      }
      expect(runtime.region.getAttribute('aria-busy')).toBe('true');
      expect(runtime.document.status.textContent).toBe('Updating this section.');
      pending.resolve(response({ token: 'updated', url: requests[0]!.url }));
      await flushPromises();

      expect(requests).toHaveLength(1);
      expect(requests[0]?.options).toMatchObject({ method: 'GET', credentials: 'same-origin' });
      const requestedUrl = new URL(requests[0]!.url);
      expect(requestedUrl.pathname).toBe('/logs');
      expect(requestedUrl.searchParams.get('provider')).toBe(expectedProvider);
      expect(requestedUrl.searchParams.get('range')).toBe(expectedRange);
      expect(requestedUrl.searchParams.get('tag')).toBe('trigger');
      expect(requestedUrl.searchParams.get('type')).toBe('scheduler_noop');
      expect(requestedUrl.searchParams.has('page')).toBe(false);
      expect(runtime.document.regions[0]?.textContent).toContain('Updated activity log results');
      expect(runtime.history.pushed).toEqual([requests[0]!.url]);
      expect(runtime.location.assignCalls).toHaveLength(0);
      expect(runtime.location.reloadCalls).toBe(0);
      expect(runtime.document.activeElement?.focusedWith).toEqual({ preventScroll: true });
      expect(runtime.document.status.textContent).toBe('View updated.');
      expect(form.dataset.providerPickerAutoSubmit).toBe('');
      expect(antigravity.id).toBe('provider-antigravity');
    },
  );

  it('submits one POST with the submitter, shows pending feedback, replaces the region and PRG URL', async () => {
    const request = deferred<ReturnType<typeof response>>();
    const fetchCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
    const runtime = createRuntime({
      target: 'settings-provider:codex',
      pages: new Map([
        [
          'saved',
          {
            target: 'settings-provider:codex',
            text: 'Saved settings',
            title: 'Settings · AWM',
            focusId: 'provider-poll-interval',
          },
        ],
      ]),
      fetch: async (url, options) => {
        fetchCalls.push({ url, options });
        return request.promise;
      },
    });
    const focusTarget = new FakeElement('select', runtime.document);
    focusTarget.id = 'provider-poll-interval';
    runtime.region.append(focusTarget);
    runtime.document.activeElement = focusTarget;
    let enhanced = 0;
    let disposed = 0;
    runtime.document.addEventListener('awm:enhance', () => {
      enhanced += 1;
    });
    runtime.document.addEventListener('awm:dispose', () => {
      disposed += 1;
    });
    const form = new FakeForm(runtime.document, {
      mode: 'mutation',
      target: 'settings-provider:codex',
      method: 'post',
      action: 'http://awm.test/settings/providers/codex',
      entries: [
        ['csrfToken', 'synthetic-csrf'],
        ['enabled', 'true'],
      ],
    });

    const first = submit(runtime.document, form);
    expect(first.defaultPrevented).toBe(true);
    expect(form.submitButton.disabled).toBe(true);
    expect(form.submitButton.textContent).toBe('Saving…');
    expect(runtime.region.getAttribute('aria-busy')).toBe('true');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.options.method).toBe('POST');
    expect(fetchCalls[0]?.options.credentials).toBe('same-origin');
    expect(fetchCalls[0]?.options.body).toContain('csrfToken=synthetic-csrf');
    expect(fetchCalls[0]?.options.body).toContain('action=save');

    const second = submit(runtime.document, form);
    expect(second.defaultPrevented).toBe(true);
    expect(fetchCalls).toHaveLength(1);

    request.resolve(response({ token: 'saved', url: 'http://awm.test/settings?updated=codex' }));
    await flushPromises();

    expect(runtime.document.regions[0]?.textContent).toBe('Saved settings');
    expect(runtime.document.title).toBe('Settings · AWM');
    expect(runtime.history.replaced).toEqual(['http://awm.test/settings?updated=codex']);
    expect(runtime.history.pushed).toHaveLength(0);
    expect(runtime.document.status.textContent).toBe('Update complete.');
    expect(disposed).toBe(1);
    expect(enhanced).toBe(1);
    expect(runtime.document.activeElement?.id).toBe('provider-poll-interval');
    expect(runtime.document.activeElement?.focusedWith).toEqual({ preventScroll: true });
  });

  it('does not retry a dispatched POST after a network failure and offers a manual status refresh', async () => {
    let calls = 0;
    const runtime = createRuntime({
      target: 'overview-workspace',
      fetch: () => {
        calls += 1;
        return Promise.reject(new Error('connection reset'));
      },
    });
    const form = new FakeForm(runtime.document, {
      mode: 'mutation',
      target: 'overview-workspace',
      method: 'post',
      action: 'http://awm.test/providers/codex/trigger',
      entries: [['csrfToken', 'synthetic-csrf']],
    });
    form.dataset.awmUncertainMessage =
      'The start result is uncertain. Refresh status before trying again.';

    submit(runtime.document, form);
    await flushPromises();

    expect(calls).toBe(1);
    expect(runtime.region.querySelector('[data-awm-interaction-error]')?.textContent).toContain(
      'The start result is uncertain.',
    );
    expect(
      runtime.region.querySelector('[data-awm-interaction-error]')?.querySelector('a')?.textContent,
    ).toBe('Refresh status');
    expect(form.submitButton.disabled).toBe(false);
    expect(form.submitButton.textContent).toBe('Save');
    expect(runtime.region.getAttribute('aria-busy')).toBeNull();
  });

  it('renders a server-returned validation region without treating it as a successful save', async () => {
    const calls: string[] = [];
    const runtime = createRuntime({
      target: 'schedule-workspace',
      pages: new Map([
        [
          'invalid',
          {
            target: 'schedule-workspace',
            text: 'The selected usage window is unavailable.',
            announcement: 'Review the schedule fields.',
          },
        ],
      ]),
      fetch: (url) => {
        calls.push(url);
        return Promise.resolve(
          response({ token: 'invalid', url: 'http://awm.test/schedule', status: 422 }),
        );
      },
    });
    const form = new FakeForm(runtime.document, {
      mode: 'mutation',
      target: 'schedule-workspace',
      method: 'post',
      action: 'http://awm.test/schedule',
      entries: [['csrfToken', 'synthetic-csrf']],
    });

    submit(runtime.document, form);
    await flushPromises();

    expect(calls).toEqual(['http://awm.test/schedule']);
    expect(runtime.document.regions[0]?.textContent).toContain(
      'The selected usage window is unavailable.',
    );
    expect(runtime.document.status.textContent).toBe('Review the schedule fields.');
    expect(runtime.history.replaced).toEqual(['http://awm.test/schedule']);
    expect(runtime.region.querySelector('[data-awm-interaction-error]')).toBeNull();
  });

  it('only lets the newest Logs filter GET replace results and pushes its URL', async () => {
    const older = deferred<ReturnType<typeof response>>();
    let calls = 0;
    const requestUrls: string[] = [];
    const requestOptions: Array<Record<string, unknown>> = [];
    const runtime = createRuntime({
      target: 'logs-results',
      pages: new Map([
        ['older', { target: 'logs-results', text: 'Older activity results' }],
        ['newer', { target: 'logs-results', text: 'Newer activity results' }],
      ]),
      fetch: (url, options) => {
        calls += 1;
        requestUrls.push(url);
        requestOptions.push(options);
        if (calls === 1) return older.promise;
        return Promise.resolve(response({ token: 'newer', url }));
      },
    });
    runtime.location.href = 'http://awm.test/logs?range=3h&page=2&provider=codex&tag=trigger';
    const makeForm = (range: string) =>
      new FakeForm(runtime.document, {
        mode: 'navigation',
        target: 'logs-results',
        method: 'get',
        action: 'http://awm.test/logs',
        entries: [
          ['tag', 'trigger'],
          ['type', 'scheduler_noop'],
          ['provider', 'codex'],
          ['range', range],
        ],
      });

    submit(runtime.document, makeForm('6h'), null);
    submit(runtime.document, makeForm('24h'), null);
    await flushPromises();
    older.resolve(response({ token: 'older', url: requestUrls[0]! }));
    await flushPromises();

    expect(calls).toBe(2);
    expect(requestOptions[0]?.signal).toMatchObject({ aborted: true });
    expect(runtime.document.regions[0]?.textContent).toBe('Newer activity results');
    expect(new URL(requestUrls[1]!).searchParams.get('range')).toBe('24h');
    expect(runtime.history.pushed).toEqual([requestUrls[1]!]);
    expect(runtime.location.reloadCalls).toBe(0);
  });

  it('keeps the current Logs results visible and offers an accessible retry when refresh fails', async () => {
    const runtime = createRuntime({
      target: 'logs-results',
      fetch: () => Promise.reject(new Error('connection reset')),
    });
    const form = new FakeForm(runtime.document, {
      mode: 'navigation',
      target: 'logs-results',
      method: 'get',
      action: 'http://awm.test/logs',
      entries: [
        ['tag', 'trigger'],
        ['type', 'scheduler_noop'],
        ['provider', 'codex'],
        ['range', '3h'],
      ],
    });

    submit(runtime.document, form, null);
    await flushPromises();

    const alert = runtime.document.regions[0]?.querySelector('[data-awm-interaction-error]');
    expect(runtime.document.regions[0]).toBe(runtime.region);
    expect(runtime.document.regions[0]?.textContent).toContain('Initial state');
    expect(alert?.attributes.get('role')).toBe('alert');
    expect(alert?.textContent).toContain('This section could not be updated.');
    expect(alert?.querySelector('a')?.textContent).toBe('Try again');
    expect(alert?.querySelector('a')?.href).toBe(
      'http://awm.test/logs?tag=trigger&type=scheduler_noop&provider=codex&range=3h',
    );
    expect(runtime.document.status.textContent).toBe('This section could not be updated.');
    expect(runtime.location.assignCalls).toHaveLength(0);
    expect(runtime.location.reloadCalls).toBe(0);
  });

  it('polls provider-client SSR status until the operation reaches a terminal state', async () => {
    const fetchCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
    const target = 'provider-client:codex';
    const runtime = createRuntime({
      target,
      pollState: 'checking',
      pollHref: '/settings',
      pages: new Map([
        [
          'updated',
          {
            target,
            text: 'Updated version 1.2.3',
            pollState: 'updated',
            pollHref: '/settings',
            announcement: 'Provider app updated.',
          },
        ],
      ]),
      fetch: (url, options) => {
        fetchCalls.push({ url, options });
        return Promise.resolve(response({ token: 'updated', url: 'http://awm.test/settings' }));
      },
    });

    expect(runtime.timers).toHaveProperty('size', 1);
    await runNextTimer(runtime.timers);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.options.method).toBe('GET');
    expect(fetchCalls[0]?.options.credentials).toBe('same-origin');
    expect(fetchCalls[0]?.url).toBe('http://awm.test/settings');
    expect(runtime.document.regions[0]?.textContent).toContain('Updated version 1.2.3');
    expect(runtime.document.status.textContent).toBe('Provider app updated.');
    expect(runtime.timers.size).toBe(0);
    expect(runtime.document.regions[0]?.getAttribute('aria-busy')).toBeNull();
  });

  it('stops provider-client polling on read failure and offers a manual status refresh', async () => {
    const runtime = createRuntime({
      target: 'provider-client:codex',
      pollState: 'updating',
      pollHref: '/settings',
      fetch: () => Promise.reject(new Error('connection reset')),
    });

    await runNextTimer(runtime.timers);

    const alert = runtime.document.regions[0]?.querySelector('[data-awm-interaction-error]');
    expect(alert?.textContent).toContain('The operation may still be running');
    expect(alert?.querySelector('a')?.textContent).toBe('Refresh status');
    expect(alert?.querySelector('a')?.href).toBe('http://awm.test/settings');
    expect(runtime.document.status.textContent).toContain(
      'Provider app status could not be refreshed',
    );
    expect(runtime.timers.size).toBe(0);
  });

  it('bounds provider-client polling and never cancels the server operation on timeout', async () => {
    let calls = 0;
    const target = 'provider-client:codex';
    const runtime = createRuntime({
      target,
      pollState: 'rolling_back',
      pollHref: '/settings',
      pages: new Map([
        [
          'active',
          {
            target,
            text: 'Restore still running',
            pollState: 'rolling_back',
            pollHref: '/settings',
          },
        ],
      ]),
      fetch: () => {
        calls += 1;
        return Promise.resolve(response({ token: 'active', url: 'http://awm.test/settings' }));
      },
    });

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await runNextTimer(runtime.timers);
    }

    const alert = runtime.document.regions[0]?.querySelector('[data-awm-interaction-error]');
    expect(calls).toBe(120);
    expect(alert?.textContent).toContain('it has not been cancelled');
    expect(alert?.querySelector('a')?.textContent).toBe('Refresh status');
    expect(runtime.timers.size).toBe(0);
  });

  it('navigates to the real login page when an enhanced request redirects after session expiry', async () => {
    const runtime = createRuntime({
      target: 'logs-results',
      fetch: () =>
        Promise.resolve(
          response({ token: 'login', url: 'http://awm.test/login?reason=session_expired' }),
        ),
    });
    const form = new FakeForm(runtime.document, {
      mode: 'navigation',
      target: 'logs-results',
      method: 'get',
      action: 'http://awm.test/logs',
    });

    submit(runtime.document, form);
    await flushPromises();

    expect(runtime.location.assignCalls).toEqual(['http://awm.test/login?reason=session_expired']);
    expect(runtime.document.regions[0]).toBe(runtime.region);
  });

  it('enhances only explicit same-origin links and keeps their URL in browser history', async () => {
    let calls = 0;
    const runtime = createRuntime({
      target: 'schedule-workspace',
      pages: new Map([['family', { target: 'schedule-workspace', text: 'Claude and GPT Models' }]]),
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          response({ token: 'family', url: 'http://awm.test/schedule?scope=claude_gpt' }),
        );
      },
    });
    const link = new FakeElement('a', runtime.document);
    link.dataset.awmSoftNav = '';
    link.dataset.awmTarget = 'schedule-workspace';
    link.href = 'http://awm.test/schedule?scope=claude_gpt';
    const event = {
      type: 'click',
      target: link,
      button: 0,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    runtime.document.dispatchEvent(event);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(calls).toBe(1);
    expect(runtime.document.regions[0]?.textContent).toBe('Claude and GPT Models');
    expect(runtime.history.pushed).toEqual(['http://awm.test/schedule?scope=claude_gpt']);
  });

  it('restores the server-rendered page region on browser back/forward without adding history entries', async () => {
    const requested: string[] = [];
    const runtime = createRuntime({
      target: 'app-content',
      pages: new Map([
        ['history', { target: 'app-content', text: 'Activity logs at saved filters' }],
      ]),
      fetch: (url) => {
        requested.push(url);
        return Promise.resolve(response({ token: 'history', url }));
      },
    });
    runtime.location.href =
      'http://awm.test/logs?range=6h&provider=codex&tag=trigger&type=scheduler_noop';

    runtime.document.dispatchEvent({ type: 'window:popstate' });
    await flushPromises();

    expect(requested).toEqual([runtime.location.href]);
    expect(runtime.document.regions[0]?.textContent).toBe('Activity logs at saved filters');
    expect(runtime.history.pushed).toHaveLength(0);
    expect(runtime.history.replaced).toHaveLength(0);
    expect(runtime.location.reloadCalls).toBe(0);
  });

  it('leaves external and unmarked submissions to native browser behavior', () => {
    let calls = 0;
    const runtime = createRuntime({
      target: 'logs-results',
      fetch: () => {
        calls += 1;
        return Promise.resolve(response({ token: 'unused', url: 'http://awm.test/logs' }));
      },
    });
    const external = new FakeForm(runtime.document, {
      mode: 'navigation',
      target: 'logs-results',
      method: 'get',
      action: 'https://example.test/logs',
    });
    const unmarked = new FakeForm(runtime.document, {
      mode: 'navigation',
      target: 'logs-results',
      method: 'get',
      action: 'http://awm.test/logs',
    });
    delete unmarked.dataset.awmEnhance;

    const externalEvent = submit(runtime.document, external);
    const nativeEvent = submit(runtime.document, unmarked);

    expect(externalEvent.defaultPrevented).toBe(false);
    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(calls).toBe(0);
  });
});
