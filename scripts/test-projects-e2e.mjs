// Uses a real isolated API/SQLite and built frontend, with a deterministic model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startWebFixture } from './lib/web-fixture.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-projects-e2e-'));
process.env.DATA_DIR = directory;
process.env.BOOTSTRAP_SECRET_FILE = path.join(directory, 'config/bootstrap-secret');
process.env.NODE_ENV = 'test';
process.env.CLOUD_BROWSER_DISABLED = '1';
process.env.MODEL_API_KEY = 'e2e-only';
process.env.MODEL_NAME = 'test';
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ fetch: async (_url, init) => {
  const body = JSON.parse(init.body);
  const project = body.messages[0].content.includes('Current project:');
  const afterTool = body.messages.some(m => m.role === 'tool');
  const name = project && !afterTool ? 'workspace' : 'send_message';
  const args = name === 'workspace' ? { action: 'write', path: 'bot-result.md', text: '# 项目成果\n持久化测试', expectedRevision: null }
    : { kind: 'text', text: project ? '项目文件已保存。' : 'BOT 独立对话已完成。' };
  return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', id: 'model-id', function: { name, arguments: JSON.stringify(args) } }] } }] }));
} });
let browser, web, page;
try {
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'e2e-project-password' } });
  web = await startWebFixture(await app.listen({ host: '127.0.0.1', port: 0 }));
  const base = web.origin;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ baseURL: base, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post('/api/v1/auth/password/login', { data: { password: 'e2e-project-password' } });
  assert.equal(login.status(), 200);
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // 只在对话区里找 Bot 说的话：会话列表也会把最后一句显示成预览。
  const said = (text) => page.locator('.bot-messages').getByText(text, { exact: true });
  await page.goto('/#/projects');
  await page.waitForURL(/#\/library$/);
  await page.getByTestId('btn-new-folder').click();
  await page.getByTestId('prompt-dialog').getByRole('textbox').fill('学习研究');
  await page.getByTestId('prompt-dialog-confirm').click();
  await page.getByTestId('resource-entry').filter({ hasText: '学习研究' }).waitFor();
  const created = (await (await context.request.get('/api/v1/resources')).json()).entries.find(entry => entry.name === '学习研究');
  const projectId = created.projectId;
  await page.goto(`/#/projects/${projectId}`);
  await page.waitForURL(/#\/library\/folders\/[^/]+\/chat$/);
  const workspace = path.join(directory, 'files/projects', projectId);
  await page.getByRole('button', { name: '文件夹设置', exact: true }).click();
  await page.getByLabel('文件夹名称', { exact: true }).fill('重命名研究');
  await page.getByLabel('文件夹指令', { exact: true }).fill('请将学习成果保存在项目文件中。');
  const { agents } = await (await context.request.get('/api/v1/agents')).json();
  await page.getByRole('button', { name: agents[0].name }).click();
  await page.getByRole('option', { name: '读写', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByTestId('page-title').filter({ hasText: '重命名研究' }).waitFor();
  assert.ok(fs.existsSync(workspace));
  const project = await (await context.request.get(`/api/v1/projects/${projectId}`)).json();
  assert.equal(project.workspacePath, `projects/${projectId}`);

  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.locator('[data-testid="resource-list"][aria-busy="false"]').waitFor();
  await page.locator('.resource-window input[type=file]').setInputFiles({ name: 'lecture.txt', mimeType: 'text/plain', buffer: Buffer.from('讲义内容') });
  await page.getByTestId('resource-entry').filter({ hasText: 'lecture.txt' }).waitFor();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建文本', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('notes.md');
  await page.getByLabel('文件内容', { exact: true }).fill('# 共享笔记');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByTestId('resource-entry').filter({ hasText: 'notes.md' }).waitFor();
  assert.equal(fs.readFileSync(path.join(workspace, 'notes.md'), 'utf8'), '# 共享笔记');
  await page.goto(`/#/library/folders/${projectId}/chat`);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('生成学习成果');
  await page.getByRole('textbox', { name: '消息', exact: true }).press('Enter');
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await said('项目文件已保存。').waitFor();
  assert.equal(fs.readFileSync(path.join(workspace, 'bot-result.md'), 'utf8'), '# 项目成果\n持久化测试');
  const firstThread = new URLSearchParams(page.url().split('?')[1]).get('thread');
  assert.ok(firstThread);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  assert.equal(await said('项目文件已保存。').count(), 0);
  await page.locator('.bh-threads').getByText('生成学习成果', { exact: true }).click();
  await said('项目文件已保存。').waitFor();
  await page.reload();
  await said('项目文件已保存。').waitFor();

  // The library folder is a view of the same workspace, not a second copy.
  await page.goto('/#/library');
  const tile = page.getByTestId('resource-entry').filter({ hasText: '重命名研究' });
  await tile.locator('.resource-open').click();
  await page.getByTestId('resource-entry').filter({ hasText: 'bot-result.md' }).waitFor();
  await page.getByTestId('resource-entry').filter({ hasText: 'notes.md' }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '更多操作 · bot-result.md', exact: true }).click();
  await page.getByRole('menuitem', { name: '下载', exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'bot-result.md');

  await page.goto('/#/bot');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('独立 BOT 聊天');
  await page.getByRole('textbox', { name: '消息', exact: true }).press('Enter');
  await said('BOT 独立对话已完成。').waitFor();
  // 聊天模式只有一条连续的对话：刷新之后还是同一条，自己的消息显示已读。
  await page.reload();
  await said('BOT 独立对话已完成。').waitFor();
  await page.locator('.bot-messages').getByText('独立 BOT 聊天', { exact: true }).waitFor();
  await page.locator('.imsg-receipt', { hasText: '已读' }).waitFor();
  assert.equal(await page.locator('.bh-threads').count(), 0, 'embedded chat has no folder conversation list');

  const shots = process.env.PROJECT_SCREENSHOT_DIR;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/projects/${projectId}/files`);
    await page.getByTestId('resource-entry').filter({ hasText: 'bot-result.md' }).waitFor();
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      barBottom: document.querySelector('.finder-toolbar').getBoundingClientRect().bottom,
      scopeTop: document.querySelector('.finder-canvas').getBoundingClientRect().top,
    }));
    assert.ok(geometry.document <= geometry.viewport, `No horizontal overflow at ${width}`);
    assert.ok(geometry.scopeTop >= geometry.barBottom - 1, `Project controls clear the app bar at ${width}`);
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `projects-${width}.png`) }); }
  }
  assert.deepEqual(errors, []);
  console.log('Project browser E2E: create/rename, same workspace in library, upload/edit/download, live approval, session restore, continuous chat with read receipt, desktop/mobile layout passed');
} catch (error) {
  if (page && !page.isClosed()) {
    const diagnostics = path.resolve('test-results/projects-e2e');
    fs.mkdirSync(diagnostics, { recursive: true });
    fs.writeFileSync(path.join(diagnostics, 'failure.txt'), `${page.url()}\n${await page.locator('body').innerText()}`);
    fs.writeFileSync(path.join(diagnostics, 'failure.html'), await page.content());
    await page.screenshot({ path: path.join(diagnostics, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
