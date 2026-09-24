import { escapeHtml } from './layout.js';

export const AUTH_SESSION_STATES = [
  'IDLE',
  'STARTING',
  'AWAITING_USER_ACTION',
  'VERIFYING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELED',
] as const;

export type AuthProviderId = 'codex' | 'antigravity';
export type AuthSessionState = (typeof AUTH_SESSION_STATES)[number];

export interface AuthOnboardingStatus {
  providerId: AuthProviderId;
  state: AuthSessionState;
  startedAt: string | null;
  expiresAt: string | null;
  authorizationUrl: string | null;
  userCode: string | null;
  requiresCodeSubmission: boolean;
  reasonCode: string | null;
}

export interface AuthOnboardingInput {
  providerId: AuthProviderId;
  status?: AuthOnboardingStatus | null;
  configured?: boolean;
  reconnect?: boolean;
}

const PROVIDER_LABELS: Readonly<Record<AuthProviderId, string>> = {
  codex: 'Codex',
  antigravity: 'Antigravity',
};

const STATE_DETAILS: Readonly<Record<AuthSessionState, string>> = {
  IDLE: '',
  STARTING: 'Opening sign-in…',
  AWAITING_USER_ACTION: '',
  VERIFYING: 'Checking your account…',
  SUCCEEDED: 'Connected. Usage checks are ready.',
  FAILED: '',
  TIMED_OUT: '',
  CANCELED: '',
};

const REASON_DETAILS: Readonly<Record<string, string>> = {
  ALREADY_AUTHENTICATED: 'You’re already signed in. Your account was left unchanged.',
  AUTH_STATUS_UNAVAILABLE: 'We couldn’t check your sign-in status. Try again.',
  AUTH_REQUIRED: 'Sign in to connect your account.',
  AUTH_START_FAILED: 'Couldn’t start sign-in. Try again.',
  AUTH_START_TIMEOUT: 'Sign-in timed out. Try again.',
  AUTH_PROCESS_FAILED: 'Sign-in closed before it could be confirmed. Try again.',
  AUTH_VERIFICATION_FAILED: 'We couldn’t confirm sign-in. Try again.',
  AUTH_SESSION_EXPIRED: 'Sign-in timed out. Try again.',
  AUTH_CANCELED: 'Sign-in canceled. Try again.',
  AUTH_OUTPUT_LIMIT: 'We couldn’t complete sign-in. Try again.',
  AUTH_CODE_REJECTED: 'Sign-in code was not accepted. Please check the code and try again.',
  AUTH_PROVIDER_UNAVAILABLE: 'Sign-in is temporarily unavailable. Try again later.',
};

const PROVIDER_SIGN_IN_COPY: Readonly<Record<AuthProviderId, string>> = {
  codex: 'Sign in with OpenAI to start tracking your usage windows.',
  antigravity: 'Sign in with Google to start tracking your usage windows.',
};

const ACTIVE_STATES = new Set<AuthSessionState>(['STARTING', 'AWAITING_USER_ACTION', 'VERIFYING']);

