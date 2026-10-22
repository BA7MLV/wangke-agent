import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const base = process.env.BASE_URL || 'http://localhost:5173';
const byId = (id) => page.getByTestId(id);
try {
  await page.goto(`${base}/#/library`);
  await page.locator('input[type=file]').setInputFiles({ name: '工具栏测试.md', mimeType: 'text/markdown', buffer: Buffer.from('# 批注测试\n\n拖选文字进行高亮，工具栏默认收起。') });
  const item = page.locator('[data-testid="video-item"]').filter({ hasText: '工具栏测试' });
  await item.waitFor();
  const id = await item.getAttribute('data-video-id');
  await page.goto(`${base}/#/player/${id}`);
  await byId('ink-toggle').waitFor();
  assert.equal(await byId('ink-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await byId('ink-pen').isVisible(), false);
  await byId('ink-toggle').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ink-pen"]')?.disabled === false);
  for (const tool of ['pen', 'highlight', 'erase', 'text-highlight']) {
    await byId(`ink-${tool}`).click();
    const cursor = await page.locator('.ink-layer[data-active]').first().evaluate((el) => getComputedStyle(el).cursor);
    if (tool === 'text-highlight') assert.equal(cursor, 'text');
    else assert.ok(cursor.startsWith('url('), `${tool} 使用独立工具光标`);
  }
  await byId('ink-toggle').click();
  assert.equal(await byId('ink-text-highlight').isVisible(), false);
  assert.equal(await byId('ink-smart').getAttribute('aria-checked'), 'true', '收起后恢复智能批注，不残留隐藏工具');
  await byId('ink-toggle').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await byId('ink-pen').isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '窄屏无横向溢出');
  await page.reload();
  await byId('ink-toggle').waitFor();
  assert.equal(await byId('ink-toggle').getAttribute('aria-expanded'), 'false', '刷新默认收起');
  console.log('✓ 工具栏默认收起、展开/收起、各工具光标、窄屏和刷新通过');
} finally {
  await browser.close();
}
