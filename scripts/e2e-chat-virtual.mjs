import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Uses Vite modules to exercise the real database/store in an isolated browser profile.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.waitForSelector('[data-testid="course-chat-messages"]');
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const id = await db.chatSessions.add({ videoId: '__library_assistant__', title: '千条消息', createdAt: Date.now() });
    await db.chats.bulkAdd(Array.from({ length: 1000 }, (_, index) => ({
      videoId: '__library_assistant__', sessionId: id, role: index % 2 ? 'assistant' : 'user',
      content: `消息编号 ${index}\n\n${'不同高度的消息内容。'.repeat(index % 12 + 1)}`,
      createdAt: 1000 + Math.floor(index / 3), // Deliberately tied timestamps.
    })));
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    await useCourseChat.getState().loadSession(id);
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="course-chat-messages"]')?.textContent.includes('消息编号 999')).catch(async (error) => {
    console.log(await page.evaluate(async () => {
      const { useCourseChat } = await import('/src/store/courseChat.ts');
      const sc = document.querySelector('[data-testid="course-chat-messages"]');
      return { count: useCourseChat.getState().messages.length, top: sc.scrollTop, height: sc.scrollHeight, text: sc.textContent, errors: document.body.innerText };
    }));
    throw error;
  });
  const initial = await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    return { loaded: useCourseChat.getState().messages.length, dom: document.querySelectorAll('.course-chat__message').length };
  });
  assert.equal(initial.loaded, 40);
  assert.ok(initial.dom < 25, JSON.stringify(initial));
  console.log('✓ 1000 stored messages: 40 loaded,', initial.dom, 'mounted');

  await page.evaluate(() => { document.querySelector('[data-testid="course-chat-messages"]').scrollTop = 300; });
  await page.waitForTimeout(400);
  const anchor = await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="course-chat-messages"]');
    const row = [...sc.querySelectorAll('article')].find((el) => el.getBoundingClientRect().top > sc.getBoundingClientRect().top + 100);
    return { text: row.textContent.match(/消息编号 \d+/)[0], top: row.getBoundingClientRect().top };
  });
  await page.evaluate(async () => { const { useCourseChat } = await import('/src/store/courseChat.ts'); await useCourseChat.getState().loadOlder(); });
  await page.waitForTimeout(500);
  const after = await page.evaluate((text) => {
    const row = [...document.querySelectorAll('article')].find((el) => el.textContent.includes(text));
    return row?.getBoundingClientRect().top;
  }, anchor.text);
  assert.ok(Math.abs(after - anchor.top) < 4, `anchor moved: ${anchor.top} -> ${after}`);
  console.log('✓ Prepend preserves visible message position');

  await page.evaluate(() => { document.querySelector('[data-testid="course-chat-messages"]').scrollTop = 0; });
  await page.waitForFunction(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    return useCourseChat.getState().messages.length > 80;
  });
  console.log('✓ Scrolling to the top automatically loads older messages');

  const all = await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    while (useCourseChat.getState().hasOlder) await useCourseChat.getState().loadOlder();
    const messages = useCourseChat.getState().messages;
    return { length: messages.length, unique: new Set(messages.map((m) => m.rowId)).size, first: messages[0].content };
  });
  assert.equal(all.length, 1000);
  assert.equal(all.unique, 1000);
  assert.ok(all.first.startsWith('消息编号 0\n'));
  assert.ok(await page.locator('.course-chat__message').count() < 30);
  console.log('✓ All cursor pages have no missing/duplicate rows, DOM remains bounded');

  await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    useCourseChat.setState({ messages: [{ key: 'thinking-test', role: 'ai', content: '', streaming: true, reasoning: '思考内容\n'.repeat(200) }] });
  });
  await page.waitForSelector('.reasoning-chain__body');
  await page.waitForTimeout(500);
  const reasoning = await page.locator('.reasoning-chain__body').evaluate((el) => ({
    height: el.clientHeight, distance: el.scrollHeight - el.clientHeight - el.scrollTop,
    blur: getComputedStyle(el.parentElement.querySelector('.reasoning-chain__blur--top')).backdropFilter,
  }));
  assert.ok(reasoning.height <= 240 && reasoning.height > 0);
  assert.ok(reasoning.distance < 3, JSON.stringify(reasoning));
  assert.equal(reasoning.blur, 'blur(3px)');
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const videoId = 'virtual-panel-test';
    await db.videos.put({ id: videoId, name: '虚拟列表课程', size: 1, mimeType: 'video/mp4', duration: 100, createdAt: Date.now(), status: 'transcribed' });
    await db.segments.add({ videoId, idx: 0, start: 0, end: 5, text: '测试字幕', status: 1 });
    const sessionId = await db.chatSessions.add({ videoId, title: '长面板会话', createdAt: Date.now() });
    await db.chats.bulkAdd(Array.from({ length: 200 }, (_, index) => ({ videoId, sessionId,
      role: index % 2 ? 'assistant' : 'user', content: `面板消息 ${index}`, createdAt: index })));
  });
  await page.goto(`${process.env.BASE_URL || 'http://localhost:5173'}/#/player/virtual-panel-test`);
  await page.getByRole('button', { name: '打开学习助手' }).click();
  await page.locator('[data-testid="panel-tab-chat"]').click();
  await page.getByText('面板消息 199', { exact: true }).waitFor();
  assert.ok(await page.locator('.chat-msg').count() < 30);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('[data-testid="export-session-btn"]').click();
  const download = await downloadEvent;
  const { readFile } = await import('node:fs/promises');
  const exported = await readFile(await download.path(), 'utf8');
  assert.ok(exported.includes('面板消息 0\n') && exported.includes('面板消息 199'));
  console.log('✓ Course panel virtualizes messages and exports all 200 rows');
  assert.deepEqual(errors, []);
  console.log('✓ Fixed reasoning viewport follows stream and applies edge blur');
} finally { await browser.close(); }
