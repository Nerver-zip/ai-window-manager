import escapeHtml from 'escape-html';

export type OperatorLoginError = 'invalid_credentials' | 'too_many_attempts' | 'session_expired';

const LOGIN_ERROR_COPY: Readonly<Record<OperatorLoginError, string>> = {
  invalid_credentials: 'Invalid username or password.',
  too_many_attempts: 'Too many sign-in attempts. Try again shortly.',
  session_expired: 'Your session expired. Sign in again.',
};

export function renderOperatorLoginPage(input: {
  csrfToken: string;
  next: string;
  error?: OperatorLoginError;
}): string {
  const errorCopy = input.error ? LOGIN_ERROR_COPY[input.error] : null;

  return renderOperatorAuthDocument(
    'Sign in',
    `<main class="operator-auth-layout">
  <div class="operator-auth-main">
    ${renderOperatorBrand()}
    <section class="operator-auth-panel" aria-labelledby="operator-auth-title">
      <p class="operator-auth-eyebrow">PRIVATE WORKSPACE</p>
      <h1 id="operator-auth-title">Sign in</h1>
      <p class="operator-auth-copy">Sign in to continue to AI Window Manager.</p>
      <p id="operator-auth-error" class="operator-auth-error" role="alert" aria-live="assertive"${errorCopy ? '' : ' hidden'}>${errorCopy ? escapeHtml(errorCopy) : ''}</p>
      <form class="operator-auth-form" method="post" action="/login" aria-describedby="operator-auth-error">
        <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}">
        <input type="hidden" name="next" value="${escapeHtml(input.next)}">
        <label for="operator-auth-username">Username
          <input id="operator-auth-username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus>
        </label>
        <label for="operator-auth-password">Password
          <input id="operator-auth-password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
        </label>
        <button class="button button-primary operator-auth-submit" type="submit">Sign in</button>
      </form>
    </section>
  </div>
</main>`,
  );
}

export function renderOperatorLogoutPage(input: { csrfToken: string }): string {
  return renderOperatorAuthDocument(
    'Sign out',
    `<main class="operator-auth-layout">
  <div class="operator-auth-main">
    ${renderOperatorBrand()}
    <section class="operator-auth-panel" aria-labelledby="operator-auth-title">
      <p class="operator-auth-eyebrow">ACCOUNT</p>
      <h1 id="operator-auth-title">Sign out?</h1>
      <p class="operator-auth-copy">You will need to sign in again to use AI Window Manager.</p>
      <form class="operator-auth-form operator-auth-form--logout" method="post" action="/logout">
        <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}">
        <button class="button button-primary operator-auth-submit" type="submit">Sign out</button>
        <a class="button button-secondary operator-auth-cancel" href="/">Stay signed in</a>
      </form>
    </section>
  </div>
</main>`,
  );
}

function renderOperatorBrand(): string {
  return `<div class="operator-auth-brand">
      <img src="/assets/images/logo.png" alt="" width="44" height="44">
      <span>AI Window<span class="operator-auth-brand-subtitle">MANAGER</span></span>
    </div>`;
}

function renderOperatorAuthDocument(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)} · AI Window Manager</title><link rel="icon" type="image/png" href="/assets/images/logo.png"><link rel="stylesheet" href="/assets/app.css"></head><body class="operator-auth-body">${content}</body></html>`;
}
