import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const [origin, remoteRoot] = process.argv.slice(2);
assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
assert.match(remoteRoot ?? '', /^\/home\/ubuntu\/\.local\/state\/wangke-separation-check\.[A-Za-z0-9]+$/);
const key = process.env.WANGKE_VPS_SSH_KEY;
assert.ok(key, 'explicit SSH identity path required');
const signal = file => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', key, 'ubuntu@139.199.227.35', `touch '${remoteRoot}/${file}'`], { stdio: 'pipe', timeout: 15000 });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
try {
  const page = await browser.newPage(); const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  const sw = await page.request.get(`${origin}/sw.js`);
  const hasServiceWorker = /(?:java|ecma)script/i.test(sw.headers()['content-type'] ?? '');
  if (hasServiceWorker) await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  assert.equal(await page.evaluate(async () => (await fetch('/assets/wk-old-proof.js')).status), 200);
  await page.evaluate(() => {
    window.acceptanceWorker = new Worker(URL.createObjectURL(new Blob([`onmessage=async()=>postMessage({status:(await fetch(${JSON.stringify(location.origin + '/assets/wk-old-proof.js')})).status})`], { type: 'text/javascript' })));
    window.askAcceptanceWorker = () => new Promise(resolve => { window.acceptanceWorker.onmessage = e => resolve(e.data.status); window.acceptanceWorker.postMessage('read'); });
  });
  assert.equal(await page.evaluate(() => window.askAcceptanceWorker()), 200);
  signal('browser-ready');
  await page.waitForFunction(async () => (await fetch('/assets/wk-new-proof.js', { cache: 'no-store' })).status === 200, undefined, { timeout: 90000, polling: 500 });
  assert.equal(await page.evaluate(() => window.askAcceptanceWorker()), 200, 'same already-running browser Worker can fetch retained old resources');
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/health')).status), 200);
  assert.deepEqual(failures, []);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.equal(await page.evaluate(async () => (await fetch('/config.js', { cache: 'no-store' })).status), 200);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('body').innerText());
  assert.deepEqual(failures, []);
  signal('browser-done');
  console.log(JSON.stringify({ oldPageAndLiveWorker: 'passed', serviceWorker: hasServiceWorker ? 'passed' : 'not present in current Web artifact; PWA lifecycle NOT certified', limitation: 'Same-source synthetic variant, NOT historical client-version or native-device certification' }));
} finally { await browser.close(); }
