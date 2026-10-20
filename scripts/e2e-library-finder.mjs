// Run against Vite: BASE_URL=http://localhost:5173 node scripts/e2e-library-finder.mjs
// Uses an isolated browser context; never changes the user's library.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${base}/#/library`);
  await page.getByTestId('btn-new-folder').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const createdAt = Date.now();
    await db.folders.bulkAdd([
      { id: 1, name: '02_学习考试', createdAt },
      { id: 2, name: '03_论文与学校', createdAt },
      { id: 3, name: '04_设计素材', createdAt },
    ]);
    await db.videos.bulkAdd([
      { id: 'finder-exam', name: '社会工作综合能力复习资料.pdf', kind: 'material', materialFormat: 'pdf', unitCount: 24, folderId: 1, status: 'new', size: 102400, duration: 0, createdAt },
      { id: 'finder-paper', name: '四级翻译历年真题及译文.pdf', kind: 'material', materialFormat: 'pdf', unitCount: 12, status: 'new', size: 204800, duration: 0, createdAt },
      { id: 'finder-word', name: '2026年考试报名通知.docx', kind: 'material', materialFormat: 'docx', unitCount: 8, status: 'new', size: 88400, duration: 0, createdAt },
    ]);
  });
  await page.reload();
  const folder = page.locator('[data-group-key="1"]');
  await folder.click();
  assert.equal(await folder.getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.finder-title').innerText(), '全部资料', 'single click must select, not open');
  await folder.dblclick();
  assert.equal(await page.locator('.finder-title').innerText(), '02_学习考试');
  assert.equal(await page.getByTestId('video-item').count(), 1);
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await page.getByRole('button', { name: '前进', exact: true }).click();
  assert.equal(await page.locator('.finder-title').innerText(), '02_学习考试');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await folder.click();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.finder-title').innerText(), '02_学习考试', 'Enter opens selected folder');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await page.getByTestId('library-search').fill('论文');
  await page.locator('[data-group-key="2"]').dblclick();
  await page.getByText('文件夹还是空的', { exact: true }).waitFor();
  await page.getByRole('button', { name: '后退', exact: true }).click();

  // Right-click selects that item and exposes its operations at the pointer.
  await page.locator('[data-video-id="finder-paper"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByTestId('rename-input').locator('input').fill('四级历年真题.pdf');
  await page.getByTestId('rename-save').click();
  await page.getByRole('option').filter({ hasText: '四级历年真题.pdf' }).waitFor();

  // Real pointer drag moves an unfiled document into the folder.
  await page.locator('[data-video-id="finder-paper"] .finder-item__icon').dragTo(page.locator('[data-group-key="1"] .finder-item__icon'));
  await page.waitForFunction(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.videos.get('finder-paper')).folderId === 1;
  });
  await folder.dblclick();
  await page.locator('[data-video-id="finder-paper"]').waitFor();
  assert.equal(await page.getByTestId('video-item').count(), 2);

  // Native imports belong to the currently open folder.
  await page.getByTestId('import-input').setInputFiles({ name: '复习提纲.md', mimeType: 'text/markdown', buffer: Buffer.from('# 复习提纲\n\n考试知识点。') });
  await page.waitForFunction(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.videos.toArray()).some((video) => video.name === '复习提纲' && video.folderId === 1);
  });
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await mkdir('.openchamber', { recursive: true });
  await page.getByText(/已导入《复习提纲.md》/).waitFor({ state: 'hidden' });
  await page.mouse.move(1400, 900);
  await page.screenshot({ path: '.openchamber/finder-v2-desktop.png' });
  await page.getByLabel('列表视图', { exact: true }).click();
  assert.equal(await page.locator('.finder-items--list').count(), 1);
  await page.screenshot({ path: '.openchamber/finder-v2-list.png' });
  await page.getByLabel('图标视图', { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '.openchamber/finder-v2-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: selection, double-click, keyboard, history, search, context menu, rename, drag/move, import destination, view switch, mobile layout');
} catch (error) {
  console.error(await page.locator('.finder-window').innerText());
  await page.screenshot({ path: '.openchamber/finder-test-failure.png' });
  throw error;
} finally {
  await browser.close();
}
