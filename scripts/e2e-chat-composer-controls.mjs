import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://localhost:5190');
  const input = page.locator('textarea[aria-label="给 AI 助手发送消息"]');
  const model = page.getByTestId('model-picker');
  const send = page.getByTestId('chat-send');
  const skill = page.getByTestId('skill-picker');
  await input.waitFor();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await input.fill('');
    await model.waitFor();
    const before = { send: await send.boundingBox(), skill: await skill.boundingBox() };
    await input.fill('输入文字后，技能和发送不移动');
    assert.equal(await model.count(), 0);
    assert.equal(await page.getByTestId('chat-context-usage').count(), 0);
    for (const [name, locator] of [['send', send], ['skill', skill]]) {
      const after = await locator.boundingBox();
      assert.equal(after.x, before[name].x, `${name} stays fixed horizontally at ${width}px`);
      assert.equal(after.y, before[name].y, `${name} stays fixed vertically at ${width}px`);
    }
    await page.getByTestId('chat-new-session').click();
    await page.getByRole('alert').filter({ hasText: '已在新会话' }).first().waitFor();
    assert.equal(await input.inputValue(), '输入文字后，技能和发送不移动');
    // Simulate streaming UI state only; never start a real model request.
    await page.evaluate(async () => {
      const { useCourseChat } = await import('/src/store/courseChat.ts');
      useCourseChat.setState({ loading: true });
    });
    for (const id of ['chat-send-mode-queue', 'chat-send-mode-steer']) {
      const control = page.getByTestId(id);
      await control.waitFor();
      assert.equal(await control.evaluate((el) => !!el.closest('.course-chat__composer')), false);
      assert.equal(await control.evaluate((el) => !!el.closest('.course-chat__delivery-bar')), true);
      const bounds = await control.boundingBox();
      const composer = await page.locator('.course-chat__composer').boundingBox();
      assert(bounds.y + bounds.height <= composer.y, 'Delivery controls sit above the input card');
    }
    await page.getByTestId('chat-send-mode-steer').click();
    await page.getByRole('status').filter({ hasText: '发送后立即打断' }).waitFor();
    assert.equal(await page.locator('.course-chat__send-hint').evaluate((el) => !!el.closest('.course-chat__composer')), false);
    assert.equal((await send.boundingBox()).x, before.send.x);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(async () => {
      const { useCourseChat } = await import('/src/store/courseChat.ts');
      useCourseChat.setState({ loading: false, sendMode: 'queue' });
    });
    console.log(`PASS composer controls and new-session feedback at ${width}px`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
