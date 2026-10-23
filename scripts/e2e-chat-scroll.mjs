import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 850 }, hasTouch: width < 600 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/v1/cloud/status', (route) => route.fulfill({ json: { cloud: false } }));
    await page.route('https://models.dev/**', (route) => route.fulfill({ json: {} }));
    await page.goto(process.env.BASE_URL || 'http://localhost:5173');
    await page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.querySelector('textarea.course-chat__input')?.disabled);

    await page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts');
      const storeUrl = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === '/src/store/courseChat.ts')?.name;
      const { useCourseChat } = await import(storeUrl || '/src/store/courseChat.ts');
      window.__scrollChat = useCourseChat;
      const sessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '滚动回归', createdAt: Date.now() });
      await db.chats.bulkAdd(Array.from({ length: 60 }, (_, index) => ({
        sessionId, videoId: '__library_assistant__', role: index % 2 ? 'assistant' : 'user',
        content: index % 2 ? `历史回答 ${index}\n\n${'这是一段用于验证阅读位置的历史内容。\n\n'.repeat(5)}` : `历史提问 ${index}`,
        createdAt: index,
      })));
      await useCourseChat.getState().loadSession(sessionId);
    });

    const list = page.getByTestId('course-chat-messages');
    const settle = () => page.evaluate(async () => {
      for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    });
    const metrics = () => list.evaluate((element) => ({
      top: element.scrollTop, bottom: element.scrollHeight - element.clientHeight - element.scrollTop,
    }));
    const expectBottom = async (message) => {
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="course-chat-messages"]');
        return element && Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 2;
      }, null, { timeout: 5000 }).catch(async (error) => {
        console.error(message, await metrics(), await page.getByTestId('chat-scroll-bottom').getAttribute('data-show'), errors);
        throw error;
      });
      await settle();
      assert((await metrics()).bottom <= 2, message);
    };
    const update = (patch) => page.evaluate((patch) => {
      window.__scrollChat.setState((state) => ({
        loading: patch.streaming ?? state.loading,
        messages: state.messages.map((message) => message.key === 'scroll-answer' ? { ...message, ...patch } : message),
      }));
    }, patch);
    const pauseNearBottom = async () => {
      await list.evaluate((element, touch) => {
        if (touch) {
          const point = (clientY) => new Touch({ identifier: 1, target: element, clientX: 100, clientY });
          element.dispatchEvent(new TouchEvent('touchstart', { touches: [point(100)], bubbles: true }));
          element.dispatchEvent(new TouchEvent('touchmove', { touches: [point(112)], bubbles: true }));
          element.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
        } else {
          element.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }));
        }
        element.scrollTop -= 12;
      }, width < 600);
      await settle();
      return (await metrics()).top;
    };

    await expectBottom('history opens at latest message');
    // Prepending older history must retain the stable keyed reading anchor.
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      element.scrollTop = 150;
    });
    await settle();
    const anchor = await list.evaluate((element) => {
      const top = element.getBoundingClientRect().top + 100;
      const row = [...element.querySelectorAll('[data-index]')].find((node) => node.getBoundingClientRect().bottom > top);
      return { key: row.querySelector('[data-chat-message]').dataset.chatMessage, top: row.getBoundingClientRect().top };
    });
    await page.evaluate(() => window.__scrollChat.getState().loadOlder());
    await settle();
    const anchorTop = await list.locator(`[data-chat-message="${anchor.key}"]`).evaluate((node) => node.parentElement.getBoundingClientRect().top);
    assert(Math.abs(anchorTop - anchor.top) < 2, 'prepending preserves the reading anchor');
    await page.getByTestId('chat-scroll-bottom').click();
    await expectBottom('jump restores following');

    await page.evaluate(() => window.__scrollChat.setState((state) => ({
      loading: true,
      messages: [...state.messages,
        { key: 'scroll-question', role: 'user', content: '请输出一段长回答' },
        { key: 'scroll-answer', role: 'ai', content: '', streaming: true },
      ],
    })));
    await expectBottom('new reply follows');
    let content = '';
    for (let i = 0; i < 8; i++) {
      content += `第 ${i + 1} 段：${'实际布局增长时，最新内容应完整可见。'.repeat(4)}\n\n`;
      await update({ content });
      await expectBottom('streamed chunks stay at the end');
    }

    // Only the streaming flag / persisted id changes: final action rows still need positioning.
    await page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts');
      const state = window.__scrollChat.getState();
      const answer = state.messages.at(-1);
      const rowId = await db.chats.add({ sessionId: state.activeId, videoId: '__library_assistant__', role: 'assistant', content: answer.content, createdAt: Date.now() });
      window.__scrollChat.setState({ loading: false, messages: state.messages.map((message) => message.key === answer.key ? { ...message, streaming: false, rowId } : message) });
    });
    await expectBottom('completion lands after final action rows, without a new token');
    const actionBottom = await list.locator('[data-chat-message="scroll-answer"] [data-testid="chat-message-actions"]').evaluate((element) => element.getBoundingClientRect().bottom);
    const composerTop = await page.locator('.course-chat__composer-wrap').evaluate((element) => element.getBoundingClientRect().top);
    assert(actionBottom <= composerTop - 16, 'answer actions stay comfortably above the floating composer');

    // Simulate a late-decoding image / preview: no message or token update at all.
    const growPreview = () => list.locator('[data-chat-message="scroll-answer"] .course-chat__bubble--ai').evaluate((element) => {
      let preview = element.querySelector('[data-scroll-test-preview]');
      if (!preview) {
        preview = document.createElement('div');
        preview.dataset.scrollTestPreview = '';
        element.append(preview);
      }
      preview.style.height = `${preview.offsetHeight + 240}px`;
    });
    await growPreview();
    await expectBottom('late preview layout stays in view after completion');

    // A 12px upward gesture must release following, even inside the old 24/80px thresholds.
    const pausedTop = await pauseNearBottom();
    await growPreview();
    await settle();
    assert(Math.abs((await metrics()).top - pausedTop) < 2, 'small upward scroll is not undone by layout growth');
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-scroll-bottom"]')?.dataset.show === 'true');
    await update({ streaming: true, content: content += '\n继续输出，不抢阅读位置。\n\n'.repeat(4) });
    await settle();
    assert(Math.abs((await metrics()).top - pausedTop) < 2, 'new tokens do not pull a reader back');
    await update({ streaming: false });
    await settle();
    assert(Math.abs((await metrics()).top - pausedTop) < 2, 'completion respects the manually chosen position');

    await page.setViewportSize({ width, height: 650 });
    await settle();
    assert(Math.abs((await metrics()).top - pausedTop) < 2, 'viewport shrinking does not steal a paused position');
    await page.getByTestId('chat-scroll-bottom').click();
    await expectBottom('jump resumes layout following');
    await page.setViewportSize({ width, height: 850 });
    await expectBottom('viewport resize follows when pinned');
    await page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true }).fill('输入框增高\n'.repeat(5));
    await expectBottom('growing composer retains the latest answer');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await pauseNearBottom();
    await growPreview();
    await settle();
    await page.getByTestId('chat-scroll-bottom').click();
    await expectBottom('reduced motion jump lands immediately');

    await pauseNearBottom();
    await page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts');
      const sessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '短回答', createdAt: Date.now() });
      await db.chats.bulkAdd([
        { sessionId, videoId: '__library_assistant__', role: 'user', content: '一个短问题', createdAt: 1 },
        { sessionId, videoId: '__library_assistant__', role: 'assistant', content: '简短回答，不需要多余滚动。', createdAt: 2 },
      ]);
      await window.__scrollChat.getState().loadSession(sessionId);
    });
    await expectBottom('switching sessions resets follow state');
    assert.equal((await metrics()).top, 0, 'short answers remain fully visible without unnecessary scrolling');
    assert.deepEqual(errors, []);
    console.log(`Chat scroll ${width}px: stream, completion, late layout, manual pause, history anchor, jump, viewport, composer and session switch passed.`);
    await page.close();
  }

  // Exercise the real course panel too, using its cloud-progress event path
  // rather than making model requests or reaching into component state.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/cloud/status', (route) => route.fulfill({ json: { cloud: false } }));
  await page.route('https://models.dev/**', (route) => route.fulfill({ json: {} }));
  const base = process.env.BASE_URL || 'http://localhost:5173';
  await page.goto(base);
  await page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true }).waitFor();
  const sessionId = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const videoId = 'scroll-panel-course';
    await db.videos.put({ id: videoId, name: '滚动测试课程.mp4', size: 1, mimeType: 'video/mp4', duration: 100, createdAt: Date.now(), status: 'transcribed' });
    await db.segments.add({ videoId, idx: 0, start: 0, end: 5, text: '课程字幕', status: 1 });
    const sessionId = await db.chatSessions.add({ videoId, title: '侧栏滚动', createdAt: Date.now() });
    await db.chats.bulkAdd(Array.from({ length: 12 }, (_, index) => ({
      sessionId, videoId, role: index % 2 ? 'assistant' : 'user', createdAt: index,
      content: index % 2 ? `课程回答 ${index}\n\n${'历史内容。\n\n'.repeat(6)}` : `课程问题 ${index}`,
      ...(index === 11 ? { quiz: { data: { questions: [{ stem: '保持这道题的位置', options: ['正确选项', '另一个选项'], answer: 0, explanation: '答题后展开的解析不该把选项顶走。\n\n'.repeat(10) }] }, picks: [-1] } } : {}),
    })));
    return sessionId;
  });
  await page.goto(`${base}/#/player/scroll-panel-course`);
  await page.getByTestId('study-assistant-toggle').click();
  await page.getByTestId('panel-tab-chat').click();
  const panelList = page.getByTestId('chat-list');
  await panelList.getByTestId('quiz-card').waitFor();
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
  });
  const panelMetrics = () => panelList.evaluate((element) => ({ top: element.scrollTop, bottom: element.scrollHeight - element.clientHeight - element.scrollTop }));
  const expectPanelBottom = async () => {
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="chat-list"]');
      return element && Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 2;
    }, null, { timeout: 5000 });
    await settle();
    assert((await panelMetrics()).bottom <= 2);
  };
  await expectPanelBottom();
  const option = panelList.getByRole('button', { name: /正确选项/ });
  const quizTop = (await option.boundingBox()).y;
  await option.click();
  await settle();
  assert(Math.abs((await option.boundingBox()).y - quizTop) < 2, 'revealing quiz explanations keeps the selected option in place');
  // Scrolling down to the end (without using a jump button) re-enables follow.
  await panelList.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await settle();
  const progress = async (content, completed = false) => {
    await page.evaluate(async ({ sessionId, content, completed }) => {
      if (completed) {
        const { db } = await import('/src/store/db.ts');
        await db.chats.add({ sessionId, videoId: 'scroll-panel-course', role: 'assistant', content, createdAt: Date.now() });
      }
      window.dispatchEvent(new CustomEvent('cloud-tasks-changed', { detail: { dataChanged: completed, tasks: [{
        id: 'scroll-panel-progress', kind: 'qa', input: { sessionId }, status: completed ? 'succeeded' : 'running', progress: { content },
      }] } }));
    }, { sessionId, content, completed });
    await panelList.getByTestId('chat-msg-ai').last().filter({ hasText: content.slice(0, 12) }).waitFor();
    await settle();
  };
  const panelContent = '课程回答正在持续输出。\n\n'.repeat(30);
  await progress(panelContent);
  await expectPanelBottom();
  await progress(panelContent, true);
  await expectPanelBottom();
  const aiBubble = panelList.getByTestId('chat-msg-ai').last().locator('.chat-bubble--ai');
  await aiBubble.evaluate((element) => {
    const preview = document.createElement('div');
    preview.style.height = '220px';
    element.append(preview);
  });
  await expectPanelBottom();
  await panelList.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }));
    element.scrollTop -= 12;
  });
  await settle();
  const paused = (await panelMetrics()).top;
  await aiBubble.evaluate((element) => { element.lastElementChild.style.height = '440px'; });
  await settle();
  assert(Math.abs((await panelMetrics()).top - paused) < 2, 'the course panel also respects a small upward gesture');
  assert.deepEqual(errors, []);
  console.log('Course panel scroll: completion, delayed layout, quiz reading position, manual resume and pause passed.');
  await page.close();
} finally {
  await browser.close();
}
