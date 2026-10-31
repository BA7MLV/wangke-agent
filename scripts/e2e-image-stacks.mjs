// Focused local-only Chat sends: no account, model API or file server required.
// BASE_URL=http://127.0.0.1:5173 node scripts/e2e-image-stacks.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const output = process.env.SCREENSHOT_DIR || 'e2e-shots';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', route => route.fulfill({ status: 404, body: '' }));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.addInitScript(() => {
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 2, state: {
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://image-stack.test/v1', apiKey: 'test', protocol: 'openai-chat', serves: ['chat'], catalogId: 'openai' }],
      llmModel: { providerId: 'test', model: 'stack-vision' }, contextWindow: 32768, thinkingEnabled: false,
      savedModels: [{ providerId: 'test', model: 'stack-vision', name: 'Offline vision', slots: ['chat'], inputCapabilities: ['text', 'image'], outputCapabilities: ['text'], contextWindow: 32768, maxOutputTokens: 1024, toolCalling: true }],
    } }));
    const originalFetch = window.fetch.bind(window);
    window.__imageRequests = [];
    window.fetch = async (input, init) => {
      if (!String(input).startsWith('https://image-stack.test/')) return originalFetch(input, init);
      window.__imageRequests.push(JSON.parse(init.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '截图已收到。' } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await page.goto(base);
  await page.getByTestId('chat-add').waitFor();
  const png = await page.evaluate(async () => {
    const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN');
    const { useCourseChat } = await import('/src/store/courseChat.ts'); window.__chat = useCourseChat;
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 220;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#79a8d1'; ctx.fillRect(0, 0, 400, 220);
    return canvas.toDataURL().split(',')[1];
  });
  const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  const ready = count => page.waitForFunction(count => document.querySelectorAll('[data-testid="chat-attachment"][data-state="ready"]').length === count, count);
  const idle = count => page.waitForFunction(count => {
    const state = window.__chat.getState();
    return !state.loading && state.messages.filter(row => row.role === 'ai' && row.content).length >= count;
  }, count);
  await page.getByTestId('chat-image-input').setInputFiles({ name: '单张.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await ready(1); await input.fill('单独发送的一张截图'); await input.press('Enter'); await idle(1);
  const single = page.getByRole('button', { name: '预览图片 单张.png', exact: true });
  await single.waitFor();
  await page.getByTestId('chat-file-input').setInputFiles([
    ...['截图一.png', '截图二.png', '截图三.png'].map(name => ({ name, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })),
    { name: '说明.txt', mimeType: 'text/plain', buffer: Buffer.from('三张截图的说明') },
  ]);
  await ready(4);
  assert.equal(await page.getByTestId('chat-attachment-draft').locator('.chat-image-stack').count(), 0, 'drafts remain separately removable');
  await input.fill('一起发送的三张截图'); await input.press('Enter'); await idle(2);
  const album = page.getByTestId('chat-message-attachments').filter({ has: page.getByRole('button', { name: '查看 3 张图片', exact: true }) });
  await album.waitFor();
  assert.equal(await album.locator('img').count(), 1);
  assert.equal(await album.locator('.chat-image-stack__count').innerText(), '3');
  assert.equal(await album.locator('.chat-image-stack__count svg').count(), 1);
  const backplate = await album.locator('.chat-image-stack').evaluate(el => {
    const style = getComputedStyle(el, '::after');
    const transform = new DOMMatrix(style.transform);
    return { content: style.content, verticalScale: transform.m22, offset: transform.m42 };
  });
  assert.notEqual(backplate.content, 'none');
  assert.equal(backplate.verticalScale, 1, 'vertical scaling must not hide the backplate behind the cover');
  assert.ok(backplate.offset <= -6);
  assert.equal(await single.count(), 1, 'separate messages never merge');
  await album.getByRole('button', { name: '下载附件 说明.txt', exact: true }).waitFor();
  const payload = await page.evaluate(() => ({
    counts: window.__imageRequests.map(request => request.messages.map(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').length : 0)),
    failures: window.__chat.getState().messages.filter(row => row.error).map(row => row.content),
  }));
  assert.deepEqual(payload.failures, []);
  assert.ok(payload.counts.some(counts => counts.includes(3)), `all images reach the model: ${JSON.stringify(payload)}`);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const cover = album.getByRole('button', { name: '查看 3 张图片', exact: true });
    await cover.scrollIntoViewIfNeeded();
    const bounds = await cover.boundingBox();
    assert.equal(Math.round(bounds.width), 200);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await cover.evaluate(el => el.blur());
    await page.screenshot({ path: `${output}/image-stack-send-${width}.png`, animations: 'disabled' });
    await cover.click();
    const viewer = page.getByTestId('chat-image-viewer');
    await viewer.getByRole('heading', { name: '截图一.png', exact: true }).waitFor();
    await viewer.getByRole('button', { name: '下一张图片', exact: true }).click();
    await viewer.getByRole('heading', { name: '截图二.png', exact: true }).waitFor();
    await page.keyboard.press('ArrowRight');
    await viewer.getByRole('heading', { name: '截图三.png', exact: true }).waitFor();
    assert.equal(await viewer.getByRole('button', { name: '下一张图片', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape'); await viewer.waitFor({ state: 'hidden' });
    assert.equal(await cover.evaluate(el => el === document.activeElement), true);
  }
  await page.reload();
  await album.waitFor();
  assert.equal(await album.locator('img').count(), 1, 'history replays the same album');
  assert.equal(await single.count(), 1);
  assert.deepEqual(errors, []);
  console.log('✓ Image stack send: one cover/count, mixed file, separate drafts/messages, complete model payload, desktop/mobile navigation/focus, history replay');
} finally { await browser.close(); }