export function renderAuthOnboarding(input: AuthOnboardingInput): string {
  const providerLabel = PROVIDER_LABELS[input.providerId];
  const panelId = `auth-onboarding-${input.providerId}`;
  const providerPath = encodeURIComponent(input.providerId);
  const statusUrl = `/api/v1/providers/${providerPath}/auth/status`;
  const startUrl = `/api/v1/providers/${providerPath}/auth/start`;
  const submitUrl = `/api/v1/providers/${providerPath}/auth/submit`;
  const cancelUrl = `/api/v1/providers/${providerPath}/auth/cancel`;

  if (input.configured === false) {
    return renderPanel({
      input,
      panelId,
      providerLabel,
      statusUrl,
      startUrl,
      submitUrl,
      cancelUrl,
      state: 'empty',
      detail: 'Sign-in is not available for this provider yet.',
      startHidden: true,
      cancelHidden: true,
      awaitingHidden: true,
    });
  }

  if (input.status === undefined) {
    return renderPanel({
      input,
      panelId,
      providerLabel,
      statusUrl,
      startUrl,
      submitUrl,
      cancelUrl,
      state: 'loading',
      detail: 'Checking your connection…',
      startHidden: true,
      cancelHidden: true,
      awaitingHidden: true,
    });
  }

  if (input.status === null) {
    return renderPanel({
      input,
      panelId,
      providerLabel,
      statusUrl,
      startUrl,
      submitUrl,
      cancelUrl,
      state: 'error',
      detail: 'The provider connection status could not be loaded. Try again.',
      startHidden: false,
      cancelHidden: true,
      awaitingHidden: true,
    });
  }

  const status = input.status;
  const active = ACTIVE_STATES.has(status.state);
  const awaiting = status.state === 'AWAITING_USER_ACTION';
  const authorizationUrl = awaiting ? safeAuthorizationUrl(status.authorizationUrl) : null;
  const reasonDetail = status.reasonCode ? REASON_DETAILS[status.reasonCode] : undefined;

  return renderPanel({
    input,
    panelId,
    providerLabel,
    statusUrl,
    startUrl,
    submitUrl,
    cancelUrl,
    state: status.state,
    detail: STATE_DETAILS[status.state],
    startHidden: active || (status.state === 'SUCCEEDED' && !input.reconnect),
    cancelHidden: !active,
    awaitingHidden: !awaiting,
    authorizationUrl,
    userCode: awaiting ? status.userCode : null,
    requiresCodeSubmission: awaiting && status.requiresCodeSubmission,
    errorMessage:
      status.state === 'FAILED' || status.state === 'TIMED_OUT' || status.state === 'CANCELED'
        ? reasonDetail ||
          (status.state === 'FAILED'
            ? 'We couldn’t complete sign-in. Try again.'
            : status.state === 'TIMED_OUT'
              ? 'Sign-in timed out. Try again.'
              : 'Sign-in canceled. Try again.')
        : undefined,
    expiresAt: active ? status.expiresAt : null,
  });
}

interface RenderPanelInput {
  input: AuthOnboardingInput;
  panelId: string;
  providerLabel: string;
  statusUrl: string;
  startUrl: string;
  submitUrl: string;
  cancelUrl: string;
  state: AuthSessionState | 'empty' | 'loading' | 'error';
  detail: string;
  startHidden: boolean;
  cancelHidden: boolean;
  awaitingHidden: boolean;
  authorizationUrl?: string | null;
  userCode?: string | null;
  requiresCodeSubmission?: boolean;
  errorMessage?: string | undefined;
  expiresAt?: string | null;
}

