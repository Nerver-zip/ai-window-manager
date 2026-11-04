// Full-page screenshots plus horizontal-overflow summary against the synthetic demo server.
// usage: node scripts/ui-checks/shoot.mjs <baseUrl> <outDir> [label]
// env: SHOOT_ONLY=overview,usage  SHOOT_SIZES=390x844,1280x800  SHOOT_VIEWPORT=1
import fs from 'node:fs';
import path from 'node:path';
import { launch, login, sleep } from './cdp.mjs';

const [baseUrl, outDir, label = ''] = process.argv.slice(2);
if (!baseUrl || !outDir) {
  console.error('usage: node scripts/ui-checks/shoot.mjs <baseUrl> <outDir> [label]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const browser = await launch();
const { send, evalJs, goto, viewport } = browser;
await login(browser, baseUrl);

const pages = [
  ['overview', '/'],
  ['overview-antigravity', '/?provider=antigravity'],
  ['overview-claude', '/?provider=claude_code'],
  ['overview-codex', '/?provider=codex'],
  ['usage', '/usage'],
  ['schedule', '/schedule'],
  ['schedule-antigravity', '/schedule?providerId=antigravity'],
  ['logs', '/logs'],
  ['settings', '/settings'],
];
const sizes = process.env.SHOOT_SIZES
  ? process.env.SHOOT_SIZES.split(',').map((x) => x.split('x').map(Number))
  : [
      [1440, 900],
      [1280, 800],
      [390, 844],
      [360, 800],
    ];
const ONLY = process.env.SHOOT_ONLY ? process.env.SHOOT_ONLY.split(',') : null;
const rows = [];
async function shoot(name, url, w, h) {
  await viewport(w, h);
  await goto(baseUrl + url);
  const m = await evalJs(
    `({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), title: document.title })`,
  );
  const hgt = process.env.SHOOT_VIEWPORT ? h : Math.min(m.h, 16000);
  await viewport(w, hgt);
  await sleep(200);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const file = `${label ? label + '-' : ''}${name}-${w}x${h}.png`;
  fs.writeFileSync(path.join(outDir, file), Buffer.from(shot.data, 'base64'));
  const overflow = m.sw > m.cw;
  rows.push({ name, w, overflow, sw: m.sw, cw: m.cw, h: m.h });
  console.log(
    `${file} h=${m.h} scrollW=${m.sw} clientW=${m.cw} overflow=${overflow ? 'YES' : 'no'}`,
  );
}
for (const [name, url] of pages) {
  if (ONLY && !ONLY.includes(name)) continue;
  for (const [w, h] of sizes) await shoot(name, url, w, h);
}

// logged-out login page
await send('Network.enable');
await send('Network.clearBrowserCookies');
if (!ONLY || ONLY.includes('login'))
  for (const [w, h] of sizes) await shoot('login', '/login', w, h);

console.log('\nOVERFLOW SUMMARY');
const over = rows.filter((r) => r.overflow);
console.log(
  over.length
    ? over.map((r) => `${r.name}@${r.w}: scrollWidth ${r.sw} > clientWidth ${r.cw}`).join('\n')
    : 'none',
);
browser.close();
process.exit(0);
