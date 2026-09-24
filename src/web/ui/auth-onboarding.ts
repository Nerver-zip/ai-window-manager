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
}

const PROVIDER_LABELS: Readonly<Record<AuthProviderId, string>> = {
  codex: 'Codex',
  antigravity: 'Antigravity',
};

const STATE_LABELS: Readonly<Record<AuthSessionState, string>> = {
  IDLE: 'Not connected',
  STARTING: 'Starting sign-in',
  AWAITING_USER_ACTION: 'Action needed',
  VERIFYING: 'Checking sign-in',
  SUCCEEDED: 'Connected',
  FAILED: 'Sign-in failed',
  TIMED_OUT: 'Sign-in expired',
  CANCELED: 'Sign-in canceled',
};

const STATE_DETAILS: Readonly<Record<AuthSessionState, string>> = {
  IDLE: 'Start the official sign-in flow to connect this provider.',
  STARTING: 'The official provider client is preparing a sign-in request.',
  AWAITING_USER_ACTION: 'Continue in the official provider sign-in page.',
  VERIFYING: 'The provider client is checking that sign-in completed.',
  SUCCEEDED: 'This provider is connected and ready for usage checks.',
  FAILED: 'The official sign-in could not be completed. You can try again.',
  TIMED_OUT: 'The sign-in window expired before it was completed. Start again.',
  CANCELED: 'The sign-in request was canceled. You can start again.',
};

const REASON_DETAILS: Readonly<Record<string, string>> = {
  ALREADY_AUTHENTICATED:
    'This provider is already signed in. The existing sign-in was left unchanged.',
  AUTH_STATUS_UNAVAILABLE:
    'The app could not safely check the current sign-in state. The existing sign-in was left unchanged.',
  AUTH_REQUIRED: 'The provider needs you to sign in with its official client.',
  AUTH_START_FAILED: 'The official client could not start sign-in.',
  AUTH_START_TIMEOUT: 'The official sign-in process did not respond in time. Try again.',
  AUTH_PROCESS_FAILED: 'The official client ended before sign-in could be verified.',
  AUTH_VERIFICATION_FAILED: 'Sign-in finished, but the provider could not verify it.',
  AUTH_SESSION_EXPIRED: 'The sign-in window expired before it was completed.',
  AUTH_CANCELED: 'The sign-in request was canceled.',
  AUTH_OUTPUT_LIMIT:
    'The provider returned too much sign-in output. The session was stopped safely.',
  AUTH_CODE_REJECTED: 'The provider did not accept that sign-in code. Check it and try again.',
  AUTH_PROVIDER_UNAVAILABLE: 'The official provider client is not available right now.',
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
      statusLabel: 'Not configured',
      detail: 'Authentication is not configured for this provider.',
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
      statusLabel: 'Checking sign-in status',
      detail: 'Loading the provider connection status.',
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
      statusLabel: 'Status unavailable',
      detail: 'The provider connection status could not be loaded. Try again.',
      startHidden: false,
      cancelHidden: true,
      awaitingHidden: true,
      errorMessage: 'The status check failed. Starting sign-in will try again.',
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
    statusLabel: STATE_LABELS[status.state],
    detail: STATE_DETAILS[status.state],
    startHidden: active || status.state === 'SUCCEEDED',
    cancelHidden: !active,
    awaitingHidden: !awaiting,
    authorizationUrl,
    userCode: awaiting ? status.userCode : null,
    requiresCodeSubmission: awaiting && status.requiresCodeSubmission,
    errorMessage:
      status.state === 'FAILED' || status.state === 'TIMED_OUT' || status.state === 'CANCELED'
        ? (reasonDetail ?? STATE_DETAILS[status.state])
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
  statusLabel: string;
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

  return `<section class="auth-onboarding" data-auth-onboarding data-auth-state="${state}" data-auth-provider-id="${escapeHtml(input.input.providerId)}" data-auth-status-url="${statusUrl}" data-auth-start-url="${startUrl}" data-auth-submit-url="${submitUrl}" data-auth-cancel-url="${cancelUrl}" aria-labelledby="${panelId}-title">
  <div class="auth-onboarding__header">
    <div>
      <p class="eyebrow">Account connection</p>
      <h2 id="${panelId}-title">Connect ${providerLabel}</h2>
      <p class="auth-onboarding__intro">Sign in through the provider’s official client. AI Window Manager never asks for your password or tokens.</p>
    </div>
    <span class="auth-onboarding__status" data-auth-status-badge data-auth-state="${state}"><span class="auth-onboarding__status-dot" aria-hidden="true"></span><span data-auth-status-label>${escapeHtml(input.statusLabel)}</span></span>
  </div>
  <div class="auth-onboarding__body">
    <p class="auth-onboarding__detail" data-auth-status-detail aria-live="polite">${escapeHtml(input.detail)}</p>
    <p class="auth-onboarding__expiry" data-auth-expiry${expiresAt ? '' : ' hidden'}>${expiresAt ? `This sign-in expires at <time datetime="${expiresAt}">${expiresAt}</time>.` : ''}</p>
    <p class="auth-onboarding__error" data-auth-error role="alert"${errorMessage ? '' : ' hidden'}>${errorMessage}</p>
    <div class="auth-onboarding__actions" data-auth-actions>
      <button class="button button-primary" type="button" data-auth-start${input.startHidden ? ' hidden' : ''}>Start official sign-in</button>
      <button class="button button-secondary" type="button" data-auth-cancel${input.cancelHidden ? ' hidden' : ''}>Cancel</button>
    </div>
    <div class="auth-onboarding__awaiting" data-auth-awaiting${input.awaitingHidden ? ' hidden' : ''}>
      <div class="auth-onboarding__next-step">
        <span class="field-label">Next step</span>
        <p>Open the official sign-in page and finish the request there.</p>
        <a class="button button-secondary" data-auth-authorization${link ? '' : ' hidden'}${link ? ` href="${escapeHtml(link)}"` : ''} target="_blank" rel="noopener noreferrer">Open official sign-in</a>
      </div>
      <div class="auth-onboarding__code" data-auth-code-section${input.requiresCodeSubmission ? '' : ' hidden'}>
        <label class="field-label" for="${panelId}-code">One-time code</label>
        <p class="auth-onboarding__code-hint">Use the code shown by the official provider sign-in flow.</p>
        <p class="auth-onboarding__user-code" data-auth-user-code${code ? '' : ' hidden'}>${code ? escapeHtml(code) : ''}</p>
        <div class="auth-onboarding__code-row">
        <input id="${panelId}-code" type="text" inputmode="text" autocomplete="one-time-code" spellcheck="false" maxlength="128" data-auth-code-input aria-describedby="${panelId}-code-hint">
          <button class="button button-primary" type="button" data-auth-submit>Continue</button>
        </div>
        <p id="${panelId}-code-hint" class="field-help">The code is used once and is cleared immediately after submission.</p>
      </div>
    </div>
  </div>
  <noscript><p class="auth-onboarding__noscript">JavaScript is required to start and verify provider sign-in.</p></noscript>
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
