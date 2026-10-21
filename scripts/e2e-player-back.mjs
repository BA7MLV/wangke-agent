// Run against Vite: BASE_URL=http://localhost:5173 node scripts/e2e-player-back.mjs
// Isolated browser context: never changes the user's library.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.BASE_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${base}/#/library`);
  await page.getByTestId('btn-new-folder').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    await db.videos.bulkAdd([
      { id: 'back-material', name: '返回测试.md', kind: 'material', materialFormat: 'md', status: 'new', size: 0, duration: 0, createdAt: Date.now() },
      { id: 'back-video', name: '返回测试.mp4', status: 'new', size: 0, duration: 0, createdAt: Date.now() },
    ]);
  });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const id of ['back-material', 'back-video']) {
      // Enter from the homepage, not the library: back must use the parent route,
      // not browser history (which would return to the homepage).
      await page.goto(`${base}/#/`);
      await page.goto(`${base}/#/player/${id}`);
      await page.locator('.page-player .player-layout:not(.player-layout--loading)').waitFor();
      await page.getByRole('button', { name: '返回', exact: true }).click();
      await page.waitForURL('**/#/library');
      await page.getByTestId('btn-new-folder').waitFor();
      assert.equal(new URL(page.url()).hash, '#/library');
    }
  }
  await page.goto(`${base}/#/player/back-nonexistent`);
  await page.waitForURL('**/#/library');
  console.log('PASS: material/video back returns to library on desktop/mobile; missing resource redirects to library.');
} finally {
  await browser.close();
}
