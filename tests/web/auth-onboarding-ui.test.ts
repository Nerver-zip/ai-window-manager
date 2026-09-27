import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import {
  renderAuthOnboarding,
  type AuthOnboardingStatus,
} from '../../src/web/ui/auth-onboarding.js';
import { AUTH_ONBOARDING_CSS } from '../../src/web/ui/auth-onboarding-styles.js';
import { AUTH_ONBOARDING_JS } from '../../src/web/ui/auth-onboarding-interactions.js';
import { APP_CSS } from '../../src/web/ui/styles.js';

const status = (overrides: Partial<AuthOnboardingStatus> = {}): AuthOnboardingStatus => ({
  providerId: 'codex',
  state: 'IDLE',
  startedAt: null,
  expiresAt: null,
  authorizationUrl: null,
  userCode: null,
  requiresCodeSubmission: false,
  reasonCode: null,
  ...overrides,
});

class AuthUiNode {
  hidden = false;
  textContent = '';
  href = '';
  value = '';
  classList = { toggle: () => undefined };
  private readonly listeners = new Map<string, () => unknown>();
  registrationCount = 0;

  addEventListener(event: string, listener: () => unknown): void {
    this.registrationCount += 1;
    this.listeners.set(event, listener);
  }

  click(): unknown {
    return this.listeners.get('click')?.();
  }
}

interface AuthUiHarnessOptions {
  initialCode: string;
  refreshedCode: string;
  clipboard?: { writeText: (value: string) => Promise<void> } | undefined;
  legacyCopyWorks?: boolean;
  authorizationUrl?: string;
  selectionAvailable?: boolean;
}

function createAuthUiHarness(options: AuthUiHarnessOptions) {
  const selectors = [
    '[data-auth-status-detail]',
    '[data-auth-error]',
    '[data-auth-expiry]',
    '[data-auth-start]',
    '[data-auth-cancel]',
    '[data-auth-awaiting]',
    '[data-auth-authorization]',
    '[data-auth-device-code]',
    '[data-auth-code-section]',
    '[data-auth-user-code]',
    '[data-auth-copy-fallback]',
    '[data-auth-copy-status]',
    '[data-auth-copy-code]',
    '[data-auth-copy-url]',
    '[data-auth-code-input]',
  ];
  const nodes = new Map(selectors.map((selector) => [selector, new AuthUiNode()]));
  const code = nodes.get('[data-auth-user-code]');
  const authorization = nodes.get('[data-auth-authorization]');
  if (code) code.textContent = options.initialCode;
  if (authorization)
    authorization.href = options.authorizationUrl ?? 'https://auth.openai.com/device';

  const panel = {
    dataset: {
      authState: 'AWAITING_USER_ACTION',
      authProviderId: 'codex',
      authRole: 'connect',
      authStatusUrl: '/api/v1/providers/codex/auth/status',
      authStartUrl: '/api/v1/providers/codex/auth/start',
      authSubmitUrl: '/api/v1/providers/codex/auth/submit',
      authCancelUrl: '/api/v1/providers/codex/auth/cancel',
    },
    querySelector: (selector: string) => nodes.get(selector) ?? null,
    closest: () => null,
  };

  let selectedNode: AuthUiNode | null = null;
  const selection = {
    removeAllRanges: () => {
      selectedNode = null;
    },
    addRange: (range: { node: AuthUiNode | null }) => {
      selectedNode = range.node;
    },
    toString: () => selectedNode?.textContent ?? '',
  };
  const fetchRequests: Array<{ url: string; method: string; body: string | undefined }> = [];
  const documentListeners = new Map<string, (event: { detail?: { root?: unknown } }) => void>();
  const clipboardWrites: string[] = [];
  const legacyCopies: string[] = [];
  let legacyTextarea: { value: string } | null = null;
  const refreshedStatus = status({
    state: 'AWAITING_USER_ACTION',
    authorizationUrl: options.authorizationUrl ?? 'https://auth.openai.com/device',
    userCode: options.refreshedCode,
  });

  const document = {
    cookie: '',
    addEventListener: (event: string, listener: (event: { detail?: { root?: unknown } }) => void) =>
      documentListeners.set(event, listener),
    dispatchEvent: (event: { type: string; detail?: { root?: unknown } }) =>
      documentListeners.get(event.type)?.(event),
    querySelectorAll: (selector: string) => (selector === '[data-auth-onboarding]' ? [panel] : []),
    createRange: () => {
      const range: { node: AuthUiNode | null; selectNodeContents: (node: AuthUiNode) => void } = {
        node: null,
        selectNodeContents(node) {
          this.node = node;
        },
      };
      return range;
    },
    createElement: () => ({
      value: '',
      style: {} as Record<string, string>,
      setAttribute: () => undefined,
      select: () => undefined,
      setSelectionRange: () => undefined,
    }),
    body: {
      appendChild: (node: { value: string }) => {
        legacyTextarea = node;
      },
      removeChild: () => {
        legacyTextarea = null;
      },
    },
    execCommand: (command: string) => {
      if (command !== 'copy' || !options.legacyCopyWorks || !legacyTextarea) return false;
      legacyCopies.push(legacyTextarea.value);
      return true;
    },
  };
  let clearTimeoutCalls = 0;
  const window = {
    location: { origin: 'http://awm.test' },
    getSelection: () => (options.selectionAvailable === false ? null : selection),
    clearTimeout: () => {
      clearTimeoutCalls += 1;
    },
    setTimeout: () => 1,
  };
  const clipboard = options.clipboard
    ? {
        writeText: async (value: string) => {
          clipboardWrites.push(value);
          await options.clipboard?.writeText(value);
        },
      }
    : undefined;
  const navigator = clipboard ? { clipboard } : {};

  new Script(AUTH_ONBOARDING_JS).runInNewContext({
    document,
    window,
    navigator,
    URL,
    fetch: (url: string, request: { method: string; body?: string }) => {
      fetchRequests.push({ url, method: request.method, body: request.body });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(refreshedStatus),
      });
    },
  });

  return {
    nodes,
    clipboardWrites,
    legacyCopies,
    fetchRequests,
    rehydrate: () => document.dispatchEvent({ type: 'awm:enhance', detail: { root: document } }),
    dispose: () => document.dispatchEvent({ type: 'awm:dispose', detail: { root: document } }),
    getListenerRegistrationCount: () =>
      [...nodes.values()].reduce((count, node) => count + node.registrationCount, 0),
    get clearTimeoutCalls() {
      return clearTimeoutCalls;
    },
    selection,
    get selectedText() {
      return selection.toString();
    },
  };
}

