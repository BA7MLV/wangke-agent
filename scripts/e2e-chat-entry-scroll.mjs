import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Vite-only regression: sample every painted entry frame, not just the final
// scroll position. Fixtures live in a fresh browser profile; no model calls.
const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/v1/cloud/status', (route) => route.fulfill({ json: { cloud: false } }));
    await page.route('https://models.dev/**', (route) => route.fulfill({ json: {} }));
    await page.addInitScript(() => {
      window.__entryFrames = [];
      window.__entrySelector = '[data-testid="course-chat-messages"]';
      const sample = () => {
        const list = document.querySelector(window.__entrySelector);
        if (list?.querySelector('[data-chat-message]') && getComputedStyle(list).visibility === 'visible') {
          const tail = [...list.querySelectorAll('[data-chat-message]')].at(-1);
          window.__entryFrames.push({
            distance: list.scrollHeight - list.clientHeight - list.scrollTop,
            top: list.scrollTop, height: list.scrollHeight, viewport: list.clientHeight,
            host: list.querySelector('[data-chat-positioned]')?.offsetHeight,
            padding: getComputedStyle(list).padding,
            tail: tail.textContent.slice(-100),
          });
        }
      };
      // rAF itself runs BEFORE layout/ResizeObserver, so sampling there can
      // mistake a not-yet-painted resize for a visible jump. Read after paint.
      const afterPaint = () => requestAnimationFrame(() => setTimeout(() => {
        sample();
        afterPaint();
      }, 0));
      afterPaint();
    });
    const settle = () => page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame);
    });
    const begin = () => page.evaluate(() => { window.__entryFrames = []; });
    const expectEntry = async (label, marker, checkEntryFrames = true) => {
      await page.waitForFunction(({ selector, marker }) => {
        const list = document.querySelector(selector);
        return list && getComputedStyle(list).visibility === 'visible'
          && list.textContent.includes(marker)
          && Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 2;
      }, { selector: await page.evaluate(() => window.__entrySelector), marker });
      await settle();
      const frames = await page.evaluate(() => window.__entryFrames);
      assert(frames.length > 0, `${label}: entry must actually become visible`);
      if (checkEntryFrames) {
        assert(frames.every((frame) => Math.abs(frame.distance) <= 2), `${label}: intermediate visible positions ${JSON.stringify(frames)}`);
      }
      assert(Math.abs(frames.at(-1).distance) <= 2, `${label}: measured content remains at end`);
      console.log(`✓ ${width}px ${label}: ${checkEntryFrames ? 'first visible frame at end, no intermediate jumps' : 'follows measured content'}`);
    };

    await page.goto(base);
    await page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('textarea.course-chat__input')?.disabled);
    const ids = await page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts');
      const storeUrl = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === '/src/store/courseChat.ts')?.name;
      const { useCourseChat } = await import(storeUrl || '/src/store/courseChat.ts');
      window.__entryChat = useCourseChat;
      const seed = async (videoId, title, count) => {
        const id = await db.chatSessions.add({ videoId, title, createdAt: Date.now() });
        await db.chats.bulkAdd(Array.from({ length: count }, (_, index) => ({
          sessionId: id, videoId, role: index % 2 ? 'assistant' : 'user', createdAt: index,
          content: index % 2 ? `${'不同高度的历史正文。\n\n'.repeat(index === count - 1 ? 80 : index % 7 + 1)}${title}末尾`
            : `历史问题 ${index}`,
        })));
        return id;
      };
      const first = await seed('__library_assistant__', '千条历史', 1000);
      const second = await seed('__library_assistant__', '另一长会话', 90);
      const videoId = 'entry-scroll-course';
      await db.videos.put({ id: videoId, name: '进入定位课程', size: 1, mimeType: 'video/mp4', duration: 100, createdAt: Date.now(), status: 'transcribed' });
      await db.segments.add({ videoId, idx: 0, start: 0, end: 5, text: '课程字幕', status: 1 });
      await seed(videoId, '课程面板', 100);
      await useCourseChat.getState().loadSession(first);
      return { first, second };
    });
    await expectEntry('cold history load', '千条历史末尾');
    assert(await page.locator('[data-chat-message]').count() < 25, 'initial end positioning keeps virtualization bounded');

    // Re-enter from another route with an already-loaded store, after having
    // read somewhere in the middle. Entry should not replay that old offset.
    await page.getByTestId('course-chat-messages').evaluate((list) => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
      list.scrollTop -= 300;
    });
    await settle();
    await page.evaluate(() => { location.hash = '#/library'; });
    await page.getByTestId('course-chat-messages').waitFor({ state: 'detached' });
    await begin();
    await page.evaluate(() => { location.hash = '#/chat'; });
    await expectEntry('route re-entry', '千条历史末尾');

    // Content/preview heights can change without a new message or token.
    await begin();
    await page.locator('[data-chat-message]').last().evaluate((row) => {
      const preview = document.createElement('div');
      preview.style.height = '320px';
      row.append(preview);
    });
    await expectEntry('late preview measurement', '千条历史末尾', false);

    await begin();
    await page.evaluate((id) => window.__entryChat.getState().loadSession(id), ids.second);
    await expectEntry('uncached session switch', '另一长会话末尾');
    await begin();
    await page.evaluate((id) => window.__entryChat.getState().loadSession(id), ids.first);
    await expectEntry('cached session switch', '千条历史末尾');

    // Reopening a still-growing reply is history entry too, not a new question.
    await page.evaluate(() => window.__entryChat.setState((state) => ({
      loading: true,
      messages: state.messages.map((message, index) => index === state.messages.length - 1 ? { ...message, streaming: true } : message),
    })));
    await page.evaluate(() => { location.hash = '#/library'; });
    await page.getByTestId('course-chat-messages').waitFor({ state: 'detached' });
    await begin();
    await page.evaluate(() => { location.hash = '#/chat'; });
    await expectEntry('streaming reply re-entry', '千条历史末尾');
    await begin();
    await page.evaluate(() => window.__entryChat.setState((state) => ({
      messages: state.messages.map((message, index) => index === state.messages.length - 1
        ? { ...message, content: `${message.content}\n\n${'继续生成的正文。\n\n'.repeat(12)}继续生成末尾` } : message),
    })));
    await expectEntry('stream growth after re-entry', '继续生成末尾', false);

    await page.reload();
    // bootstrap selects the newest stored conversation.
    await expectEntry('full reload', '另一长会话末尾');

    // The course-side chat uses the same virtual window and entry policy.
    await page.evaluate(() => { location.hash = '#/player/entry-scroll-course'; });
    await page.getByTestId('study-assistant-toggle').click();
    await page.evaluate(() => { window.__entrySelector = '[data-testid="chat-list"]'; window.__entryFrames = []; });
    await page.getByTestId('panel-tab-chat').click();
    await expectEntry('course panel entry', '课程面板末尾');
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
