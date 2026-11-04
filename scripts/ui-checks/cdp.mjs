// Shared Chrome DevTools Protocol helpers for the local UI browser checks.
// Developer tooling only: drives a local headless Chromium against the synthetic demo server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEMO_USERNAME = 'demo';
export const DEMO_PASSWORD = 'demo-password';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromeCandidates() {
  return [
    process.env.CHROME_BIN,
    path.join(
      os.homedir(),
      '.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell',
    ),
    path.join(
      os.homedir(),
      '.local/share/ai-jail/cache/xdg/ms-playwright/chromium-1248/chrome-linux64/chrome',
    ),
    '/opt/google/chrome/chrome',
  ].filter(Boolean);
}

export function findChrome() {
  const bin = chromeCandidates().find((candidate) => fs.existsSync(candidate));
  if (!bin) {
    console.error(
      'No Chromium/Chrome binary found. Install one and set CHROME_BIN=/path/to/chrome.',
    );
    process.exit(2);
  }
  return bin;
}

/** Launches headless Chromium and returns a small CDP client bound to its first page. */
export async function launch() {
  const bin = findChrome();
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(process.env.AWM_SHOOT_TMP ?? os.tmpdir(), 'shoot-'));
  const chrome = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.find((t) => t.type === 'page')) break;
    } catch {
      // Chromium is still starting; retry.
    }
    await sleep(200);
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) {
    chrome.kill();
    console.error('Chromium started but exposed no debuggable page.');
    process.exit(2);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));

  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    } else if (msg.method) {
      for (const w of [...waiters]) {
        if (w.method === msg.method) {
          waiters.splice(waiters.indexOf(w), 1);
          w.res(msg.params);
        }
      }
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const once = (method) => new Promise((res) => waiters.push({ method, res }));
  const evalJs = async (expr) =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
      .result.value;
  async function goto(url) {
    const loaded = once('Page.loadEventFired');
    await send('Page.navigate', { url });
    await Promise.race([loaded, sleep(15000)]);
    await sleep(500);
  }
  async function viewport(width, height) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
  }
  async function close() {
    ws.close();
    chrome.kill();
    // Remove the profile only after Chromium has exited, so it is not still writing to it.
    await exited;
    fs.rmSync(profile, { recursive: true, force: true });
  }

  await send('Page.enable');
  await send('Runtime.enable');
  return { send, once, evalJs, goto, viewport, close };
}

/** Signs in through the real login form with the synthetic demo credentials. */
export async function login(browser, baseUrl) {
  const { send, evalJs, goto, once, viewport, close } = browser;
  await viewport(1280, 800);
  await goto(`${baseUrl}/login`);
  // Credentials travel as CDP call arguments, never as text compiled into the page script.
  const { result: windowRef } = await send('Runtime.evaluate', { expression: 'window' });
  const { result: fill } = await send('Runtime.callFunctionOn', {
    objectId: windowRef.objectId,
    functionDeclaration: `function (user, pass) {
      const u = document.querySelector('input[name=username]');
      const p = document.querySelector('input[name=password]');
      if (!u || !p) return false;
      u.value = user;
      p.value = pass;
      return true;
    }`,
    arguments: [{ value: DEMO_USERNAME }, { value: DEMO_PASSWORD }],
    returnByValue: true,
  });
  if (!fill.value) {
    console.error('login form not found');
    await close();
    process.exit(1);
  }
  const nav = once('Page.loadEventFired');
  await evalJs(`document.querySelector('input[name=password]').form.requestSubmit()`);
  await Promise.race([nav, sleep(10000)]);
  await sleep(800);
  if ((await evalJs('location.pathname')) === '/login') {
    console.error('login failed');
    await close();
    process.exit(1);
  }
}
