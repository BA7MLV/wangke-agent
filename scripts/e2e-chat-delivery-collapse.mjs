import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.locator('textarea').waitFor();
  await page.waitForFunction(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    return useCourseChat.getState().loaded;
  });
  const setState = (state) => page.evaluate(async (next) => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    useCourseChat.setState(next);
  }, state);
  const longText = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行：这是一条需要折叠的长消息，展开后应保留全部内容。`).join('\n');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await setState({ loading: false, pendingAsk: null, pendingPlan: null, draft: '', messages: [
      { key: `long-${width}`, role: 'user', content: longText },
      { key: `answer-${width}`, role: 'ai', content: '测试回复' },
    ] });
    await page.getByTestId('chat-user-expand').waitFor();
    const text = page.locator('.course-chat__user-text');
    const toggle = page.getByTestId('chat-user-expand');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    const collapsed = (await text.boundingBox()).height;
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert((await text.boundingBox()).height > collapsed * 2);
    assert.equal(await text.textContent(), longText);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByTestId('chat-delivery-bar').count(), 0);
    assert.equal(await page.getByTestId('chat-voice').count(), 1);
    await setState({ loading: true });
    await page.getByTestId('chat-stop').waitFor();
    assert.equal(await page.getByTestId('chat-delivery-bar').count(), 0);
    assert.equal(await page.getByTestId('chat-voice').count(), 0);
    assert.equal(await page.getByTestId('chat-send').count(), 0);
    await page.locator('textarea').fill('   ');
    assert.equal(await page.getByTestId('chat-delivery-bar').count(), 0);
    assert.equal(await page.getByTestId('chat-stop').count(), 1);
    await page.locator('textarea').fill('补充一个问题');
    await page.getByTestId('chat-send').waitFor();
    await page.getByTestId('chat-delivery-bar').waitFor();
    assert.equal(await page.getByTestId('chat-stop').count(), 0);
    assert.equal(await page.getByTestId('chat-send').isEnabled(), true);
    await page.getByTestId('chat-send-mode-steer').click();
    assert.equal(await page.getByTestId('chat-delivery-bar').getAttribute('data-mode'), 'steer');
    assert.match(await page.locator('.course-chat__send-hint').textContent(), /停止当前回复/);
    const selected = page.getByTestId('chat-send-mode-steer');
    assert.equal(await selected.getAttribute('aria-checked'), 'true');
    const nav = page.locator('[data-testid="nav-rail-open"], [data-testid="nav-rail-toggle"]');
    const styles = await nav.evaluate((el) => {
      const css = getComputedStyle(el);
      return { border: css.borderTopWidth, radius: css.borderRadius, width: css.width };
    });
    assert.equal(styles.border, '1px');
    assert.equal(styles.width, '44px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `e2e-shots/chat-delivery-collapse-${width}.png` });
    await page.locator('textarea').fill('');
    await page.getByTestId('chat-stop').waitFor();
    assert.equal(await page.getByTestId('chat-delivery-bar').count(), 0);
    assert.equal(await page.getByTestId('chat-send').count(), 0);
    await page.locator('textarea').fill('继续补充');
    for (const field of ['pendingAsk', 'pendingPlan']) {
      await setState({ [field]: { messageKey: 'waiting' } });
      await page.getByTestId('chat-delivery-bar').waitFor({ state: 'detached' });
      await setState({ [field]: null });
    }
    await setState({ loading: false, sendMode: 'queue', draft: '' });
    await page.getByTestId('chat-delivery-bar').waitFor({ state: 'detached' });
    await setState({ messages: [{ key: `short-${width}`, role: 'user', content: '简短问题' }] });
    await page.getByTestId('chat-user-expand').waitFor({ state: 'detached' });
    console.log(`PASS delivery visibility, voice, sidebar border and message collapse at ${width}px`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
