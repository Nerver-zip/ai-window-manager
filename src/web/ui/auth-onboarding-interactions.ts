/** Progressive enhancement for the safe provider-auth onboarding DTO. */
export const AUTH_ONBOARDING_JS = String.raw`(() => {
  const ACTIVE_STATES = new Set(['STARTING', 'AWAITING_USER_ACTION', 'VERIFYING']);
  const STATES = new Set(['IDLE', 'STARTING', 'AWAITING_USER_ACTION', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED']);
  const STATE_LABELS = {
    IDLE: 'Not connected',
    STARTING: 'Starting sign-in',
    AWAITING_USER_ACTION: 'Action needed',
    VERIFYING: 'Checking sign-in',
    SUCCEEDED: 'Connected',
    FAILED: 'Sign-in failed',
    TIMED_OUT: 'Sign-in expired',
    CANCELED: 'Sign-in canceled',
  };
  const STATE_DETAILS = {
    IDLE: 'Start the official sign-in flow to connect this provider.',
    STARTING: 'The official provider client is preparing a sign-in request.',
    AWAITING_USER_ACTION: 'Continue in the official provider sign-in page.',
    VERIFYING: 'The provider client is checking that sign-in completed.',
    SUCCEEDED: 'This provider is connected and ready for usage checks.',
    FAILED: 'The official sign-in could not be completed. You can try again.',
    TIMED_OUT: 'The sign-in window expired before it was completed. Start again.',
    CANCELED: 'The sign-in request was canceled. You can start again.',
  };

  const reasonDetails = {
    ALREADY_AUTHENTICATED: 'This provider is already signed in. The existing sign-in was left unchanged.',
    AUTH_STATUS_UNAVAILABLE: 'The app could not safely check the current sign-in state. The existing sign-in was left unchanged.',
    AUTH_REQUIRED: 'The provider needs you to sign in with its official client.',
    AUTH_START_FAILED: 'The official client could not start sign-in.',
    AUTH_START_TIMEOUT: 'The official sign-in process did not respond in time. Try again.',
    AUTH_PROCESS_FAILED: 'The official client ended before sign-in could be verified.',
    AUTH_VERIFICATION_FAILED: 'Sign-in finished, but the provider could not verify it.',
    AUTH_SESSION_EXPIRED: 'The sign-in window expired before it was completed.',
    AUTH_CANCELED: 'The sign-in request was canceled.',
    AUTH_OUTPUT_LIMIT: 'The provider returned too much sign-in output. The session was stopped safely.',
    AUTH_CODE_REJECTED: 'The provider did not accept that sign-in code. Check it and try again.',
    AUTH_PROVIDER_UNAVAILABLE: 'The official provider client is not available right now.',
  };

  function readCookie(name) {
    const prefix = name + '=';
    for (const part of document.cookie.split(';')) {
      const value = part.trim();
      if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
    }
    return null;
  }

  function csrfHeaders() {
    const token = readCookie('awm_csrf');
    return token ? { 'x-csrf-token': token } : {};
  }

  function safeUrl(value, providerId) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
    try {
      const url = new URL(value, window.location.origin);
      const expectedHost = providerId === 'codex' ? 'auth.openai.com' : providerId === 'antigravity' ? 'accounts.google.com' : null;
      return url.protocol === 'https:' && expectedHost && url.hostname.toLowerCase() === expectedHost ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function readStatus(payload, providerId) {
    if (!payload || typeof payload !== 'object' || payload.providerId !== providerId || !STATES.has(payload.state)) return null;
    return {
      state: payload.state,
      expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
      authorizationUrl: typeof payload.authorizationUrl === 'string' ? payload.authorizationUrl : null,
      userCode: typeof payload.userCode === 'string' && payload.userCode.length <= 128 ? payload.userCode : null,
      requiresCodeSubmission: payload.requiresCodeSubmission === true,
      reasonCode: typeof payload.reasonCode === 'string' && payload.reasonCode.length <= 128 ? payload.reasonCode : null,
    };
  }

  function element(panel, selector) {
    return panel.querySelector(selector);
  }

  function setHidden(node, hidden) {
    if (node) node.hidden = hidden;
  }

  function render(panel, status) {
    const state = status?.state || 'FAILED';
    const active = ACTIVE_STATES.has(state);
    const awaiting = state === 'AWAITING_USER_ACTION';
    panel.dataset.authState = state;
    const badge = element(panel, '[data-auth-status-badge]');
    const statusLabel = element(panel, '[data-auth-status-label]');
    const detail = element(panel, '[data-auth-status-detail]');
    const error = element(panel, '[data-auth-error]');
    const expiry = element(panel, '[data-auth-expiry]');
    const start = element(panel, '[data-auth-start]');
    const cancel = element(panel, '[data-auth-cancel]');
    const awaitingPanel = element(panel, '[data-auth-awaiting]');
    const authorization = element(panel, '[data-auth-authorization]');
    const codeSection = element(panel, '[data-auth-code-section]');
    const userCode = element(panel, '[data-auth-user-code]');
    const codeInput = element(panel, '[data-auth-code-input]');

    if (badge) badge.dataset.authState = state;
    if (statusLabel) statusLabel.textContent = STATE_LABELS[state] || 'Status unavailable';
    if (detail) detail.textContent = STATE_DETAILS[state] || 'The provider connection status is unavailable. Try again.';
    if (start) {
      start.hidden = active || state === 'SUCCEEDED';
      start.disabled = active;
    }
    if (cancel) {
      cancel.hidden = !active;
      cancel.disabled = false;
    }
    setHidden(awaitingPanel, !awaiting);
    setHidden(codeSection, !(awaiting && status?.requiresCodeSubmission === true));
    setHidden(expiry, !active || !status?.expiresAt);
    if (expiry && active && status?.expiresAt) {
      expiry.textContent = 'This sign-in expires at ' + status.expiresAt + '.';
    }
    const link = awaiting ? safeUrl(status?.authorizationUrl, panel.dataset.authProviderId) : null;
    setHidden(authorization, !link);
    if (authorization && link) authorization.href = link;
    setHidden(userCode, !(awaiting && status?.userCode));
    if (userCode) userCode.textContent = awaiting && status?.userCode ? status.userCode : '';
    if (error) {
      const message = state === 'FAILED' || state === 'TIMED_OUT' || state === 'CANCELED'
        ? reasonDetails[status?.reasonCode] || STATE_DETAILS[state]
        : '';
      error.textContent = message;
      error.hidden = !message;
    }
    if (codeInput && !awaiting) codeInput.value = '';
  }

  async function request(panel, url, method, body) {
    const headers = { Accept: 'application/json', ...csrfHeaders() };
    const options = { method, credentials: 'same-origin', headers };
    if (body) {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    if (!response.ok) throw new Error('request_failed');
    const payload = await response.json();
    return readStatus(payload, panel.dataset.authProviderId);
  }

  for (const panel of document.querySelectorAll('[data-auth-onboarding]')) {
    let pollTimer = null;
    let busy = false;

    const stopPolling = () => {
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = null;
    };

    const poll = async () => {
      stopPolling();
      if (!ACTIVE_STATES.has(panel.dataset.authState || '')) return;
      try {
        const status = await request(panel, panel.dataset.authStatusUrl, 'GET');
        if (!status) throw new Error('invalid_status');
        render(panel, status);
        if (ACTIVE_STATES.has(status.state)) pollTimer = window.setTimeout(poll, 2000);
      } catch {
        const error = element(panel, '[data-auth-error]');
        if (error) {
          error.textContent = 'The provider connection status could not be refreshed.';
          error.hidden = false;
        }
        if (ACTIVE_STATES.has(panel.dataset.authState || '')) pollTimer = window.setTimeout(poll, 4000);
      }
    };

    const mutate = async (url, body) => {
      if (busy) return;
      busy = true;
      try {
        const status = await request(panel, url, 'POST', body);
        if (!status) throw new Error('invalid_status');
        render(panel, status);
        if (ACTIVE_STATES.has(status.state)) pollTimer = window.setTimeout(poll, 2000);
      } catch {
        const error = element(panel, '[data-auth-error]');
        if (error) {
          error.textContent = 'The provider sign-in request could not be completed. Try again.';
          error.hidden = false;
        }
      } finally {
        busy = false;
      }
    };

    element(panel, '[data-auth-start]')?.addEventListener('click', () => {
      mutate(panel.dataset.authStartUrl, null);
    });
    element(panel, '[data-auth-cancel]')?.addEventListener('click', () => {
      mutate(panel.dataset.authCancelUrl, null);
    });
    element(panel, '[data-auth-submit]')?.addEventListener('click', () => {
      const input = element(panel, '[data-auth-code-input]');
      const code = input?.value.trim() || '';
      if (!code || code.length > 128) {
        const error = element(panel, '[data-auth-error]');
        if (error) {
          error.textContent = 'Enter the one-time code before continuing.';
          error.hidden = false;
        }
        input?.focus();
        return;
      }
      if (input) input.value = '';
      mutate(panel.dataset.authSubmitUrl, { code });
    });

    if (ACTIVE_STATES.has(panel.dataset.authState || '')) poll();
  }
})();`;
