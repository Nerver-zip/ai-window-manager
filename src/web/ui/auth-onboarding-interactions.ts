/** Progressive enhancement for the safe provider-auth onboarding DTO. */
export const AUTH_ONBOARDING_JS = String.raw`(() => {
  const ACTIVE_STATES = new Set(['STARTING', 'AWAITING_USER_ACTION', 'VERIFYING']);
  const STATES = new Set(['IDLE', 'STARTING', 'AWAITING_USER_ACTION', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED']);
  const STATE_DETAILS = {
    IDLE: '',
    STARTING: 'Opening sign-in…',
    AWAITING_USER_ACTION: '',
    VERIFYING: 'Checking your account…',
    SUCCEEDED: 'Connected. Usage checks are ready.',
    FAILED: '',
    TIMED_OUT: '',
    CANCELED: '',
  };

  const reasonDetails = {
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
    const detail = element(panel, '[data-auth-status-detail]');
    const error = element(panel, '[data-auth-error]');
    const expiry = element(panel, '[data-auth-expiry]');
    const start = element(panel, '[data-auth-start]');
    const cancel = element(panel, '[data-auth-cancel]');
    const awaitingPanel = element(panel, '[data-auth-awaiting]');
    const authorization = element(panel, '[data-auth-authorization]');
    const deviceCode = element(panel, '[data-auth-device-code]');
    const codeSection = element(panel, '[data-auth-code-section]');
    const userCode = element(panel, '[data-auth-user-code]');
    const copyCode = element(panel, '[data-auth-copy-code]');
    const copyUrl = element(panel, '[data-auth-copy-url]');
    const codeInput = element(panel, '[data-auth-code-input]');

    if (detail) {
      const message = status
        ? STATE_DETAILS[state]
        : 'The provider connection status is unavailable. Try again.';
      detail.textContent = message;
      detail.hidden = !message;
    }
    if (start) {
      start.hidden = active || (state === 'SUCCEEDED' && panel.dataset.authRole !== 'reconnect');
      start.disabled = active;
    }
    if (cancel) {
      cancel.hidden = !active;
      cancel.disabled = false;
    }
    setHidden(awaitingPanel, !awaiting);
    setHidden(deviceCode, !(awaiting && status?.userCode));
    setHidden(copyCode, !(awaiting && status?.userCode));
    setHidden(codeSection, !(awaiting && status?.requiresCodeSubmission === true));
    setHidden(expiry, !active || !status?.expiresAt);
    if (expiry && active && status?.expiresAt) {
      expiry.textContent = 'This sign-in expires at ' + status.expiresAt + '.';
    }
    const link = awaiting ? safeUrl(status?.authorizationUrl, panel.dataset.authProviderId) : null;
    setHidden(authorization, !link);
    setHidden(copyUrl, !link);
    if (authorization && link) authorization.href = link;
    setHidden(userCode, !(awaiting && status?.userCode));
    if (userCode) userCode.textContent = awaiting && status?.userCode ? status.userCode : '';
    if (error) {
      const message = state === 'FAILED' || state === 'TIMED_OUT' || state === 'CANCELED'
        ? reasonDetails[status?.reasonCode] || (state === 'FAILED' ? 'We couldn’t complete sign-in. Try again.' : state === 'TIMED_OUT' ? 'Sign-in timed out. Try again.' : 'Sign-in canceled. Try again.')
        : '';
      error.textContent = message;
      error.hidden = !message;
    }
    if (codeInput && !awaiting) codeInput.value = '';

    const card = panel.closest('.provider-settings');
    if (card) {
      const badge = element(card, '[data-provider-connection-status]');
      const label = element(card, '[data-provider-connection-label]');
      const settings = element(card, '[data-provider-settings-form]');
      const note = element(card, '[data-provider-monitoring-note]');
      const previouslyConnected = card.dataset.providerConnected === 'true';
      let connectionState = 'disconnected';
      let connectionLabel = 'Not connected';
      let ready = false;
      if (state === 'SUCCEEDED' || status?.reasonCode === 'ALREADY_AUTHENTICATED') {
        connectionState = 'connected';
        connectionLabel = 'Connected';
        ready = true;
      } else if (status?.reasonCode === 'AUTH_REQUIRED') {
        connectionState = 'required';
        connectionLabel = 'Sign-in required';
      } else if (active) {
        connectionState = 'connecting';
        connectionLabel = 'Signing in…';
        ready = previouslyConnected;
      } else if (previouslyConnected) {
        connectionState = 'connected';
        connectionLabel = 'Connected';
        ready = true;
      }
      if (badge) {
        badge.dataset.connectionState = connectionState;
        badge.classList.toggle('badge-success', connectionState === 'connected');
        badge.classList.toggle('badge-warning', connectionState === 'required');
      }
      if (label) label.textContent = connectionLabel;
      card.dataset.providerConnected = ready ? 'true' : 'false';
      setHidden(settings, !ready);
      setHidden(note, ready);
      if (
        (state === 'SUCCEEDED' || status?.reasonCode === 'ALREADY_AUTHENTICATED') &&
        panel.dataset.authRole === 'connect'
      ) {
        setHidden(panel.closest('[data-provider-auth-area]'), true);
      }
    }
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

    const reportCopyResult = (message) => {
      const status = element(panel, '[data-auth-copy-status]');
      if (status) status.textContent = message;
    };

    const copy = async (value) => {
      if (!value || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        reportCopyResult('Copy is unavailable. Select and copy the text instead.');
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
        reportCopyResult('Copied.');
      } catch {
        reportCopyResult('Couldn’t copy. Select and copy the text instead.');
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
    element(panel, '[data-auth-copy-code]')?.addEventListener('click', () => {
      const code = element(panel, '[data-auth-user-code]')?.textContent.trim();
      copy(code);
    });
    element(panel, '[data-auth-copy-url]')?.addEventListener('click', () => {
      const url = element(panel, '[data-auth-authorization]')?.href;
      const safe = safeUrl(url, panel.dataset.authProviderId);
      copy(safe);
    });

    if (ACTIVE_STATES.has(panel.dataset.authState || '')) poll();
  }
})();`;
