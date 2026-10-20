// Isolated dev-server test: ordinary Markdown + shared read/grep/edit tools.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' });
  const created = await page.evaluate(async () => {
    const { createResourceExecutor } = await import('/src/harness/resources.ts');
    return createResourceExecutor()('edit', { path: '/wrongbook.md', create: true,
      content: '# 错题本\n\n## q-1\n\n一加一？\n\n答案：B\n\n## q-2\n\n二加二？\n\n答案：D\n' });
  });
  assert.match(created, /已创建/);
  await page.reload({ waitUntil: 'networkidle' });
  const item = page.locator('[data-testid="video-item"][data-video-id="wrongbook.md"]');
  await item.waitFor();
  assert.match(await item.innerText(), /wrongbook\.md/);
  assert.equal(await page.getByRole('button', { name: '错题本.md', exact: true }).count(), 0);
  await item.dblclick();
  await page.getByTestId('md-edit-toggle').waitFor();
  assert.equal(await page.getByRole('button', { name: '今日复习', exact: true }).count(), 0);
  const result = await page.evaluate(async () => {
    const { createResourceExecutor } = await import('/src/harness/resources.ts');
    const tool = createResourceExecutor();
    const hits = await tool('grep', { path: '/wrongbook.md', query: '^## q-', regex: true });
    const edited = await tool('edit', { path: '/wrongbook.md', edits: [
      { old_string: '## q-1[\\s\\S]*?(?=## q-2)', new_string: '', regex: true },
      { old_string: '二加二？', new_string: '工具修改后的题干' },
    ] });
    return { hits, edited, raw: await tool('read', { path: '/wrongbook.md' }) };
  });
  assert.match(result.hits, /q-1/);
  assert.match(result.edited, /2 处/);
  assert.doesNotMatch(result.raw, /q-1/);
  await page.getByTestId('material-reader').getByText('工具修改后的题干', { exact: true }).waitFor();
  await page.getByTestId('md-edit-toggle').click();
  await page.getByTestId('md-source-view').getByText('源码', { exact: true }).click();
  await page.locator('[data-testid="md-editor"] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('# 我的普通笔记\n\n不需要任何错题本标记。\n');
  await page.getByTestId('md-edit-toggle').click();
  await page.getByTestId('md-editor').waitFor({ state: 'detached' });
  await page.getByTestId('material-reader').getByText('不需要任何错题本标记。', { exact: true }).waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('material-reader').getByText('不需要任何错题本标记。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: /wrongbook.md ordinary library item, generic regex tools, live reader, unrestricted Markdown editor, reload and mobile');
} finally {
  await context.close();
  await browser.close();
}
