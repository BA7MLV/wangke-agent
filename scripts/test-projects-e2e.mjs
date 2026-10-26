// Uses a real isolated API/SQLite and built frontend, with a deterministic model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-projects-e2e-'));
process.env.DATA_DIR = directory;
process.env.BOOTSTRAP_SECRET_FILE = path.join(directory, 'config/bootstrap-secret');
process.env.NODE_ENV = 'test';
process.env.CLOUD_BROWSER_DISABLED = '1';
process.env.MODEL_API_KEY = 'e2e-only';
process.env.MODEL_NAME = 'test';
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ staticDir: path.resolve('dist'), fetch: async (_url, init) => {
  const body = JSON.parse(init.body);
  const project = body.messages[0].content.includes('Current project:');
  const afterTool = body.messages.some(m => m.role === 'tool');
  const name = project && !afterTool ? 'workspace' : 'send_message';
  const args = name === 'workspace' ? { action: 'write', path: 'bot-result.md', text: '# 项目成果\n持久化测试', expectedRevision: null }
    : { kind: 'text', text: project ? '项目文件已保存。' : 'BOT 独立对话已完成。' };
  return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', id: 'model-id', function: { name, arguments: JSON.stringify(args) } }] } }] }));
} });
let browser;
try {
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'e2e-project-password' } });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ baseURL: base, locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post('/api/v1/auth/password/login', { data: { name: 'Administrator', password: 'e2e-project-password' } });
  assert.equal(login.status(), 200);
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/projects');
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
  await page.getByTestId('prompt-dialog').getByRole('textbox').fill('学习研究');
  await page.getByTestId('prompt-dialog-confirm').click();
  await page.waitForURL(/#\/projects\/[\da-f-]+$/);
  const projectId = page.url().split('/').at(-1);
  const workspace = path.join(directory, 'files/projects', projectId);
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('重命名研究');
  await page.getByLabel('项目指令', { exact: true }).fill('请将学习成果保存在项目文件中。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByTestId('page-title').filter({ hasText: '重命名研究' }).waitFor();
  assert.ok(fs.existsSync(workspace));
  const project = await (await context.request.get(`/api/v1/projects/${projectId}`)).json();
  assert.equal(project.workspacePath, `projects/${projectId}`);

  await page.getByRole('button', { name: '项目文件', exact: true }).click();
  await page.locator('.project-files input[type=file]').setInputFiles({ name: 'lecture.txt', mimeType: 'text/plain', buffer: Buffer.from('讲义内容') });
  await page.getByRole('button', { name: '查看 / 编辑文本 · lecture.txt', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('notes.md');
  await page.getByLabel('文件内容', { exact: true }).fill('# 共享笔记');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '查看 / 编辑文本 · notes.md', exact: true }).waitFor();
  assert.equal(fs.readFileSync(path.join(workspace, 'notes.md'), 'utf8'), '# 共享笔记');
  await page.getByRole('button', { name: '聊天', exact: true }).click();
  await page.getByRole('textbox', { name: 'Bot 任务内容' }).fill('生成学习成果');
  await page.getByRole('textbox', { name: 'Bot 任务内容' }).press('Enter');
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await page.getByText('项目文件已保存。', { exact: true }).waitFor();
  assert.equal(fs.readFileSync(path.join(workspace, 'bot-result.md'), 'utf8'), '# 项目成果\n持久化测试');
  const firstThread = new URLSearchParams(page.url().split('?')[1]).get('thread');
  assert.ok(firstThread);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  assert.equal(await page.getByText('项目文件已保存。', { exact: true }).count(), 0);
  await page.getByTestId(`nav-rail`).getByText('生成学习成果', { exact: true }).click();
  await page.getByText('项目文件已保存。', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('项目文件已保存。', { exact: true }).waitFor();

  // The library folder is a view of the same workspace, not a second copy.
  await page.goto('/#/library');
  const tile = page.locator('[data-project-folder]').filter({ hasText: '重命名研究' });
  await tile.dblclick();
  await page.getByRole('button', { name: '查看 / 编辑文本 · bot-result.md', exact: true }).waitFor();
  await page.getByRole('button', { name: '查看 / 编辑文本 · notes.md', exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 · bot-result.md', exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'bot-result.md');

  await page.goto('/#/chat');
  await page.getByRole('textbox', { name: 'Bot 任务内容' }).fill('独立 BOT 聊天');
  await page.getByRole('textbox', { name: 'Bot 任务内容' }).press('Enter');
  await page.getByText('BOT 独立对话已完成。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '新建 BOT', exact: true }).click();
  await page.getByTestId('prompt-dialog').getByRole('textbox').fill('研究助手');
  await page.getByTestId('prompt-dialog-confirm').click();
  await page.getByRole('option', { name: '研究助手', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.getByText('BOT 独立对话已完成。', { exact: true }).count(), 0);
  assert.equal(await page.getByTestId('nav-rail').getByText('独立 BOT 聊天', { exact: true }).count(), 0);
  const agents = (await (await context.request.get('/api/v1/agents')).json()).agents;
  await page.getByLabel('BOT', { exact: true }).selectOption(agents.find(a => a.name === 'Wangke Bot').id);
  await page.getByTestId('nav-rail').getByText('独立 BOT 聊天', { exact: true }).click();
  await page.getByText('BOT 独立对话已完成。', { exact: true }).waitFor();

  const shots = process.env.PROJECT_SCREENSHOT_DIR;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/projects/${projectId}/files`);
    await page.getByRole('button', { name: '查看 / 编辑文本 · bot-result.md', exact: true }).waitFor();
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      barBottom: document.querySelector('[data-testid=top-app-bar]').getBoundingClientRect().bottom,
      scopeTop: document.querySelector('.bot-scope-bar').getBoundingClientRect().top,
    }));
    assert.ok(geometry.document <= geometry.viewport, `No horizontal overflow at ${width}`);
    assert.ok(geometry.scopeTop >= geometry.barBottom - 1, `Project controls clear the app bar at ${width}`);
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `projects-${width}.png`) }); }
  }
  assert.deepEqual(errors, []);
  console.log('Project browser E2E: create/rename, same workspace in library, upload/edit/download, live approval, session restore, BOT grouping, desktop/mobile layout passed');
} finally {
  await browser?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
