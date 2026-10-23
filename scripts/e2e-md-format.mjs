import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { saveMaterialFile } = await import('/src/store/fileStore.ts');
    const id = 'e2e-md-format';
    const blob = new Blob(['讲义内容'], { type: 'text/markdown' });
    await db.videos.put({ id, name: '讲义.md', kind: 'material', materialFormat: 'md',
      size: blob.size, mimeType: blob.type, duration: 0, createdAt: Date.now(), status: 'new' });
    await saveMaterialFile(id, blob);
    location.hash = `/player/${id}`;
  });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.locator('[data-testid="md-editor"] .cm-content');
  await editor.waitFor();
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  assert.equal(await editor.textContent(), '**讲义内容**');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await editor.textContent(), '讲义内容');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  assert.equal(await editor.textContent(), '**讲义内容**');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).waitFor();
  const saved = await page.evaluate(async () => {
    const { getMaterialFile } = await import('/src/store/fileStore.ts');
    return (await getMaterialFile('e2e-md-format')).text();
  });
  assert.equal(saved, '**讲义内容**');
  await page.reload();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor.waitFor();
  assert.equal(await editor.textContent(), '**讲义内容**');
  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: innerWidth,
    bar: document.querySelector('[data-testid="md-format-bar"]').getBoundingClientRect().width,
  }));
  assert.ok(widths.page <= widths.viewport, JSON.stringify(widths));
  assert.ok(widths.bar <= widths.viewport, JSON.stringify(widths));
  assert.deepEqual(errors, []);
  console.log('✓ Markdown toolbar: selection, undo/redo, save, reload, mobile overflow');
} finally {
  await browser.close();
}
