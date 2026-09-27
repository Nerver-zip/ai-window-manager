/** Small same-origin SSR region refresh runtime. Native forms remain canonical. */
export const PROGRESSIVE_INTERACTIONS_JS = String.raw`(() => {
  const TARGET_PATTERN = /^[a-z][a-z0-9:._-]{0,127}$/i;
  const REGION_SELECTOR = '[data-awm-region]';
  const pendingForms = new WeakSet();
  const pendingMutationTargets = new Set();
  const getRequests = new Map();
  let getSequence = 0;

  function all(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const result = [];
    if (typeof root.matches === 'function' && root.matches(selector)) result.push(root);
    result.push(...root.querySelectorAll(selector));
    return result;
  }

  function validTarget(value) {
    return typeof value === 'string' && TARGET_PATTERN.test(value);
  }

  function findRegion(root, target) {
    if (!validTarget(target)) return null;
    const matches = all(root, REGION_SELECTOR).filter((region) => region.dataset.awmRegion === target);
    return matches.length === 1 ? matches[0] : null;
  }

  function sameOriginUrl(value, base) {
    try {
      const url = new URL(value, base || window.location.href);
      return url.origin === window.location.origin ? url : null;
    } catch {
      return null;
    }
  }

  function announce(message) {
    const status = document.querySelector('[data-awm-interaction-status]');
    if (status) status.textContent = message;
  }

  function setBusy(region, busy) {
    if (busy) {
      region.setAttribute('aria-busy', 'true');
      region.classList?.add('awm-is-loading');
      return;
    }
    region.removeAttribute('aria-busy');
    region.classList?.remove('awm-is-loading');
  }

  function captureFocus(region) {
    const active = document.activeElement;
    if (!active || !region.contains(active)) return null;
    return {
      key: active.getAttribute?.('data-awm-focus-key') || active.id || '',
      keyed: Boolean(active.getAttribute?.('data-awm-focus-key')),
    };
  }

  function focusAfterReplace(region, previousFocus) {
    if (!previousFocus) return;
    let candidate = null;
    if (previousFocus.key) {
      candidate = all(region, previousFocus.keyed ? '[data-awm-focus-key]' : '[id]').find((node) =>
        previousFocus.keyed
          ? node.getAttribute('data-awm-focus-key') === previousFocus.key
          : node.id === previousFocus.key,
      );
    }
    if (!candidate) {
      candidate =
        all(region, '[data-awm-focus-fallback]')[0] ||
        all(region, '[role="alert"]')[0] ||
        all(region, 'h1')[0] ||
        all(region, 'h2')[0] ||
        all(region, 'h3')[0];
    }
    candidate?.focus?.({ preventScroll: true });
  }

  function dispatchLifecycle(name, root) {
    document.dispatchEvent(new CustomEvent(name, { detail: { root } }));
  }

  function replaceRegion(target, parsedDocument) {
    const current = findRegion(document, target);
    const incoming = findRegion(parsedDocument, target);
    if (!current || !incoming) return null;

    const previousFocus = captureFocus(current);
    dispatchLifecycle('awm:dispose', current);
    const replacement = document.importNode
      ? document.importNode(incoming, true)
      : incoming.cloneNode(true);
    for (const script of all(replacement, 'script')) script.remove();
    current.replaceWith(replacement);

    const title = parsedDocument.querySelector('title')?.textContent?.trim();
    if (title) document.title = title;
    dispatchLifecycle('awm:enhance', replacement);
    focusAfterReplace(replacement, previousFocus);
    return replacement;
  }

  function announcementFor(region, fallback) {
    const message = region?.querySelector('[data-awm-announcement]')?.textContent?.trim();
    return message || fallback;
  }

  function showFailure(region, message, href, actionLabel) {
    if (!region) return;
    region.querySelector('[data-awm-interaction-error]')?.remove();
    const error = document.createElement('div');
    error.className = 'awm-interaction-error';
    error.dataset.awmInteractionError = 'true';
    error.setAttribute('role', 'alert');
    const detail = document.createElement('p');
    detail.textContent = message;
    error.append(detail);
    const retry = document.createElement('a');
    retry.className = 'button button-secondary';
    retry.href = href;
    retry.textContent = actionLabel;
    error.append(retry);
    region.prepend(error);
  }

  function parsedHtml(response, html) {
    const contentType = response.headers?.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/html')) return null;
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function finalSameOriginUrl(response, fallback) {
    return sameOriginUrl(response.url || fallback.href, window.location.href);
  }

  function isLoginResponse(response, finalUrl) {
    return finalUrl?.pathname === '/login' || response.status === 401;
  }

  function setHistory(url, mode) {
    if (mode === 'none') return;
    const current = history.state;
    const state = current && typeof current === 'object' && !Array.isArray(current)
      ? { ...current, awmSoftNavigation: true }
      : { awmSoftNavigation: true };
    if (mode === 'push') history.pushState(state, '', url.href);
    if (mode === 'replace') history.replaceState(state, '', url.href);
  }

  function requestBody(form, submitter) {
    let data;
    let includedSubmitter = false;
    try {
      if (submitter) {
        data = new FormData(form, submitter);
        includedSubmitter = Boolean(submitter.name);
      } else {
        data = new FormData(form);
      }
    } catch {
      data = new FormData(form);
    }
    const entries = Array.from(data.entries(), ([key, value]) => [
      key,
      typeof value === 'string' ? value : value.name || '',
    ]);
    if (submitter?.name && !includedSubmitter) entries.push([submitter.name, submitter.value || '']);
    return entries;
  }

  function formUrl(form, entries) {
    const url = sameOriginUrl(form.action || window.location.href, window.location.href);
    if (!url) return null;
    for (const [key, value] of entries) url.searchParams.append(key, value);
    return url;
  }

  function formBody(entries) {
    const body = new URLSearchParams();
    for (const [key, value] of entries) body.append(key, value);
    return body.toString();
  }

  function pendingButton(form, submitter) {
    const button = submitter || form.querySelector('button[type="submit"], input[type="submit"]');
    const pendingLabel = button?.dataset?.awmPendingLabel;
    if (!button || !pendingLabel) return () => undefined;
    const state = {
      disabled: button.disabled,
      isInput: button.tagName === 'INPUT',
      value: button.value,
      text: button.textContent,
      children: Array.from(button.childNodes || [], (child) => child.cloneNode(true)),
    };
    button.disabled = true;
    if (state.isInput) button.value = pendingLabel;
    else button.textContent = pendingLabel;
    return () => {
      button.disabled = state.disabled;
      if (state.isInput) button.value = state.value;
      else {
        button.replaceChildren(...state.children);
        if (state.children.length === 0) button.textContent = state.text;
      }
    };
  }

  async function runGet(url, target, options) {
    if (pendingMutationTargets.has(target)) {
      announce('An update is already in progress for this section.');
      return;
    }
    const region = findRegion(document, target);
    if (!region) {
      window.location.assign(url.href);
      return;
    }

    const previous = getRequests.get(target);
    previous?.controller?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const request = { sequence: ++getSequence, controller };
    getRequests.set(target, request);
    setBusy(region, true);
    announce('Updating this section.');
    try {
      const response = await fetch(url.href, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (getRequests.get(target) !== request || controller?.signal.aborted) return;
      const finalUrl = finalSameOriginUrl(response, url);
      if (!finalUrl) throw new Error('cross_origin_response');
      if (isLoginResponse(response, finalUrl)) {
        window.location.assign(finalUrl.href);
        return;
      }
      const parsed = parsedHtml(response, await response.text());
      if (getRequests.get(target) !== request || controller?.signal.aborted) return;
      if (!response.ok || !parsed) {
        window.location.assign(url.href);
        return;
      }
      const replacement = replaceRegion(target, parsed);
      if (!replacement) {
        window.location.assign(finalUrl.href);
        return;
      }
      setHistory(finalUrl, options.historyMode);
      announce(announcementFor(replacement, options.successMessage || 'View updated.'));
    } catch (error) {
      if (getRequests.get(target) !== request || controller?.signal.aborted) return;
      showFailure(region, 'This section could not be updated. Check your connection and try again.', url.href, 'Try again');
      announce('This section could not be updated.');
    } finally {
      if (getRequests.get(target) === request) {
        getRequests.delete(target);
        if (findRegion(document, target) === region) setBusy(region, false);
      }
    }
  }

  async function fetchMutation(url, options) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error('mutation_timeout')), 45_000);
    });
    try {
      return await Promise.race([fetch(url.href, options), timeout]);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function runMutation(form, submitter, url, target, entries) {
    if (pendingForms.has(form) || pendingMutationTargets.has(target)) {
      announce('An update is already in progress for this section.');
      return;
    }
    const region = findRegion(document, target);
    if (!region) return;

    getRequests.get(target)?.controller?.abort();
    getRequests.delete(target);
    pendingForms.add(form);
    pendingMutationTargets.add(target);
    setBusy(region, true);
    const restoreButton = pendingButton(form, submitter);
    const uncertainMessage = form.dataset.awmUncertainMessage ||
      'We could not confirm the result of this request. Refresh the current status before trying again.';
    announce(submitter?.dataset?.awmPendingLabel || 'Saving changes.');
    try {
      const response = await fetchMutation(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'text/html',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: formBody(entries),
      });
      const finalUrl = finalSameOriginUrl(response, url);
      if (!finalUrl) throw new Error('cross_origin_response');
      if (isLoginResponse(response, finalUrl)) {
        window.location.assign(finalUrl.href);
        return;
      }
      const parsed = parsedHtml(response, await response.text());
      if (!response.ok || !parsed) {
        showFailure(region, uncertainMessage, window.location.href, 'Refresh status');
        announce(uncertainMessage);
        return;
      }
      const replacement = replaceRegion(target, parsed);
      if (!replacement) {
        window.location.assign(finalUrl.href);
        return;
      }
      setHistory(finalUrl, 'replace');
      announce(announcementFor(replacement, 'Update complete.'));
    } catch {
      showFailure(region, uncertainMessage, window.location.href, 'Refresh status');
      announce(uncertainMessage);
    } finally {
      pendingForms.delete(form);
      pendingMutationTargets.delete(target);
      if (findRegion(document, target) === region) {
        setBusy(region, false);
        restoreButton();
      }
    }
  }

  function onSubmit(event) {
    const form = event.target;
    const mode = form?.dataset?.awmEnhance;
    if (mode !== 'navigation' && mode !== 'mutation') return;
    const method = String(form.method || 'get').toUpperCase();
    if ((mode === 'navigation' && method !== 'GET') || (mode === 'mutation' && method !== 'POST')) return;
    const target = form.dataset.awmTarget;
    if (!validTarget(target) || !findRegion(document, target)) return;
    if (pendingForms.has(form) || (mode === 'mutation' && pendingMutationTargets.has(target))) {
      event.preventDefault();
      announce('An update is already in progress for this section.');
      return;
    }
    if (mode === 'navigation' && pendingMutationTargets.has(target)) return;
    if (mode === 'mutation' && form.enctype && form.enctype !== 'application/x-www-form-urlencoded') return;

    let entries;
    try {
      entries = requestBody(form, event.submitter);
    } catch {
      return;
    }
    const url = mode === 'navigation' ? formUrl(form, entries) : sameOriginUrl(form.action || window.location.href);
    if (!url) return;

    event.preventDefault();
    if (mode === 'navigation') {
      void runGet(url, target, { historyMode: 'push', successMessage: 'View updated.' });
    } else {
      void runMutation(form, event.submitter, url, target, entries);
    }
  }

  function onClick(event) {
    const refreshLink = event.target?.closest?.('[data-awm-soft-nav]');
    if (refreshLink) {
      if (event.defaultPrevented || (typeof event.button === 'number' && event.button !== 0) ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        (refreshLink.target && refreshLink.target !== '_self') || refreshLink.hasAttribute('download')) return;
      const target = refreshLink.dataset.awmTarget;
      const url = sameOriginUrl(refreshLink.href, window.location.href);
      if (!validTarget(target) || !url || !findRegion(document, target) || pendingMutationTargets.has(target)) return;
      event.preventDefault();
      void runGet(url, target, { historyMode: 'push', successMessage: 'View updated.' });
      return;
    }
  }

  async function restorePageFromHistory() {
    const target = 'app-content';
    const region = findRegion(document, target);
    const url = sameOriginUrl(window.location.href, window.location.href);
    if (!region || !url || typeof fetch !== 'function' || typeof DOMParser !== 'function') {
      window.location.reload();
      return;
    }
    const previous = getRequests.get(target);
    previous?.controller?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const request = { sequence: ++getSequence, controller };
    getRequests.set(target, request);
    setBusy(region, true);
    try {
      const response = await fetch(url.href, {
        method: 'GET', credentials: 'same-origin', headers: { Accept: 'text/html' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (getRequests.get(target) !== request || controller?.signal.aborted) return;
      const finalUrl = finalSameOriginUrl(response, url);
      if (!finalUrl || isLoginResponse(response, finalUrl)) {
        window.location.assign(finalUrl?.href || '/login');
        return;
      }
      const parsed = parsedHtml(response, await response.text());
      if (!response.ok || !parsed || !replaceRegion(target, parsed)) {
        window.location.reload();
      }
    } catch {
      if (getRequests.get(target) === request && !controller?.signal.aborted) window.location.reload();
    } finally {
      if (getRequests.get(target) === request) {
        getRequests.delete(target);
        if (findRegion(document, target) === region) setBusy(region, false);
      }
    }
  }

  if (typeof document.addEventListener !== 'function') return;
  document.addEventListener('submit', onSubmit);
  document.addEventListener('click', onClick);
  window.addEventListener?.('popstate', () => { void restorePageFromHistory(); });
})();`;
