// Chromium + WebKit: ordinary mouse movement, without HTML drag/dataTransfer.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  try {
    await page.goto(`${process.env.BASE_URL ?? 'http://localhost:5173'}/#/library`);
    await page.getByTestId('btn-new-folder').waitFor();
    await page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts');
      await db.folders.bulkAdd([
        { id: 1, name: 'A 文件夹', createdAt: 3 },
        { id: 2, name: 'B 文件夹', createdAt: 2 },
      ]);
    });
    await page.reload();
    for (const view of ['图标视图', '列表视图']) {
      await page.getByLabel(view, { exact: true }).click();
      const from = await page.locator('[data-group-key="1"] svg').boundingBox();
      const to = await page.locator('[data-group-key="2"]').boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 12 });
      await page.waitForFunction(() => document.querySelector('[data-group-key="2"] .finder-item__content')?.dataset.dropTarget === 'true');
      const target = page.locator('[data-group-key="2"] .finder-item__content');
      const color = await target.locator(view === '图标视图' ? '.finder-item__name' : ':scope').evaluate((el) => getComputedStyle(el).backgroundColor);
      assert.notEqual(color, 'rgba(0, 0, 0, 0)', 'drop highlight must be painted, not just a data attribute');
      await page.screenshot({ path: `.openchamber/folder-hover-${engine.name()}-${view}.png` });
      await page.mouse.up();
      await page.waitForFunction(async () => {
        const { db } = await import('/src/store/db.ts');
        return (await db.folders.get(1)).parentId === 2;
      });
      await page.locator('[data-group-key="1"]').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '撤销移动', exact: true }).click();
      await page.locator('[data-group-key="1"]').waitFor();
    }
    console.log(`PASS ${engine.name()}: folder SVG → folder edge, visible highlight, persisted nesting, undo; both layouts`);
  } finally { await browser.close(); }
}
