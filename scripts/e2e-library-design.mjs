/* eslint-disable no-console */
// Search/filter hierarchy and keyboard behavior. Uses a fresh browser context
// with synthetic IndexedDB records; it never opens an existing browser profile.
// BASE_URL=http://127.0.0.1:5180 node scripts/e2e-library-design.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:4173';
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Only a local test server is supported');
const output = 'e2e-shots/library-design';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const card = (id) => page.locator(`[data-video-id="${id}"]`);
const countCards = async (expected) => {
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="video-item"]').length === count, expected);
};

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="empty-state"]').waitFor();
  assert.equal(await page.locator('[data-testid="btn-native-pick"]').getAttribute('variant'), 'filled');
  assert.match(await page.locator('[data-testid="btn-native-pick"]').innerText(), /导入文件/);

  const now = Date.now();
  await page.evaluate(async (createdAt) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('wangke');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const common = { size: 1024, mimeType: 'video/mp4', duration: 600, createdAt, status: 'transcribed', coverState: 'ready', fileDeleted: 1 };
    const rows = [
      { ...common, id: 'design-started', name: 'Linear Algebra · 线性代数', lastPosition: 240, folderId: 100 },
      { ...common, id: 'design-done', name: '已完成课程', lastPosition: 600, finished: 1 },
      { ...common, id: 'design-new', name: '尚未开始的课程' },
      { ...common, id: 'design-material', name: '线性代数阅读材料', kind: 'material', materialFormat: 'pdf', mimeType: 'application/pdf', duration: 0, unitCount: 24, lastUnit: 8, folderId: 100 },
    ];
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['videos', 'folders'], 'readwrite');
      transaction.objectStore('folders').put({ id: 100, name: '数学课程', createdAt });
      transaction.objectStore('folders').put({ id: 101, name: '空文件夹', createdAt: createdAt + 1 });
      for (const row of rows) transaction.objectStore('videos').put(row);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    localStorage.setItem('library.collapsedGroups', JSON.stringify(['100']));
  }, now);

  await page.reload({ waitUntil: 'networkidle' });
  const search = page.locator('[data-testid="library-search"]');
  await search.waitFor();
  await countCards(2);

  await search.fill('  linear  ');
  await countCards(1);
  assert.equal(await card('design-started').count(), 1);
  assert.equal(await page.locator('[data-group-key="101"]').count(), 0);
  assert.match(await page.locator('.library-results').innerText(), /1 项结果/);
  assert.equal(await page.evaluate(() => localStorage.getItem('library.collapsedGroups')), '["100"]');
  await search.press('Escape');
  await countCards(2);
  assert.equal(await page.locator('[data-group-key="100"] .group-header__toggle').getAttribute('aria-expanded'), 'false');

  await page.locator('[data-testid="library-filter-video"]').click();
  await countCards(3);
  await page.locator('[data-testid="library-filter-started"]').click();
  await countCards(1);
  assert.equal(await card('design-started').count(), 1);
  await page.locator('[data-testid="library-filter-material"]').click();
  await countCards(1);
  assert.equal(await card('design-material').count(), 1);
  assert.equal(await page.locator('[data-testid="library-filter-material"]').getAttribute('aria-pressed'), 'true');

  await search.fill('不会存在的合成课程名');
  await page.locator('[data-testid="library-no-results"]').waitFor();
  await page.locator('[data-testid="library-no-results"] mdui-button').click();
  await countCards(2);
  assert.equal(await search.inputValue(), '');
  assert.equal(await search.evaluate((element) => element === document.activeElement), true);
  assert.equal(await page.locator('[data-testid="library-filter-all"]').getAttribute('aria-pressed'), 'true');

  const groupHeader = page.locator('[data-group-key="100"]');
  const groupToggle = groupHeader.locator('.group-header__toggle');
  await groupToggle.focus();
  await page.keyboard.press('Space');
  await countCards(4);
  assert.equal(await groupToggle.getAttribute('aria-expanded'), 'true');
  await groupToggle.press('Enter');
  await countCards(2);
  await groupHeader.click();
  await countCards(4);
  await groupHeader.locator('[data-testid="btn-folder-more"]').click();
  assert.equal(await groupToggle.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');

  await card('design-started').locator('[data-testid="drag-handle"]').press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-testid="move-dialog"]')?.hasAttribute('open'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="move-dialog"]')?.hasAttribute('open'));
  const thumbnail = card('design-started').locator('[data-testid="video-thumb"]');
  assert.equal(await thumbnail.evaluate((element) => element.tagName), 'BUTTON');
  assert.equal(await thumbnail.evaluate((element) => element.tabIndex), 0);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.classList.remove('mdui-theme-auto', 'mdui-theme-light', 'mdui-theme-dark');
      document.documentElement.classList.add(`mdui-theme-${value}`);
    }, theme);
    for (const width of [320, 390, 820, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(() => {
        const selectors = ['.drop-zone', '.library-toolbar', '.library-search', '.library-filters', '.video-row'];
        return selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => {
          const rect = element.getBoundingClientRect();
          return { selector, left: rect.left, right: rect.right };
        }));
      });
      for (const rect of geometry) assert(rect.left >= -1 && rect.right <= width + 1, `${theme} ${width}px: ${rect.selector} overflows`);
      const ratio = await thumbnail.evaluate((element) => { const r = element.getBoundingClientRect(); return r.width / r.height; });
      assert(Math.abs(ratio - 16 / 9) < 0.02, `${width}px thumbnail keeps a 16:9 ratio`);
      await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
    }
  }

  await thumbnail.press('Enter');
  await page.waitForURL('**/#/player/design-started');
  assert.deepEqual(errors, [], 'No page errors');
  console.log('✓ Library search, filters, keyboard actions, and responsive geometry passed');
} finally {
  await context.close();
  await browser.close();
}
