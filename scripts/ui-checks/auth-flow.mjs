// Synthetic Claude Code sign-in onboarding flow check. Start the demo server with AWM_DEMO_NO_AUTOSTART=1.
// usage: node scripts/ui-checks/auth-flow.mjs <baseUrl> <outDir> [label]
import fs from 'node:fs';
import path from 'node:path';
import { launch, login, sleep } from './cdp.mjs';

const [baseUrl, outDir, label = ''] = process.argv.slice(2);
if (!baseUrl || !outDir) {
  console.error('usage: node scripts/ui-checks/auth-flow.mjs <baseUrl> <outDir> [label]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const browser = await launch();
const { send, once, evalJs, goto, viewport } = browser;
await login(browser, baseUrl);

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const card = `document.querySelector('#provider-claude_code')`;
const state = () =>
  evalJs(`${card}?.querySelector('[data-auth-onboarding]')?.getAttribute('data-auth-state')`);
async function waitState(want, ms = 10000) {
  const t = Date.now();
  let s;
  while (Date.now() - t < ms) {
    s = await state();
    if (want.includes(s)) return s;
    await sleep(200);
  }
  return s;
}
async function snap(name) {
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: await evalJs(
      `(() => { const r = ${card}.getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y + scrollY - 8), width: r.width + 16, height: r.height + 16, scale: 1 }; })()`,
    ),
    captureBeyondViewport: true,
  });
  fs.writeFileSync(
    path.join(outDir, `${label}-auth-${name}.png`),
    Buffer.from(shot.data, 'base64'),
  );
}
await viewport(1440, 1200);
await send('Browser.grantPermissions', {
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  origin: baseUrl,
}).catch(() => {});

// 1. Overview offers the connect action for the disconnected provider; follow it like a user.
await goto(baseUrl + '/?provider=claude_code');
const cta = await evalJs(
  `(() => { const a = [...document.querySelectorAll('main a')].find(a => /settings\\?connect=claude_code/.test(a.getAttribute('href') || '')); return a ? a.textContent.trim() + ' -> ' + a.getAttribute('href') : null; })()`,
);
check('overview shows a connect/continue action linking to Settings onboarding', !!cta, cta);
const navDone = once('Page.loadEventFired');
await evalJs(
  `[...document.querySelectorAll('main a')].find(a => /settings\\?connect=claude_code/.test(a.getAttribute('href'))).click()`,
);
await Promise.race([navDone, sleep(8000)]);
await sleep(1200);
check(
  'settings focuses the connect target card',
  await evalJs(
    `location.pathname === '/settings' && ${card}?.getAttribute('data-connect-target') === 'true'`,
  ),
);
const locked = await evalJs(
  `({ conn: ${card}.getAttribute('data-provider-connected'), label: ${card}.querySelector('[data-provider-connection-label]')?.textContent.trim(), formHidden: ${card}.querySelector('[data-provider-settings-form]')?.hidden ?? null, note: !${card}.querySelector('[data-provider-monitoring-note]')?.hidden })`,
);
check(
  'before sign-in: settings form locked, monitoring note shown',
  locked.formHidden === true && locked.note === true,
  JSON.stringify(locked),
);
await snap('1-before');

// 2. Start, then cancel.
const s0 = await waitState(['IDLE', 'CANCELED', 'FAILED', 'TIMED_OUT', 'SUCCEEDED', ''], 6000);
await evalJs(`${card}.querySelector('[data-auth-start]').click()`);
check(
  'start → awaiting user action',
  (await waitState(['AWAITING_USER_ACTION'])) === 'AWAITING_USER_ACTION',
  `from=${s0}`,
);
await evalJs(`${card}.querySelector('[data-auth-cancel]').click()`);
check('cancel → canceled', (await waitState(['CANCELED'])) === 'CANCELED');

// 3. Start again and complete with the code.
await evalJs(`${card}.querySelector('[data-auth-start]').click()`);
await waitState(['AWAITING_USER_ACTION']);
await sleep(400);
const awaiting = await evalJs(
  `(() => { const c = ${card}; const vis = (s) => { const e = c.querySelector(s); return !!e && !e.closest('[hidden]') && e.getBoundingClientRect().height > 0; }; return { link: c.querySelector('a[data-auth-authorization]')?.getAttribute('href'), linkVisible: vis('a[data-auth-authorization]'), rel: c.querySelector('a[data-auth-authorization]')?.getAttribute('rel'), code: c.querySelector('output[data-auth-user-code]')?.textContent.trim(), codeVisible: vis('output[data-auth-user-code]'), input: vis('input[data-auth-code-input]'), copyCode: vis('[data-auth-copy-code]'), copyLink: vis('[data-auth-copy-url]') }; })()`,
);
check(
  'awaiting: official link, device code, copy buttons and code field visible',
  awaiting.linkVisible &&
    awaiting.codeVisible &&
    awaiting.code === 'ABCD-1234' &&
    awaiting.input &&
    awaiting.copyCode &&
    awaiting.copyLink &&
    /noopener/.test(awaiting.rel || ''),
  JSON.stringify(awaiting),
);
await snap('2-awaiting');
await evalJs(`${card}.querySelector('[data-auth-copy-code]').click()`);
await sleep(500);
const copied = await evalJs(
  `({ status: ${card}.querySelector('[data-auth-copy-status]')?.textContent.trim(), selection: String(getSelection()) })`,
);
check(
  'copy code gives feedback (clipboard or manual-select fallback)',
  !!copied.status || copied.selection === 'ABCD-1234',
  JSON.stringify(copied),
);
await evalJs(
  `(() => { const i = ${card}.querySelector('input[data-auth-code-input]'); i.focus(); i.value = 'SYNTH-CODE-42'; i.dispatchEvent(new Event('input', { bubbles: true })); ${card}.querySelector('[data-auth-submit]').click(); })()`,
);
check('submit code → succeeded', (await waitState(['SUCCEEDED'], 15000)) === 'SUCCEEDED');
await sleep(800);
const done = await evalJs(
  `({ conn: ${card}.getAttribute('data-provider-connected'), cstate: ${card}.querySelector('[data-provider-connection-status]')?.getAttribute('data-connection-state'), label: ${card}.querySelector('[data-provider-connection-label]')?.textContent.trim(), formHidden: ${card}.querySelector('[data-provider-settings-form]')?.hidden ?? null, noteHidden: ${card}.querySelector('[data-provider-monitoring-note]')?.hidden ?? null, codeCleared: !${card}.querySelector('output[data-auth-user-code]')?.textContent.trim() || !!${card}.querySelector('output[data-auth-user-code]')?.closest('[hidden]') })`,
);
check(
  'after sign-in: card shows Connected and unlocks the settings form',
  done.conn === 'true' &&
    done.cstate === 'connected' &&
    done.formHidden === false &&
    done.noteHidden === true,
  JSON.stringify(done),
);
check('after sign-in: device code no longer displayed', done.codeCleared);
await snap('3-succeeded');
console.log(`\n${results.filter(Boolean).length}/${results.length} auth-flow checks passed`);
browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
