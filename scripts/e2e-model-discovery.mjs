import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = process.env.BASE_URL ?? 'http://localhost:5173';
let calls = 0;
let mode = 'success';
let release;
const updateKey = (key) => page.evaluate(async (apiKey) => {
  const { useSettings } = await import('/src/store/settings.ts');
  const s = useSettings.getState();
  s.update({ providers: s.providers.map((p) => ({ ...p, apiKey })) });
}, key);
try {
  await page.route('https://models.dev/**', (route) => route.fulfill({ json: {} }));
  await page.route('https://discovery.test/**', async (route) => {
    calls++;
    const auth = route.request().headers().authorization;
    if (mode === 'hold') await new Promise((resolve) => { release = resolve; });
    try {
      if (mode === 'fail') await route.fulfill({ status: 401, json: { error: { message: 'invalid key' } } });
      else await route.fulfill({ json: { data: [{ id: auth === 'Bearer key-b' ? 'model-b' : 'model-a' }] } });
    } catch { /* A cancelled browser request may already have been disposed. */ }
  });
  await page.goto(`${base}/#/settings`);
  await page.getByTestId('card-api').waitFor();
  await page.evaluate(async () => {
    const { useSettings } = await import('/src/store/settings.ts');
    const s = useSettings.getState();
    s.update({ providers: [{ ...s.providers[0], baseUrl: 'https://discovery.test/v1', apiKey: 'key-a', catalogId: '' }] });
  });
  assert.equal(calls, 0, 'overview does not fetch closed providers');
  await page.getByTestId('provider-summary-sf').click();
  const note = page.getByTestId('provider-note-sf');
  await note.filter({ hasText: '1 个可用模型' }).waitFor();
  assert.equal(calls, 1);
  await page.getByTestId('provider-back').click();
  await page.getByTestId('provider-summary-sf').click();
  await note.waitFor();
  assert.equal(calls, 1, 'fresh cache avoids a second request');

  mode = 'fail';
  await page.getByTestId('btn-check-models').click();
  await note.filter({ hasText: '拉取失败' }).waitFor();
  assert.equal(calls, 2, '401 is not retried');
  const count = await page.getByTestId('provider-summary-sf').innerText();
  assert.match(count, /1\s*个模型/, 'failed refresh keeps the previous list');

  mode = 'hold';
  const pendingRequest = page.waitForRequest((request) => request.url().includes('discovery.test') && request.headers().authorization === 'Bearer key-b');
  await updateKey('key-b');
  await pendingRequest;
  await page.waitForFunction(() => document.querySelector('[data-testid="btn-check-models"]')?.disabled);
  assert.equal(await note.count(), 0, 'new credential does not inherit old result/error');
  await page.getByTestId('provider-back').click();
  mode = 'success';
  release?.();
  await page.getByTestId('provider-summary-sf').click();
  await note.filter({ hasText: '1 个可用模型' }).waitFor();
  assert.equal(await page.getByTestId('btn-check-models').isEnabled(), true, 'cancellation does not leave loading stuck');
  const cache = await page.evaluate(() => localStorage.getItem('wangke-model-list'));
  assert.ok(!cache.includes('key-a') && !cache.includes('key-b'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('PASS: automatic fetch, fresh cache, forced refresh, failed-refresh fallback, credential isolation, cancellation, loading recovery, mobile width');
} finally {
  release?.();
  await browser.close();
}
