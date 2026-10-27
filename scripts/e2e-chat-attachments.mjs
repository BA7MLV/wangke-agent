// Real isolated file API + browser IndexedDB + deterministic model; requires a Vite dev server.
// BASE_URL=http://127.0.0.1:5188 npx tsx scripts/e2e-chat-attachments.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-attachments-'));
process.env.DATA_DIR = dir;
process.env.BOOTSTRAP_SECRET_FILE = path.join(dir, 'config/bootstrap-secret');
process.env.NODE_ENV = 'test';
process.env.PUBLIC_ORIGIN = new URL(base).origin;
process.env.MAX_FILE_BYTES = '1048576';
delete process.env.MODEL_API_KEY;
const { buildServer } = await import('../apps/api/src/server.ts');
let app = buildServer({ staticDir: path.join(dir, 'empty') });
let address = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let unavailable = false;
  let localOnly = false;
  await page.route('**/api/v1/**', async (route) => {
    if (unavailable) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    if (localOnly) return route.fulfill({ status: 404, body: '' });
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${address}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await page.addInitScript(() => {
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 2, state: {
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://attachments.test/v1', apiKey: 'test-key', protocol: 'openai-chat', serves: ['chat', 'vision'], catalogId: 'openai' }],
      llmModel: { providerId: 'test', model: 'gpt-4o' }, visionModel: { providerId: 'test', model: 'gpt-4o' },
      contextWindow: 32768, agentRounds: 4, thinkingEnabled: false,
    } }));
    const originalFetch = window.fetch.bind(window);
    window.__attachmentRequests = [];
    window.__attachmentDelay = 0;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith('https://attachments.test/')) return originalFetch(input, init);
      const body = JSON.parse(init.body);
      window.__attachmentRequests.push(body);
      if (!body.stream) return Response.json({ choices: [{ message: { role: 'assistant', content: '图片中是用于测试的绿色方块。' } }] });
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '已读取附件。' } }] })}\n\n`));
        if (window.__attachmentDelay) await new Promise((resolve) => setTimeout(resolve, window.__attachmentDelay));
        controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await page.goto(`${base}/#/chat`);
  await page.getByTestId('chat-add').waitFor();
  await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => name.includes('/src/store/courseChat.ts'));
    if (!moduleUrl) throw new Error('courseChat module was not loaded');
    window.__chat = (await import(moduleUrl)).useCourseChat;
  });
  await page.waitForFunction(() => window.__chat.getState().loaded);
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    await db.videos.put({ id: 'attachment-course', name: '附件测试课程', createdAt: Date.now(), duration: 60, size: 100 });
  });
  await page.getByTestId('chat-add').click();
  await page.getByRole('menuitem', { name: '添加课程', exact: true }).click();
  await page.getByTestId('chat-course-picker').getByText('附件测试课程', { exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: '附件测试课程' }).isChecked(), true);
  await page.getByRole('button', { name: '添加 1 门课程', exact: true }).click();
  assert.match(await page.getByTestId('course-chat-context').innerText(), /附件测试课程/);
  await page.getByTestId('chat-file-input').setInputFiles({ name: '课程笔记.txt', mimeType: 'text/plain', buffer: Buffer.from('ATTACHMENT_BODY_42：知识点是向量检索。') });
  await page.getByTestId('chat-attachment').locator('[role="alert"]').waitFor();
  assert.match(await page.getByTestId('chat-attachment').innerText(), /初始化或登录/);
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  await page.evaluate(async (secret) => {
    await fetch('/api/v1/bootstrap/initialize', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bootstrap-Secret': secret }, body: JSON.stringify({ adminPassword: 'attachment-test-password' }) });
    const login = await fetch('/api/v1/auth/password/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'attachment-test-password' }) });
    if (!login.ok) throw new Error('login failed');
  }, secret);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  assert.match(await page.getByTestId('chat-attachment').innerText(), /已保存到服务端/);
  const bodyInput = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await bodyInput.fill('总结文档');
  await bodyInput.press('Enter');
  const idle = () => page.waitForFunction(() => {
    const state = window.__chat.getState();
    return state.messages.some((m) => m.role === 'ai' && m.content) && !state.loading;
  });
  await idle();
  assert.equal(await page.getByTestId('chat-message-attachments').count(), 1);
  const stored = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    return { rows: await db.chats.toArray(), session: await db.chatSessions.toCollection().first(), requests: window.__attachmentRequests };
  });
  assert.deepEqual(stored.session.contextCourseIds, ['attachment-course']);
  const file = stored.rows.find((row) => row.role === 'user').attachments[0];
  assert.ok(file.serverId);
  assert.ok(stored.requests.some((request) => JSON.stringify(request.messages).includes('ATTACHMENT_BODY_42')));
  assert.equal(fs.readdirSync(path.join(dir, 'files')).filter((name) => name.endsWith('.bin')).length, 1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载附件 课程笔记.txt' }).click();
  assert.equal(await (await download).suggestedFilename(), '课程笔记.txt');
  await app.close();
  app = buildServer({ staticDir: path.join(dir, 'empty') });
  address = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal(await page.evaluate(async (id) => (await fetch(`/api/v1/files/${id}`)).text(), file.serverId), 'ATTACHMENT_BODY_42：知识点是向量检索。');
  await page.reload();
  await page.getByTestId('chat-message-attachments').waitFor();
  await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => name.includes('/src/store/courseChat.ts'));
    if (!moduleUrl) throw new Error('courseChat module was not loaded after reload');
    window.__chat = (await import(moduleUrl)).useCourseChat;
  });
  assert.match(await page.getByTestId('course-chat-context').innerText(), /附件测试课程/);
  console.log('✓ Course scope, real authenticated upload/download, restart and history replay');

  await page.evaluate(async () => {
    await window.__chat.getState().retryMessage(window.__chat.getState().messages.at(-1).key);
    await window.__chat.getState().forkSession(window.__chat.getState().activeId);
  });
  await idle();
  assert.equal(await page.getByTestId('chat-message-attachments').count(), 1);
  assert.ok(await page.evaluate(() => window.__attachmentRequests.some((request) => JSON.stringify(request.messages).includes('ATTACHMENT_BODY_42'))));
  await page.evaluate(() => { window.__attachmentDelay = 800; });
  await bodyInput.fill('先回答这一句'); await bodyInput.press('Enter');
  await page.getByTestId('chat-stop').waitFor();
  await page.getByTestId('chat-file-input').setInputFiles({ name: '排队.txt', mimeType: 'text/plain', buffer: Buffer.from('QUEUED_ATTACHMENT_73') });
  await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  await bodyInput.fill('这份排队'); await bodyInput.press('Enter');
  await page.waitForFunction(() => {
    const state = window.__chat.getState();
    return !state.loading && !state.queued.length && state.messages.some((row) => row.attachments?.some((file) => file.name === '排队.txt'));
  });
  assert.ok(await page.evaluate(() => window.__attachmentRequests.some((request) => JSON.stringify(request.messages).includes('QUEUED_ATTACHMENT_73'))));
  console.log('✓ Retry, fork, and queued messages retain attachment bodies');

  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#00aa00'; ctx.fillRect(0, 0, 64, 64); return canvas.toDataURL().split(',')[1]; });
  await page.getByTestId('chat-image-input').setInputFiles({ name: '图片.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  const draftImage = page.getByTestId('chat-attachment');
  assert.equal((await draftImage.innerText()).trim(), '', 'Ready images should not show filename/storage metadata');
  for (const viewport of [{ width: 1280, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: '预览图片 图片.png', exact: true }).click();
    const viewer = page.getByTestId('chat-image-viewer');
    await viewer.waitFor();
    await viewer.evaluate(async (element) => { await Promise.allSettled(element.parentElement.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
    await page.waitForFunction(() => { const image = document.querySelector('[data-testid="chat-image-viewer"] img'); return image?.complete && image.naturalWidth > 0; });
    const bounds = await viewer.boundingBox();
    assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, `Viewer must fit the visible viewport: ${JSON.stringify({ bounds, viewport })}`);
    await viewer.getByRole('button', { name: '放大图片', exact: true }).click();
    assert.match(await viewer.innerText(), /150%/);
    await viewer.getByRole('button', { name: '适应窗口', exact: true }).click();
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: '预览图片 图片.png', exact: true }).evaluate((el) => el === document.activeElement), true, 'Closing restores focus to the thumbnail');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await bodyInput.press('Enter'); await idle();
  const imageMessage = page.getByTestId('chat-message-attachments').filter({ has: page.getByRole('button', { name: '预览图片 图片.png', exact: true }) });
  assert.equal((await imageMessage.innerText()).trim(), '', 'Message images should display without metadata');
  await imageMessage.getByRole('button', { name: '预览图片 图片.png', exact: true }).click();
  await page.getByTestId('chat-image-viewer').waitFor();
  await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  assert.equal(await page.locator('.course-chat__bottom-blur').count(), 0);
  console.log('✓ Image preview on desktop/tablet/mobile, zoom, Escape, focus restoration, clean message thumbnails, top-only blur');
  assert.ok(await page.evaluate(() => window.__attachmentRequests.some((request) => request.messages.some((m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url')))));
  // Switch to text-only model and verify historical images are described, never silently dropped.
  await page.evaluate(async () => {
    const { useSettings } = await import('/src/store/settings.ts');
    useSettings.setState({ llmModel: { providerId: 'test', model: 'text-only-test' } });
  });
  await bodyInput.fill('再解释一下图片'); await bodyInput.press('Enter'); await idle();
  assert.ok(await page.evaluate(() => window.__attachmentRequests.some((request) => request.stream && JSON.stringify(request.messages).includes('绿色方块'))));
  console.log('✓ Image-only send, actual image payload, and vision fallback after model switch');

  unavailable = true;
  await page.getByTestId('chat-file-input').setInputFiles({ name: '故障.txt', mimeType: 'text/plain', buffer: Buffer.from('outage') });
  await page.locator('[data-testid="chat-attachment"][data-state="error"]').waitFor();
  assert.match(await page.getByTestId('chat-attachment').innerText(), /暂不可用/);
  await page.getByRole('button', { name: '移除附件 故障.txt' }).click();
  unavailable = false;
  await page.getByTestId('chat-file-input').setInputFiles({ name: 'too-big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1048577, 'x') });
  await page.locator('[data-testid="chat-attachment"][data-state="error"]').waitFor();
  assert.match(await page.getByTestId('chat-attachment').innerText(), /服务端上限/);
  await page.getByRole('button', { name: '移除附件 too-big.txt' }).click();
  localOnly = true;
  await page.getByTestId('chat-file-input').setInputFiles({ name: '本机.txt', mimeType: 'text/plain', buffer: Buffer.from('LOCAL_ATTACHMENT') });
  await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  assert.match(await page.getByTestId('chat-attachment').innerText(), /已保存到本机/);
  const parkedSessionId = await page.evaluate(() => window.__chat.getState().activeId);
  await page.getByTestId('chat-new-session').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-attachment-draft"]'));
  await page.evaluate(async (id) => { await window.__chat.getState().loadSession(id); }, parkedSessionId);
  await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  assert.match(await page.getByTestId('chat-attachment').innerText(), /本机.txt/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('chat-add').click();
  await page.getByRole('menuitem', { name: '上传图片', exact: true }).waitFor();
  await page.screenshot({ path: 'e2e-shots/chat-attachments-mobile.png' });
  await page.keyboard.press('Escape');
  // HeroUI keeps the popover mounted during the viewport transition; use a menu action
  // as a deterministic close fallback before reopening it at desktop width.
  if (await page.getByRole('menuitem', { name: '上传图片', exact: true }).count()) {
    await page.getByRole('menuitem', { name: '上传图片', exact: true }).click({ force: true });
  }
  const box = await page.locator('.course-chat__composer').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, JSON.stringify(box));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId('chat-add').click();
  await page.getByRole('menuitem', { name: /技能范围/ }).click();
  await page.getByTestId('skill-picker-dialog').waitFor();
  await page.getByTestId('skill-picker-done').click();
  await page.getByTestId('chat-add').click();
  await page.screenshot({ path: 'e2e-shots/chat-attachments-desktop.png' });
  assert.deepEqual(errors, []);
  console.log('✓ Failure/size handling, explicit local storage, skills menu, mobile layout; no page errors');
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