function renderPanel(input: RenderPanelInput): string {
  const state = escapeHtml(input.state);
  const panelId = escapeHtml(input.panelId);
  const providerLabel = escapeHtml(input.providerLabel);
  const statusUrl = escapeHtml(input.statusUrl);
  const startUrl = escapeHtml(input.startUrl);
  const submitUrl = escapeHtml(input.submitUrl);
  const cancelUrl = escapeHtml(input.cancelUrl);
  const isAwaiting = input.state === 'AWAITING_USER_ACTION';
  const code = isAwaiting && input.userCode ? input.userCode : null;
  const link = isAwaiting ? (input.authorizationUrl ?? null) : null;
  const expiresAt = input.expiresAt ? escapeHtml(input.expiresAt) : null;
  const errorMessage = input.errorMessage ? escapeHtml(input.errorMessage) : '';

  const providerCopy = input.input.reconnect
    ? `Reconnect your ${providerLabel} account to resume usage tracking.`
    : PROVIDER_SIGN_IN_COPY[input.input.providerId];
  const actionLabel = input.input.reconnect
    ? `Reconnect ${providerLabel}`
    : `Connect ${providerLabel}`;
  return `<section class="auth-onboarding" data-auth-onboarding data-auth-role="${input.input.reconnect ? 'reconnect' : 'connect'}" data-auth-state="${state}" data-auth-provider-id="${escapeHtml(input.input.providerId)}" data-auth-status-url="${statusUrl}" data-auth-start-url="${startUrl}" data-auth-submit-url="${submitUrl}" data-auth-cancel-url="${cancelUrl}" aria-label="${escapeHtml(providerLabel)} account sign-in">
  <div class="auth-onboarding__body">
    <p class="auth-onboarding__intro">${escapeHtml(providerCopy)}</p>
    <p class="auth-onboarding__detail" data-auth-status-detail aria-live="polite"${input.detail ? '' : ' hidden'}>${escapeHtml(input.detail)}</p>
    <p class="auth-onboarding__expiry" data-auth-expiry${expiresAt ? '' : ' hidden'}>${expiresAt ? `This sign-in expires at <time datetime="${expiresAt}">${expiresAt}</time>.` : ''}</p>
    <p class="auth-onboarding__error" data-auth-error role="alert"${errorMessage ? '' : ' hidden'}>${errorMessage}</p>
    <div class="auth-onboarding__actions" data-auth-actions>
      <button class="button button-primary" type="button" data-auth-start${input.startHidden ? ' hidden' : ''}>${escapeHtml(actionLabel)}</button>
      <button class="button button-secondary" type="button" data-auth-cancel${input.cancelHidden ? ' hidden' : ''}>Cancel</button>
    </div>
    <div class="auth-onboarding__awaiting" data-auth-awaiting${input.awaitingHidden ? ' hidden' : ''}>
      <div class="auth-onboarding__next-step">
        <span class="field-label">Next step</span>
        <p>Open the sign-in page and finish the request there.</p>
        <div class="auth-onboarding__link-actions"><a class="button button-secondary" data-auth-authorization${link ? '' : ' hidden'}${link ? ` href="${escapeHtml(link)}"` : ''} target="_blank" rel="noopener noreferrer">Open sign-in</a><button class="auth-copy-button" type="button" data-auth-copy-url${link ? '' : ' hidden'} aria-label="Copy sign-in link"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="7" y="7" width="10" height="11" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>Copy link</span></button></div>
      </div>
      <div class="auth-onboarding__device-code" data-auth-device-code${code ? '' : ' hidden'} aria-live="polite">
        <span class="field-label">Sign-in code</span>
        <p class="auth-onboarding__code-hint">Enter this code on the sign-in page.</p>
        <div class="auth-onboarding__code-copy-row"><p class="auth-onboarding__user-code" data-auth-user-code${code ? '' : ' hidden'}>${code ? escapeHtml(code) : ''}</p><button class="auth-copy-button" type="button" data-auth-copy-code${code ? '' : ' hidden'} aria-label="Copy sign-in code"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="7" y="7" width="10" height="11" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>Copy code</span></button></div>
      </div>
      <div class="auth-onboarding__code" data-auth-code-section${input.requiresCodeSubmission ? '' : ' hidden'}>
        <label class="field-label" for="${panelId}-code">Sign-in code</label>
        <p class="auth-onboarding__code-hint">Enter the code shown by the provider.</p>
        <div class="auth-onboarding__code-row">
        <input id="${panelId}-code" type="text" inputmode="text" autocomplete="one-time-code" spellcheck="false" maxlength="128" data-auth-code-input aria-describedby="${panelId}-code-hint">
          <button class="button button-primary" type="button" data-auth-submit>Continue</button>
        </div>
        <p id="${panelId}-code-hint" class="field-help">The code is cleared after submission.</p>
      </div>
    </div>
    <p class="auth-onboarding__copy-status" data-auth-copy-status role="status" aria-live="polite"></p>
  </div>
  <noscript><p class="auth-onboarding__noscript">JavaScript is required to connect an account.</p></noscript>
</section>`;
}

function safeAuthorizationUrl(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
