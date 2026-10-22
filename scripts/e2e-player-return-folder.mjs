// BASE_URL=http://localhost:5173 node scripts/e2e-player-return-folder.mjs
// Isolated context: does not modify the user's library.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const base = process.env.BASE_URL ?? 'http://localhost:5173';
try {
  await page.goto(`${base}/#/library`);
  await page.getByTestId('btn-new-folder').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const createdAt = Date.now();
    await db.folders.bulkAdd([
      { id: 1, name: '课程目录', createdAt },
      { id: 2, parentId: 1, name: '上次打开的目录', createdAt },
    ]);
    await db.videos.add({
      id: 'return-folder', name: '测试课程', folderId: 2,
      status: 'new', size: 0, duration: 0, createdAt,
    });
  });
  await page.reload();
  await page.locator('[data-group-key="1"]').dblclick();
  await page.locator('[data-group-key="2"]').dblclick();

  const assertFolder = async () => {
    await page.locator('[data-video-id="return-folder"]').waitFor();
    assert.equal(await page.locator('.finder-title').innerText(), '上次打开的目录');
    assert.equal(await page.locator('.finder-path-target').count(), 3);
  };
  await assertFolder();
  for (const method of ['button', 'browser', 'reload']) {
    await page.locator('[data-video-id="return-folder"]').dblclick();
    await page.waitForURL('**/#/player/return-folder');
    if (method === 'reload') await page.reload();
    if (method === 'browser') await page.goBack();
    else await page.getByRole('button', { name: '返回', exact: true }).click();
    await assertFolder();
  }
  // Folder back/forward history also survives leaving the library.
  await page.getByRole('button', { name: '后退', exact: true }).click();
  assert.equal(await page.locator('.finder-title').innerText(), '课程目录');
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await assertFolder();
  console.log('PASS: player back, browser back, reload, and folder history');
} finally {
  await browser.close();
}
