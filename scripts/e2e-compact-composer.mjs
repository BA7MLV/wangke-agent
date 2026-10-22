import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.BASE_URL || 'http://localhost:5173');
    const input = page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true });
    await input.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.querySelector('textarea.course-chat__input')?.disabled);
    const empty = await input.boundingBox();
    assert(empty.height < 45, 'empty composer is one line');
    const add = await page.getByTestId('chat-add').boundingBox();
    assert(Math.abs(add.y - empty.y) < 8, 'plus and input share a row');
    await input.fill('这是一段需要保留的长消息。\n'.repeat(30));
    const long = await input.boundingBox();
    assert(long.height > empty.height && long.height <= 180, 'draft grows to its cap');
    assert(long.width >= 70, 'narrow screens keep usable input space');
    await page.getByTestId('composer-expand').click();
    const sheet = page.getByTestId('composer-sheet');
    await sheet.waitFor();
    const editor = page.getByRole('textbox', { name: '完整消息', exact: true });
    assert.equal(await editor.inputValue(), await input.inputValue());
    await editor.fill('缩短后的草稿');
    assert(await sheet.isVisible(), 'shortening the draft must not dismiss the sheet');
    await sheet.getByRole('button', { name: '完成', exact: true }).click();
    await sheet.waitFor({ state: 'hidden' });
    assert.equal(await input.inputValue(), '缩短后的草稿');
    await input.fill('');
    assert((await input.boundingBox()).height < 45);
    assert(await page.getByTestId('composer-expand').isHidden());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(`Compact composer ${width}px: single row, capped growth, sheet editing and collapse passed.`);
    await page.close();
  }
} finally {
  await browser.close();
}
