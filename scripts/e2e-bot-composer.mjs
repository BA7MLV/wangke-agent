// Real Web + API, isolated storage and deterministic model. No live IM account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-composer-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = process.env.BOT_UI_REVIEW ? 46321 : reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://localhost:${port}`;
process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { BotApplicationService } = await import('../apps/api/src/agent/service.ts');
const modelInputs = [];
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (_url, init) => {
  modelInputs.push(JSON.parse(init.body));
  return Response.json({ choices: [{ message: { content: '附件已收到。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
} });
let browser, web, store;
const output = process.env.SCREENSHOT_DIR ?? path.join(directory, 'screenshots');
fs.mkdirSync(output, { recursive: true });
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { host: 'localhost', port, strictPort: true, proxy: { '/api/v1': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false } } } });
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'composer-test-password-12345' }, { 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  assert.equal((await post('/auth/password/login', { password: 'composer-test-password-12345' })).status(), 200);
  const config = await (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  assert.equal((await context.request.put(`${origin}/api/v1/cloud/config`, { headers: { origin }, data: { ...config, providers: [{ id: 'offline', name: 'Offline', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'test', serves: ['chat'] }], llmModel: { providerId: 'offline', model: 'scripted' } } })).status(), 200);
  const thread = await (await post('/threads', { mode: 'bot', title: 'IM · 图片与输入框' })).json();
  const other = await (await post('/threads', { mode: 'bot', title: '另一段对话' })).json();
  const png = await sharp({ create: { width: 400, height: 220, channels: 3, background: '#79a8d1' } }).png().toBuffer();
  const file = await (await post('/files', png, { 'content-type': 'application/octet-stream', 'x-file-name': 'image.png', 'x-file-mime': 'image/png' })).json();
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const bot = new BotApplicationService(store, { enqueue() {} });
  bot.append(thread.id, 'user', 'text', `这张图\nAttachment fileId=${file.id}, name=image.png, mime=image/png. Use study_file to read/understand it.`);
  bot.append(thread.id, 'assistant', 'attachment', JSON.stringify({ fileId: file.id, name: 'image.png', mimeType: 'image/png', caption: '这是收到的图片。' }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/`);
  const open = async id => {
    await page.evaluate(async id => {
      const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN');
      const { useBotPanel } = await import('/src/store/botPanel.ts'); useBotPanel.getState().openThread(id);
    }, id);
    await page.getByTestId('bot-panel-history').filter({ hasText: id === thread.id ? thread.title : other.title }).waitFor();
  };
  await open(thread.id);
  const panel = page.getByTestId('bot-panel');
  const input = panel.locator('textarea');
  await input.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="bot-message-attachments"] img')].length === 2 && [...document.querySelectorAll('[data-testid="bot-message-attachments"] img')].every(img => img.naturalWidth > 0));
  assert.equal(await panel.getByText(/Attachment fileId=/).count(), 0);
  assert.equal(await panel.getByRole('button', { name: '预览图片 image.png' }).count(), 2);
  await panel.getByRole('button', { name: '预览图片 image.png' }).first().click();
  await page.getByTestId('bot-image-viewer').waitFor();
  await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();

  await panel.getByTestId('bot-add').click();
  await page.getByRole('menuitem', { name: '上传图片', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  const before = store.db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=? AND role=\'user\'').get(thread.id).n;
  await panel.getByTestId('bot-image-input').setInputFiles([{ name: 'draft.png', mimeType: 'image/png', buffer: png }]);
  await panel.getByTestId('chat-attachment').waitFor();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=? AND role=\'user\'').get(thread.id).n, before, 'selection does not send');
  await input.fill('和图片一起发送');
  await open(other.id); await input.fill('另一段草稿');
  assert.equal(await panel.getByTestId('chat-attachment').count(), 0);
  await open(thread.id); await input.filter({ hasText: '' }).waitFor();
  assert.equal(await input.inputValue(), '和图片一起发送');
  assert.equal(await panel.getByTestId('chat-attachment').count(), 1, 'drafts are conversation-scoped');
  await input.press('Enter');
  await panel.locator('.bot-messages').getByText('附件已收到。', { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await panel.getByTestId('chat-attachment').count(), 0);
  const sent = store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND role='user' AND kind='attachment' ORDER BY seq DESC LIMIT 1").get(thread.id);
  assert.equal(JSON.parse(sent.content).caption, '和图片一起发送');
  assert.equal(JSON.parse(sent.content).attachments.length, 1);
  assert.ok(modelInputs.some(body => body.messages.some(message => message.role === 'user' && message.content.includes('Use study_file'))), 'file hints go only to the model');

  // Paste and drag/drop share the same pending attachment pipeline.
  await input.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, png.toString('base64'));
  await panel.getByRole('button', { name: '移除附件 pasted.png', exact: true }).click();
  await panel.locator('.study-composer').evaluate(element => {
    const data = new DataTransfer(); data.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await panel.getByRole('button', { name: '移除附件 notes.txt', exact: true }).waitFor();
  await input.fill('长消息\n'.repeat(40));
  await panel.getByTestId('composer-expand').click();
  await page.getByTestId('composer-sheet').waitFor();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await input.fill('');
  await panel.getByRole('button', { name: '移除附件 notes.txt', exact: true }).click();

  // Partial upload failures retain every draft, and successful blobs are reused on retry.
  const uploads = new Map(); let failUpload = true;
  await page.route('**/api/v1/files', async route => {
    const name = decodeURIComponent(route.request().headers()['x-file-name'] ?? '');
    uploads.set(name, (uploads.get(name) ?? 0) + 1);
    if (name === 'retry.txt' && failUpload) { failUpload = false; await route.fulfill({ status: 500, json: { error: 'test_upload_failure' } }); }
    else await route.continue();
  });
  await panel.getByTestId('bot-file-input').setInputFiles(['good.txt', 'retry.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
  await input.fill('两个附件');
  await input.press('Enter');
  await panel.locator('.chat-attachments__error').waitFor();
  assert.equal(await panel.getByTestId('chat-attachment').count(), 2);
  assert.equal(await input.inputValue(), '两个附件');
  await panel.getByRole('button', { name: '发送', exact: true }).waitFor();
  const retryAccepted = page.waitForResponse(response => response.url().endsWith(`/threads/${thread.id}/messages`) && response.request().method() === 'POST');
  await input.press('Enter');
  assert.equal((await retryAccepted).status(), 201);
  await panel.getByTestId('chat-attachment').first().waitFor({ state: 'detached' });
  assert.equal(uploads.get('good.txt'), 1, 'successful file is not uploaded again');
  assert.equal(uploads.get('retry.txt'), 2);
  const batch = JSON.parse(store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND role='user' AND kind='attachment' ORDER BY seq DESC LIMIT 1").get(thread.id).content);
  assert.equal(batch.attachments.length, 2);
  assert.equal(batch.caption, '两个附件');
  await page.unroute('**/api/v1/files');

  const rejected = await post(`/threads/${thread.id}/messages`, { clientNonce: 'invalid-batch', kind: 'attachment', content: JSON.stringify({ attachments: [{ fileId: file.id }, { fileId: 'not-owned' }] }) });
  assert.equal(rejected.status(), 400, 'the HTTP boundary validates every file, not only the first');
  assert.equal(store.db.prepare("SELECT 1 FROM messages WHERE client_nonce='invalid-batch'").get(), undefined);

  await panel.getByTestId('bot-panel-new').click();
  const threadCount = store.db.prepare('SELECT COUNT(*) n FROM threads').get().n;
  await panel.getByTestId('bot-image-input').setInputFiles({ name: 'new-thread.png', mimeType: 'image/png', buffer: png });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM threads').get().n, threadCount, 'picking a file does not create a conversation');
  await input.fill('新会话图片');
  const created = page.waitForResponse(response => /\/threads\/[^/]+\/messages$/.test(response.url()) && response.request().method() === 'POST');
  await input.press('Enter');
  const createdMessage = await (await created).json();
  assert.equal(createdMessage.kind, 'attachment');
  assert.equal(JSON.parse(createdMessage.content).caption, '新会话图片');
  await panel.getByTestId('chat-attachment').first().waitFor({ state: 'detached' });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM threads').get().n, threadCount + 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs WHERE trigger_message_id=?').get(createdMessage.id).n, 1);
  await page.getByText('操作失败，请重试。', { exact: true }).waitFor({ state: 'hidden', timeout: 12000 });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(thread.id);
    await panel.getByTestId('bot-image-input').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: png });
    await input.fill('这张图片讲述了什么内容？');
    await panel.getByTestId('chat-attachment').waitFor();
    await page.screenshot({ path: path.join(output, `bot-composer-${width}.png`), fullPage: true, animations: 'disabled' });
    const card = await panel.locator('.study-composer').boundingBox();
    assert.ok(card.x >= 0 && card.x + card.width <= width + 1, `composer fits ${width}px viewport`);
    assert.ok(card.y + card.height <= 901, 'composer stays above the viewport bottom');
    await panel.getByRole('button', { name: '移除附件 preview.png', exact: true }).click();
    await input.fill('');
  }
  assert.deepEqual(errors, []);
  console.log(`Bot composer passed: legacy/new image previews, draft isolation, explicit send, model hints, paste/drop, expand, desktop/mobile. Screenshots: ${output}`);
  if (process.env.BOT_UI_REVIEW) {
    console.log(`Review: ${origin} (isolated fixture; login password composer-test-password-12345)`);
    await new Promise(resolve => process.once('SIGTERM', resolve));
  }
} finally {
  await browser?.close(); await web?.close(); store?.close(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
