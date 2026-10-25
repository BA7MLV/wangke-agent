import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const longText = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行：这是一条长消息，底部应渐进模糊，展开后恢复清晰。`).join('\n');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const surface of ['course', 'panel']) {
    for (const width of [320, 390, 768, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 }, hasTouch: width < 760,
        reducedMotion: width === 320 ? 'reduce' : 'no-preference',
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/api/v1/cloud/status', (route) => route.fulfill({ json: { cloud: false } }));
      await page.route('https://models.dev/**', (route) => route.fulfill({ json: {} }));
      await page.goto(base);
      await page.locator('textarea').waitFor();
      if (surface === 'course') {
        await page.waitForFunction(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().loaded);
        await page.evaluate(async (content) => {
          const { useCourseChat } = await import('/src/store/courseChat.ts');
          useCourseChat.setState({ messages: [{ key: 'expand-test', role: 'user', content }] });
        }, longText);
      } else {
        await page.evaluate(async (content) => {
          const { db } = await import('/src/store/db.ts');
          const videoId = 'expand-placement-test';
          await db.videos.put({ id: videoId, name: '展开位置测试', size: 1, mimeType: 'video/mp4', duration: 100, createdAt: Date.now(), status: 'transcribed' });
          await db.segments.add({ videoId, idx: 0, start: 0, end: 5, text: '测试字幕', status: 1 });
          const sessionId = await db.chatSessions.add({ videoId, title: '展开位置', createdAt: Date.now() });
          await db.chats.add({ videoId, sessionId, role: 'user', content, createdAt: Date.now() });
        }, longText);
        await page.goto(`${base}/#/player/expand-placement-test`);
        const tab = page.getByTestId('panel-tab-chat');
        await page.getByTestId('study-assistant-toggle').waitFor();
        if (!(await tab.isVisible())) await page.getByTestId('study-assistant-toggle').click();
        await tab.click();
      }

      const text = page.locator(surface === 'course' ? '.course-chat__user-text' : '.chat-user-text');
      const toggle = page.getByTestId('chat-user-expand');
      await toggle.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const textBox = await text.boundingBox();
      const toggleBox = await toggle.boundingBox();
      assert(Math.abs(toggleBox.x + toggleBox.width - textBox.x - textBox.width) < 2, 'message expand is right-aligned');
      const blur = await text.evaluate((node) => {
        const css = getComputedStyle(node, '::after');
        return { content: css.content, filter: css.backdropFilter, mask: css.maskImage, height: parseFloat(css.height), lineHeight: parseFloat(getComputedStyle(node).lineHeight) };
      });
      assert.equal(blur.content, '""');
      assert.equal(blur.filter, 'blur(4px)');
      assert.match(blur.mask, /linear-gradient/);
      assert(Math.abs(blur.height - blur.lineHeight * 3) < 1, 'only the final three preview lines are blurred');
      await toggle.click();
      assert.equal(await text.getAttribute('data-collapsed'), 'false');
      assert.equal(await text.evaluate((node) => getComputedStyle(node, '::after').content), 'none');
      assert.equal(await text.textContent(), longText);
      await toggle.click();

      const composer = page.locator(surface === 'course' ? '.course-chat__composer' : '.chat-composer__row');
      const input = composer.locator('textarea');
      await input.fill(`${longText}\n`.repeat(5));
      const expand = page.getByTestId('composer-expand');
      await expand.waitFor();
      const card = await composer.boundingBox();
      const icon = await expand.boundingBox();
      assert(Math.abs(icon.y - card.y - 9) < 2, 'composer expand is anchored to the top');
      assert(Math.abs(card.x + card.width - icon.x - icon.width - 13) < 2, 'composer expand is anchored to the right');
      const inputBox = await input.boundingBox();
      assert(icon.x >= inputBox.x + inputBox.width, 'expand does not cover the draft text');
      if (width === 390) await page.screenshot({ path: `e2e-shots/chat-expand-placement-${surface}.png` });
      await expand.click();
      await page.getByTestId('composer-sheet').waitFor();
      assert.equal(await page.getByRole('textbox', { name: '完整消息', exact: true }).inputValue(), await input.inputValue());
      await page.getByRole('button', { name: '收起输入框', exact: true }).click();
      await page.getByTestId('composer-sheet').waitFor({ state: 'hidden' });
      await input.fill('简短草稿');
      assert(await expand.isHidden());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${surface} ${width}px: top-right composer control, right-aligned message control, progressive blur and full editor`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