async function waitForAuthRefresh(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('auth onboarding UI', () => {
  it('rehydrates without duplicate listeners and disposes polling when its region is replaced', async () => {
    const harness = createAuthUiHarness({ initialCode: 'ABCD-EFGHI', refreshedCode: 'JKLM-NOPQR' });
    const registrations = harness.getListenerRegistrationCount();

    harness.rehydrate();
    harness.rehydrate();
    await waitForAuthRefresh();
    await waitForAuthRefresh();
    harness.dispose();

    expect(harness.getListenerRegistrationCount()).toBe(registrations);
    expect(harness.clearTimeoutCalls).toBeGreaterThan(0);
  });

  it('renders a loading state without exposing implementation details', () => {
    const html = renderAuthOnboarding({ providerId: 'codex' });

    expect(html).toContain('Checking your connection…');
    expect(html).toContain('data-auth-state="loading"');
    expect(html).toContain('Connect Codex');
    expect(html).toContain('Sign in with OpenAI to start tracking your usage windows.');
    expect(html).not.toContain('auth.json');
    expect(html).not.toContain('refresh_token');
    expect(html).not.toContain('authorization_code');
    expect(html).not.toContain('CLI output');
  });

  it('renders the empty state for an unconfigured provider', () => {
    const html = renderAuthOnboarding({ providerId: 'antigravity', configured: false });

    expect(html).toContain('Sign-in is not available for this provider yet.');
    expect(html).toContain('data-auth-start hidden');
  });

  it.each([
    ['IDLE', 'Connect Codex', 'Sign in with OpenAI to start tracking your usage windows.'],
    ['STARTING', 'Opening sign-in…', 'Opening sign-in…'],
    ['VERIFYING', 'Checking your account…', 'Checking your account…'],
    ['SUCCEEDED', 'Connected. Usage checks are ready.', 'Connected. Usage checks are ready.'],
    [
      'FAILED',
      'We couldn’t complete sign-in. Try again.',
      'We couldn’t complete sign-in. Try again.',
    ],
    ['TIMED_OUT', 'Sign-in timed out. Try again.', 'Sign-in timed out. Try again.'],
    ['CANCELED', 'Sign-in canceled. Try again.', 'Sign-in canceled. Try again.'],
  ] as const)('renders the %s state with clear copy', (state, label, detail) => {
    const html = renderAuthOnboarding({ providerId: 'codex', status: status({ state }) });

    expect(html).toContain(`data-auth-state="${state}"`);
    expect(html).toContain(label);
    expect(html).toContain(detail);
  });

  it('shows and can copy the Codex device code and sign-in link', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({
        state: 'AWAITING_USER_ACTION',
        startedAt: '2026-09-23T10:00:00.000Z',
        expiresAt: '2026-09-23T10:05:00.000Z',
        authorizationUrl: 'https://auth.example.test/device?flow=awm',
        userCode: 'ABCD-EFGH',
        requiresCodeSubmission: false,
      }),
    });

    expect(html).toContain('Open sign-in');
    expect(html).toContain('href="https://auth.example.test/device?flow=awm"');
    expect(html).toContain('data-auth-device-code');
    expect(html).toContain('Enter this code on the sign-in page.');
    expect(html).toMatch(/<output\b[^>]*data-auth-user-code[^>]*>ABCD-EFGH<\/output>/);
    expect(html).toContain('data-auth-copy-fallback');
    expect(html).toContain('data-auth-copy-code');
    expect(html).toContain('Copy sign-in code');
    expect(html).toContain('data-auth-copy-url');
    expect(html).toContain('Copy sign-in link');
    expect(html).toContain('data-auth-copy-status role="status" aria-live="polite"');
    expect(html).toMatch(/data-auth-code-section hidden/);
    expect(html).toContain('This sign-in expires at');
  });

  it('keeps Antigravity code submission separate from a displayed device code', () => {
    const html = renderAuthOnboarding({
      providerId: 'antigravity',
      status: status({
        providerId: 'antigravity',
        state: 'AWAITING_USER_ACTION',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?flow=awm',
        requiresCodeSubmission: true,
      }),
    });

    expect(html).toContain('data-auth-code-section>');
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain('Enter the code shown by the provider.');
    expect(html).toContain('data-auth-submit');
    expect(html).toMatch(/data-auth-device-code hidden/);
  });

  it('does not render unsafe or out-of-state authorization material', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({
        state: 'SUCCEEDED',
        authorizationUrl: 'javascript:alert(1)',
        userCode: '<img src=x onerror=alert(1)>',
        requiresCodeSubmission: true,
      }),
    });

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('img src');
    expect(html).not.toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders status-unavailable errors without raw reason codes', () => {
    const html = renderAuthOnboarding({ providerId: 'codex', status: null });

    expect(html).toContain('The provider connection status could not be loaded. Try again.');
    expect(html).not.toContain('The status check failed');
    expect(html).not.toContain('AUTH_SESSION_FAILED');
  });

  it('escapes provider-facing text and never renders credential-shaped fields', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({
        state: 'FAILED',
        reasonCode: 'AUTH_START_FAILED',
      }),
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('access_token');
    expect(html).not.toContain('secret_path');
    expect(html).toContain('Couldn’t start sign-in. Try again.');
  });

  it('explains when the official sign-in process never starts responding', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({ state: 'TIMED_OUT', reasonCode: 'AUTH_START_TIMEOUT' }),
    });

    expect(html).toContain('Sign-in timed out. Try again.');
  });

  it('uses the requested concise copy for canceled and rejected sign-in states', () => {
    const canceled = renderAuthOnboarding({
      providerId: 'codex',
      status: status({ state: 'CANCELED', reasonCode: 'AUTH_CANCELED' }),
    });
    const rejected = renderAuthOnboarding({
      providerId: 'antigravity',
      status: status({
        providerId: 'antigravity',
        state: 'FAILED',
        reasonCode: 'AUTH_CODE_REJECTED',
      }),
    });

    expect(canceled).toContain('Sign-in canceled. Try again.');
    expect(rejected).toContain(
      'Sign-in code was not accepted. Please check the code and try again.',
    );
    expect(rejected).toContain('Sign in with Google to start tracking your usage windows.');
  });

  it('labels an already connected account with a secondary reconnect action', () => {
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({ state: 'SUCCEEDED' }),
      reconnect: true,
    });

    expect(html).toContain('data-auth-role="reconnect"');
    expect(html).toContain('Reconnect Codex');
    expect(html).not.toMatch(/data-auth-start hidden/);
  });

  it('keeps the client-side flow safe and progressive', () => {
    expect(AUTH_ONBOARDING_JS).toContain('fetch(url, options)');
    expect(AUTH_ONBOARDING_JS).toContain("'[data-auth-device-code]'");
    expect(AUTH_ONBOARDING_JS).toContain('setHidden(deviceCode, !(awaiting && status?.userCode));');
    expect(AUTH_ONBOARDING_JS).toContain("readCookie('awm_csrf')");
    expect(AUTH_ONBOARDING_JS).toContain(
      "const message = status\n        ? STATE_DETAILS[state]\n        : 'The provider connection status is unavailable. Try again.';",
    );
    expect(AUTH_ONBOARDING_JS).not.toContain(
      "STATE_DETAILS[state] || 'The provider connection status is unavailable. Try again.'",
    );
    expect(AUTH_ONBOARDING_JS).toContain("input.value = ''");
    expect(AUTH_ONBOARDING_JS).toContain('setTimeout(poll, 2000)');
    expect(AUTH_ONBOARDING_JS).toContain("typeof clipboard.writeText === 'function'");
    expect(AUTH_ONBOARDING_JS).toContain('await clipboard.writeText(value)');
    expect(AUTH_ONBOARDING_JS).toContain("document.execCommand('copy') === true");
    expect(AUTH_ONBOARDING_JS).toContain("element(panel, '[data-auth-user-code]')");
    expect(AUTH_ONBOARDING_JS).toContain('code?.textContent ??');
    expect(AUTH_ONBOARDING_JS).not.toContain('textContent.trim()');
    expect(AUTH_ONBOARDING_JS).toContain("'[data-auth-copy-code]'");
    expect(AUTH_ONBOARDING_JS).toContain("'[data-auth-copy-url]'");
    expect(AUTH_ONBOARDING_JS).toContain("'[data-provider-connection-status]'");
    expect(AUTH_ONBOARDING_JS).not.toContain('localStorage');
    expect(AUTH_ONBOARDING_JS).not.toContain('sessionStorage');
    expect(AUTH_ONBOARDING_JS).not.toContain('indexedDB');
    expect(AUTH_ONBOARDING_JS).not.toContain('innerHTML');
    expect(AUTH_ONBOARDING_JS).not.toContain('console.log');
  });

  it('copies the exact current code from the refreshed DOM and reports success', async () => {
    const harness = createAuthUiHarness({
      initialCode: 'OLD-CODE',
      refreshedCode: 'aB12-Cd34',
      clipboard: { writeText: () => Promise.resolve() },
    });
    await waitForAuthRefresh();

    const code = harness.nodes.get('[data-auth-user-code]');
    expect(code?.textContent).toBe('aB12-Cd34');
    await harness.nodes.get('[data-auth-copy-code]')?.click();

    expect(harness.clipboardWrites).toEqual(['aB12-Cd34']);
    expect(harness.nodes.get('[data-auth-copy-status]')?.textContent).toBe('Code copied.');
    expect(harness.fetchRequests).toEqual([
      {
        url: '/api/v1/providers/codex/auth/status',
        method: 'GET',
        body: undefined,
      },
    ]);
  });

  it('selects the exact displayed code when Clipboard API is unavailable', async () => {
    const harness = createAuthUiHarness({
      initialCode: 'OLD-CODE',
      refreshedCode: 'x76P-7WYT',
    });
    await waitForAuthRefresh();

    await harness.nodes.get('[data-auth-copy-code]')?.click();

    expect(harness.selectedText).toBe('x76P-7WYT');
    expect(harness.nodes.get('[data-auth-copy-status]')?.textContent).toBe(
      'Copy is unavailable here. The code is selected — press Ctrl+C / Cmd+C.',
    );
  });

  it('uses the user-initiated legacy copy fallback when Clipboard API is unavailable', async () => {
    const harness = createAuthUiHarness({
      initialCode: 'OLD-CODE',
      refreshedCode: 'x76P-7WYT',
      legacyCopyWorks: true,
    });
    await waitForAuthRefresh();

    await harness.nodes.get('[data-auth-copy-code]')?.click();

    expect(harness.legacyCopies).toEqual(['x76P-7WYT']);
    expect(harness.nodes.get('[data-auth-copy-status]')?.textContent).toBe('Code copied.');
  });

  it('selects the exact displayed code after a Clipboard API rejection', async () => {
    const harness = createAuthUiHarness({
      initialCode: 'OLD-CODE',
      refreshedCode: 'pQ45-rS67',
      clipboard: {
        writeText: () => Promise.reject(new Error('clipboard_denied')),
      },
    });
    await waitForAuthRefresh();

    await harness.nodes.get('[data-auth-copy-code]')?.click();

    expect(harness.clipboardWrites).toEqual(['pQ45-rS67']);
    expect(harness.selectedText).toBe('pQ45-rS67');
    expect(harness.nodes.get('[data-auth-copy-status]')?.textContent).toBe(
      'Copy is unavailable here. The code is selected — press Ctrl+C / Cmd+C.',
    );
  });

  it('does not claim the code was copied when selection is also unavailable', async () => {
    const harness = createAuthUiHarness({
      initialCode: 'OLD-CODE',
      refreshedCode: 'new-Code',
      selectionAvailable: false,
    });
    await waitForAuthRefresh();

    await harness.nodes.get('[data-auth-copy-code]')?.click();

    expect(harness.nodes.get('[data-auth-copy-status]')?.textContent).toBe(
      'Could not copy. Select the code manually.',
    );
  });

  it('reports link-copy success and selects the actual link if clipboard access fails', async () => {
    const successful = createAuthUiHarness({
      initialCode: 'OLD-CODE',
      refreshedCode: 'NEW-CODE',
      clipboard: { writeText: () => Promise.resolve() },
    });
    await waitForAuthRefresh();
    await successful.nodes.get('[data-auth-copy-url]')?.click();
    expect(successful.clipboardWrites).toEqual(['https://auth.openai.com/device']);
    expect(successful.nodes.get('[data-auth-copy-status]')?.textContent).toBe('Link copied.');

    const unavailable = createAuthUiHarness({
      initialCode: 'OLD-CODE',
      refreshedCode: 'NEW-CODE',
    });
    await waitForAuthRefresh();
    await unavailable.nodes.get('[data-auth-copy-url]')?.click();
    expect(unavailable.selectedText).toBe('https://auth.openai.com/device');
    expect(unavailable.nodes.get('[data-auth-copy-fallback]')?.textContent).toBe(
      'https://auth.openai.com/device',
    );
    expect(unavailable.nodes.get('[data-auth-copy-status]')?.textContent).toBe(
      'Copy is unavailable here. The link is selected — press Ctrl+C / Cmd+C.',
    );
  });

  it('renders the provider code unchanged in a selectable semantic output', () => {
    const exactCode = 'aB12-Cd34';
    const html = renderAuthOnboarding({
      providerId: 'codex',
      status: status({
        state: 'AWAITING_USER_ACTION',
        userCode: exactCode,
      }),
    });

    expect(html).toMatch(
      new RegExp(`<output\\b[^>]*data-auth-user-code[^>]*>${exactCode}<\\/output>`),
    );
    expect(AUTH_ONBOARDING_CSS).toContain('user-select: all');
    expect(AUTH_ONBOARDING_CSS).toContain('white-space: pre-wrap');
    expect(AUTH_ONBOARDING_CSS).not.toContain('text-transform');
  });

  it('keeps styles scoped, responsive, and motion-conscious', () => {
    expect(AUTH_ONBOARDING_CSS).toContain('.auth-onboarding');
    expect(AUTH_ONBOARDING_CSS).toContain('.auth-copy-button');
    expect(APP_CSS).toContain('.provider-connection-badge[data-connection-state="connected"]');
    expect(APP_CSS).toContain('animation: online-pulse 1.8s ease-out infinite');
    expect(AUTH_ONBOARDING_CSS).toContain('@media (max-width: 700px)');
    expect(AUTH_ONBOARDING_CSS).toContain('prefers-reduced-motion');
    expect(AUTH_ONBOARDING_CSS).not.toMatch(/(^|\n)\s*body\s*\{/);
    expect(AUTH_ONBOARDING_CSS).not.toContain('@import');
  });
});
