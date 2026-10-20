import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).waitFor();
  const seed = () => page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const storeUrl = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === '/src/store/courseChat.ts')?.name;
    const { useCourseChat } = await import(storeUrl || '/src/store/courseChat.ts');
    const sessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '删除粒子测试', createdAt: Date.now() });
    const image = document.createElement('canvas');
    image.width = 240; image.height = 140;
    const ctx = image.getContext('2d');
    ctx.fillStyle = '#fa5230'; ctx.fillRect(0, 0, 120, 140);
    ctx.fillStyle = '#2080ff'; ctx.fillRect(120, 0, 120, 140);
    const ids = await db.chats.bulkAdd([
      { sessionId, videoId: '__library_assistant__', role: 'user', content: '这张图片和文字应该一起化为灰烬', createdAt: 1,
        attachments: [{ id: 'dust-image', name: 'dust.png', mime: 'image/png', size: 200, dataUrl: image.toDataURL(), kind: 'image' }] },
      { sessionId, videoId: '__library_assistant__', role: 'assistant', content: '保留的后续回答 **不会被连带删除**。', createdAt: 2 },
    ], { allKeys: true });
    await useCourseChat.getState().loadSession(sessionId);
    return { sessionId, ids };
  });
  const fixture = await seed();
  const messages = page.locator('[data-chat-message]');
  await page.getByText('这张图片和文字应该一起化为灰烬', { exact: true }).waitFor({ timeout: 10000 }).catch(async (error) => {
    console.log(await page.locator('body').innerText());
    console.log(await page.evaluate(async () => {
      const storeUrl = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === '/src/store/courseChat.ts')?.name;
      const { useCourseChat } = await import(storeUrl || '/src/store/courseChat.ts');
      const state = useCourseChat.getState();
      return { activeId: state.activeId, loaded: state.loaded, messages: state.messages };
    }));
    console.log(errors);
    throw error;
  });
  await messages.first().hover();
  await messages.first().getByTestId('chat-delete-message').click();
  await page.getByTestId('confirm-dialog-cancel').click();
  assert.equal(await messages.count(), 2, 'cancel keeps both messages');
  await messages.first().hover();
  await messages.first().getByTestId('chat-delete-message').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await page.getByTestId('chat-message-dust').waitFor({ state: 'attached', timeout: 5000 });
  const colors = await page.getByTestId('chat-message-dust').evaluate((canvas) => {
    if (canvas.dataset.renderer !== 'telegram-webgl2') throw new Error('Expected the Telegram WebGL2 renderer');
    const gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let red = 0, blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 50 && pixels[i] > 180 && pixels[i + 1] < 150) red++;
      if (pixels[i + 3] > 50 && pixels[i + 2] > 180 && pixels[i] < 100) blue++;
    }
    return { red, blue };
  });
  assert.ok(colors.red > 30 && colors.blue > 30, `particles preserve image colors: ${JSON.stringify(colors)}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'e2e-shots/message-dust.png' });
  await page.getByTestId('chat-message-dust').waitFor({ state: 'detached' });
  assert.equal(await messages.count(), 1);
  assert.equal(await page.evaluate(async (id) => (await import('/src/store/db.ts')).db.chats.get(id), fixture.ids[0]), undefined);
  assert.ok(await page.evaluate(async (id) => (await import('/src/store/db.ts')).db.chats.get(id), fixture.ids[1]));
  await page.reload();
  await page.getByText('保留的后续回答', { exact: false }).first().waitFor();
  assert.equal(await messages.count(), 1, 'deletion survives reload');

  // The store also rejects deletion during generation and wrong-session calls.
  await page.evaluate(async ({ sessionId }) => {
    const storeUrl = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === '/src/store/courseChat.ts')?.name;
    const { useCourseChat } = await import(storeUrl || '/src/store/courseChat.ts');
    const state = useCourseChat.getState();
    const key = state.messages[0].key;
    if (await state.deleteMessage(key, sessionId + 1)) throw new Error('wrong-session deletion');
    useCourseChat.setState({ loading: true });
    if (await state.deleteMessage(key, sessionId)) throw new Error('inflight deletion');
    useCourseChat.setState({ loading: false });
  }, fixture);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await messages.first().hover();
  await messages.first().getByTestId('chat-delete-message').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await messages.waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('chat-message-dust').count(), 0, 'reduced motion skips particles');

  await seed();
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByTestId('chat-user-message-trigger');
  await trigger.waitFor();
  const bounds = await trigger.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await page.getByTestId('chat-user-delete').waitFor();
  await page.getByTestId('chat-user-delete').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await page.getByText('这张图片和文字应该一起化为灰烬', { exact: true }).waitFor({ state: 'detached' });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed();
  await page.getByText('这张图片和文字应该一起化为灰烬', { exact: true }).waitFor();
  await page.waitForTimeout(400); // Let the message-entry/layout transition settle before capture.
  // Prepared-but-never-committed and active animations both release resources.
  await page.evaluate(async () => {
    const { prepareMessageDust } = await import('/src/utils/messageDust.ts');
    const node = document.querySelector('[data-chat-message]');
    const aborted = new AbortController();
    const effect = await prepareMessageDust(node, aborted.signal);
    if (!effect) throw new Error('Expected a prepared WebGL effect');
    effect.play();
    const canvas = document.querySelector('[data-testid="chat-message-dust"]');
    const gl = canvas.getContext('webgl2');
    aborted.abort();
    if (canvas.isConnected || !gl.isContextLost()) throw new Error('Aborted animation leaked GPU resources');
    const uncommitted = await prepareMessageDust(node, new AbortController().signal);
    if (!uncommitted) throw new Error('Expected an uncommitted effect');
    uncommitted.dispose();
    uncommitted.play();
    if (document.querySelector('[data-testid="chat-message-dust"]')) throw new Error('Disposed effect replayed');
  });
  // No WebGL2 must still delete successfully, without the old approximation.
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl2') return null;
      return original.call(this, type, ...args);
    };
  });
  await messages.first().hover();
  await messages.first().getByTestId('chat-delete-message').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await page.getByText('这张图片和文字应该一起化为灰烬', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('chat-message-dust').count(), 0, 'WebGL2 failure falls back to deletion, not a fake renderer');
  assert.deepEqual(errors, []);
  console.log('Message deletion: cancel, original-shader colored particles, persistence, reload, guards, mobile long-press, reduced motion, GPU disposal and WebGL2 fallback passed.');
} finally {
  await browser.close();
}
