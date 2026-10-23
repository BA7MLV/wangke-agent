import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1280, 768, 390, 320]) {
    const page = await browser.newPage({
      viewport: { width, height: 850 },
      hasTouch: width < 760,
      reducedMotion: width === 320 ? 'reduce' : 'no-preference',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/v1/cloud/status', (route) => route.fulfill({ json: { cloud: false } }));
    await page.route('https://models.dev/**', (route) => route.fulfill({ json: {} }));
    await page.goto(process.env.BASE_URL || 'http://localhost:5173');
    const input = page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true });
    await input.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.querySelector('textarea.course-chat__input')?.disabled);
    const empty = await input.boundingBox();
    assert(empty.height < 45, 'empty composer is one line');
    const add = await page.getByTestId('chat-add').boundingBox();
    assert(Math.abs(add.y - empty.y) < 8, 'plus and input share a row');
    assert(add.x + add.width <= empty.x, 'plus is before the input, not below it');
    await input.fill('短消息');
    assert.equal((await input.boundingBox()).height, empty.height, 'short messages stay on one line');
    assert(await page.getByTestId('composer-expand').isHidden());
    await input.fill('第一行\n第二行');
    assert((await input.boundingBox()).height > empty.height, 'multiline messages grow with their content');
    await input.fill('这是一段需要保留的长消息。\n'.repeat(30));
    const long = await input.boundingBox();
    assert(long.height > empty.height && long.height <= 180, 'draft grows to its cap');
    assert(long.width >= 70, 'narrow screens keep usable input space');
    await input.fill('这是一段需要保留的长消息。\n'.repeat(100));
    assert.equal((await input.boundingBox()).height, long.height, 'more text scrolls without growing past the cap');
    await page.getByTestId('composer-expand').click();
    const sheet = page.getByTestId('composer-sheet');
    await sheet.waitFor();
    await page.waitForFunction(() => {
      const content = document.querySelector('.composer-sheet__content');
      const backdrop = document.querySelector('.composer-sheet__backdrop');
      return content && backdrop && !content.hasAttribute('data-entering') &&
        backdrop.getAnimations({ subtree: true }).every((animation) => animation.playState !== 'running');
    });
    assert.equal(await sheet.getAttribute('data-placement'), 'bottom');
    assert(await sheet.evaluate((node) => node.classList.contains('drawer__dialog')), 'full editor uses Drawer, not Modal');
    const bounds = await sheet.boundingBox();
    assert(Math.abs(bounds.x) <= 1 && Math.abs(bounds.width - width) <= 1, 'sheet spans the bottom edge');
    assert(Math.abs(bounds.y + bounds.height - 850) <= 1, 'sheet is attached to the bottom, not floating');
    const editor = page.getByRole('textbox', { name: '完整消息', exact: true });
    assert.equal(await editor.inputValue(), await input.inputValue());
    assert(await editor.evaluate((node) => node.scrollHeight > node.clientHeight), 'long messages scroll inside the sheet');
    await page.setViewportSize({ width, height: 450 });
    await page.waitForFunction(() => {
      const footer = document.querySelector('.composer-sheet__footer')?.getBoundingClientRect();
      return footer && footer.bottom <= innerHeight;
    });
    const compactSheet = await sheet.boundingBox();
    assert(compactSheet.y >= 0 && compactSheet.y + compactSheet.height <= 451, 'sheet fits the reduced viewport');
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--vvh') === '450px');
    await editor.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    assert.equal(await input.inputValue(), '这是一段需要保留的长消息。\n'.repeat(100), 'Escape preserves the draft');
    await page.setViewportSize({ width, height: 850 });
    await page.getByTestId('composer-expand').click();
    await sheet.waitFor();
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
