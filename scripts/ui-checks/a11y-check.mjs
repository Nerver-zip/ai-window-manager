// Browser accessibility, progressive-enhancement and no-JS checks against the synthetic demo server.
// usage: node scripts/ui-checks/a11y-check.mjs <baseUrl>
import { launch, login, sleep } from './cdp.mjs';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('usage: node scripts/ui-checks/a11y-check.mjs <baseUrl>');
  process.exit(2);
}
const browser = await launch();
const { send, evalJs, goto, viewport } = browser;
await login(browser, baseUrl);

// ---------- browser a11y / progressive-enhancement / no-JS checks ----------
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const KEYS = {
  Tab: 9,
  Enter: 13,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Escape: 27,
  Space: 32,
};
async function key(k, mods = 0) {
  const base = {
    key: k === 'Space' ? ' ' : k,
    code: k === 'Space' ? 'Space' : k,
    windowsVirtualKeyCode: KEYS[k],
    modifiers: mods,
  };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (k === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
  if (k === 'Space') await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: ' ' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}
const ACTIVE = `(() => { const e = document.activeElement; if (!e || e === document.body) return null;
  const visual = e.matches('.provider-picker-input') ? e.nextElementSibling : e;
  const cs = getComputedStyle(visual); const csE = getComputedStyle(e);
  const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none' || (csE.outlineStyle !== 'none' && parseFloat(csE.outlineWidth) > 0) || csE.boxShadow !== 'none';
  const r = e.getBoundingClientRect();
  const svgPoint = e.matches('.chart-point-hit') ? getComputedStyle(e.querySelector('.chart-point-active')).opacity === '1' : false;
  return { svgPoint, sh: csE.boxShadow.slice(0,40), bc: csE.borderColor, tag: e.tagName.toLowerCase(), text: (e.getAttribute('aria-label') || e.textContent || e.name || '').trim().replace(/\\s+/g,' ').slice(0, 40), fv: e.matches(':focus-visible') || (e.tagName === 'INPUT' && e.type === 'time' && e.matches(':focus-within')), ring, cls: e.className && String(e.className).slice(0,40), visible: r.width > 0 && r.height > 0 }; })()`;

async function tabWalk(page, url, n = 45) {
  await goto(baseUrl + url);
  const seen = [];
  let missing = [];
  for (let i = 0; i < n; i++) {
    await key('Tab');
    await sleep(180);
    const a = await evalJs(ACTIVE);
    if (!a) continue;
    seen.push(a);
    if (a.visible && !(a.fv && (a.ring || a.svgPoint)))
      missing.push(`${a.tag}:"${a.text}" fv=${a.fv} ring=${a.ring} sh=${a.sh}`);
  }
  check(
    `${page}: first Tab lands on skip link`,
    seen[0]?.text === 'Skip to content',
    JSON.stringify(seen[0]),
  );
  check(
    `${page}: ${seen.length} tab stops all show a visible :focus-visible indicator`,
    missing.length === 0,
    missing.slice(0, 5).join(' | '),
  );
  return seen;
}

await viewport(1280, 800);
for (const [page, url] of [
  ['overview', '/?provider=codex'],
  ['usage', '/usage'],
  ['schedule', '/schedule'],
  ['logs', '/logs'],
  ['settings', '/settings'],
])
  await tabWalk(page, url);

// skip link activation
await goto(baseUrl + '/');
await key('Tab');
await key('Enter');
await sleep(200);
check('skip link moves focus to main', await evalJs(`document.activeElement?.id === 'main'`));

// aria-current on nav
check(
  'primary nav marks current page',
  await evalJs(
    `document.querySelectorAll('nav[aria-label="Primary navigation"] a[aria-current="page"]').length === 1`,
  ),
);

// provider picker keyboard + progressive region replacement (JS on)
await goto(baseUrl + '/?provider=antigravity');
await evalJs(`document.querySelector('.provider-picker-input:checked').focus()`);
const beforeHeading = await evalJs(
  `document.querySelector('.provider h2, main h2')?.textContent.trim()`,
);
await evalJs(`window.__awmMark = Math.random()`);
await key('ArrowRight');
await sleep(1500);
const afterState = await evalJs(
  `({ search: location.search, heading: document.querySelector('.provider h2, main h2')?.textContent.trim(), sameDocument: typeof window.__awmMark === 'number', focusInMain: !!document.activeElement?.closest('main'), status: document.querySelector('[data-awm-interaction-status]')?.textContent })`,
);
check(
  'picker: arrow key changes provider via enhanced partial update (no full reload, history updated)',
  afterState.sameDocument &&
    afterState.search.includes('provider=') &&
    afterState.heading !== beforeHeading,
  JSON.stringify({ beforeHeading, ...afterState }),
);
check('picker: focus stays inside main after region replacement', afterState.focusInMain);

// heatmap keyboard navigation
await goto(baseUrl + '/usage');
const hm = await evalJs(
  `(() => { const c = document.querySelector('[data-usage-cell][aria-selected="true"]') || document.querySelector('[data-usage-cell][tabindex="0"]'); if (!c) return null; c.focus(); return Number(c.dataset.usageIndex); })()`,
);
await key('ArrowLeft');
const hmL = await evalJs(`Number(document.activeElement?.dataset?.usageIndex)`);
await key('ArrowUp');
const hmU = await evalJs(`Number(document.activeElement?.dataset?.usageIndex)`);
check(
  'heatmap: ArrowLeft moves one week back, ArrowUp one day back',
  hm !== null && hmL === hm - 7 && hmU === hmL - 1,
  `start=${hm} left=${hmL} up=${hmU}`,
);
await key('Escape');
const hmE = await evalJs(`Number(document.activeElement?.dataset?.usageIndex)`);
check('heatmap: Escape returns focus to selected day', hmE === hm, `escape=${hmE}`);

// chart tooltip on keyboard focus
const tip = await evalJs(
  `(async () => { const p = document.querySelector('[data-chart-point]'); if (!p) return 'no-point'; p.focus(); await new Promise(r => setTimeout(r, 150)); const t = p.closest('[data-chart-root]').querySelector('[data-chart-tooltip]'); return t.getAttribute('data-visible') + '|' + t.getAttribute('aria-hidden') + '|' + t.textContent.trim().slice(0,40); })()`,
);
check('chart: focusing a point reveals its tooltip', tip.startsWith('true|false'), tip);

// chart ranges stay independent (enhanced navigation)
const ranges = await evalJs(
  `(async () => { const sels = [...document.querySelectorAll('[data-chart-range-select]')]; if (sels.length < 2) return 'need2'; const s = sels[0]; const opt = [...s.options].find(o => o.value.endsWith('|7d')); s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(r => setTimeout(r, 1800)); const now = [...document.querySelectorAll('[data-chart-range-select]')].map(x => x.value.split('|').pop()); return now.join(','); })()`,
);
check(
  'chart: changing one period leaves the others unchanged',
  /^7d,(?!7d)/.test(ranges) ||
    (ranges.split(',')[0] === '7d' &&
      ranges
        .split(',')
        .slice(1)
        .every((v) => v !== '7d')),
  ranges,
);

// schedule enhanced mutation (JS on): save keeps PRG + announcement
await goto(baseUrl + '/schedule?providerId=codex');
await evalJs(
  `window.__awmMark = 1; document.querySelector('[data-policy-form] button[type="submit"], [data-policy-form] button:not([type])').click()`,
);
await sleep(2500);
const save = await evalJs(
  `({ same: window.__awmMark === 1, status: document.querySelector('[data-awm-interaction-status]')?.textContent, notice: document.querySelector('[data-awm-region="schedule-workspace"] [role="status"], [data-awm-announcement]')?.textContent?.trim().slice(0,60), url: location.pathname + location.search })`,
);
check(
  'schedule: enhanced save follows PRG in place and announces outcome',
  save.same && /saved/i.test((save.status || '') + (save.notice || '')),
  JSON.stringify(save),
);

// strategy switch reveals only that strategy's fields (JS on)
const sw = await evalJs(
  `(async () => { const r = document.querySelector('[name="policyKind"][value="active_hours"]'); r.click(); await new Promise(r => setTimeout(r, 150)); const vis = [...document.querySelectorAll('[data-policy-fields]')].filter(f => !f.hidden).map(f => f.dataset.policyFields); return vis.join(','); })()`,
);
check('schedule: selecting a strategy reveals only its fields', sw === 'active_hours', sw);

// reduced motion
await goto(baseUrl + '/settings');
const motion = async () =>
  evalJs(
    `(() => { const o = document.querySelector('.online-indicator'); const a = document.querySelector('nav[aria-label="Primary navigation"] a'); return { anim: o ? getComputedStyle(o).animationName + '/' + getComputedStyle(o).animationDuration : 'none', trans: getComputedStyle(a).transitionDuration }; })()`,
  );
const normal = await motion();
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
await goto(baseUrl + '/settings');
const reduced = await motion();
const zero = (d) => d.split(',').every((x) => parseFloat(x) <= 0.00001);
check(
  'reduced motion: live-status pulse and transitions disabled',
  (reduced.anim.startsWith('none') || zero(reduced.anim.split('/')[1])) &&
    zero(reduced.trans) &&
    !normal.anim.startsWith('none'),
  `normal=${JSON.stringify(normal)} reduced=${JSON.stringify(reduced)}`,
);
await send('Emulation.setEmulatedMedia', { features: [] });

// ---------- JavaScript disabled ----------
await send('Emulation.setScriptExecutionDisabled', { value: true });
await goto(baseUrl + '/?provider=antigravity');
const nojs1 = await evalJs(
  `(() => { const btn = [...document.querySelectorAll('form button')].find(b => /Show provider/.test(b.textContent)); return !!btn && btn.getBoundingClientRect().height > 0; })()`,
);
check('no-JS overview: "Show provider" fallback button is visible', nojs1);
// evaluate is allowed even with page scripts disabled; use it only to act like a user (check radio + click native submit)
await evalJs(
  `(() => { const r = document.querySelector('.provider-picker-input[value="codex"]'); r.checked = true; [...document.querySelectorAll('form button')].find(b => /Show provider/.test(b.textContent)).click(); })()`,
);
await sleep(1500);
check(
  'no-JS overview: native GET form switches provider',
  await evalJs(
    `location.search.includes('provider=codex') && /Codex/.test(document.querySelector('main h2')?.textContent || '')`,
  ),
  await evalJs('location.search'),
);
await goto(baseUrl + '/logs');
await evalJs(
  `(() => { const s = document.querySelector('select[name="range"]'); s.value = s.options[s.options.length-1].value; [...document.querySelectorAll('form button')].find(b => /Apply filters/.test(b.textContent)).click(); })()`,
);
await sleep(1500);
check(
  'no-JS logs: "Apply filters" submits range natively',
  await evalJs(`location.search.includes('range=')`),
  await evalJs('location.search'),
);
await evalJs(`document.querySelector('a.log-tag-filter[href*="tag=trigger"]').click()`);
await sleep(1500);
check(
  'no-JS logs: category link combines with range',
  await evalJs(`location.search.includes('tag=trigger') && location.search.includes('range=')`),
  await evalJs('location.search'),
);
const nextHref = await evalJs(
  `document.querySelector('nav[aria-label="Log pages"] a[rel="next"]')?.href || null`,
);
if (nextHref) {
  await goto(nextHref);
  check(
    'no-JS logs: pagination next link works',
    await evalJs(`location.search.includes('page=2')`),
    await evalJs('location.search'),
  );
}
await goto(baseUrl + '/usage');
await evalJs(
  `(() => { const f = document.querySelector('.chart-range-form'); const sel = f.querySelector('select'); sel.value = [...sel.options].find(o => o.value.endsWith('|30d')).value; f.querySelector('button').click(); })()`,
);
await sleep(1500);
check(
  'no-JS usage: chart period "Apply" works',
  await evalJs(`decodeURIComponent(location.search).includes('|30d')`),
  await evalJs('location.search'),
);
await goto(baseUrl + '/schedule?providerId=codex');
await evalJs(
  `document.querySelector('[data-policy-form] button[type="submit"], [data-policy-form] button:not([type])').click()`,
);
await sleep(2000);
check(
  'no-JS schedule: native POST save redirects (PRG) with notice',
  await evalJs(
    `location.pathname === '/schedule' && /saved/i.test(document.querySelector('main').textContent)`,
  ),
  await evalJs('location.pathname + location.search'),
);
await goto(baseUrl + '/settings');
check(
  'no-JS settings: onboarding shows noscript notice',
  await evalJs(`/JavaScript is required to connect an account/.test(document.body.innerText)`),
);
await send('Emulation.setScriptExecutionDisabled', { value: false });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
