import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-chat-projects-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let vite, browser, debugPage;
const errors = [];
const shots = path.resolve('test-results/chat-projects');
fs.mkdirSync(shots, { recursive: true });
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'chat-project-password' } });
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'chat-project-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const call = async (method, url, payload) => {
    const response = await api.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  };
  const config = await call('GET', '/cloud/config');
  await call('PUT', '/cloud/config', { ...config, providers: [{ id: 'offline', name: 'Offline', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'test-only', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'offline', model: 'test' } });
  await call('POST', '/cloud/records', { mutations: [{ id: 'language', table: 'preferences', key: 'uiLanguage', before: null, after: { id: 'uiLanguage', value: 'zh-CN' } }] });
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'chat-project-fixture', configureServer(server) {
      server.middlewares.use('/__fixture_login', (_req, res) => {
        res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.writeHead(302, { location: '/#/' }); res.end();
      });
    },
  }] });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  if (process.env.PROJECT_PREVIEW) {
    console.log(`PROJECT_PREVIEW ${origin}/__fixture_login`);
    await new Promise(resolve => process.once('SIGTERM', resolve));
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    await context.addInitScript(() => {
      window.loadTestModule = path => {
        const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
        return import(entry?.name ?? path);
      };
    });
    const page = await context.newPage();
    debugPage = page;
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/__fixture_login`);
    const input = page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true });
    await input.waitFor({ timeout: 60000 });
    await page.getByTestId('chat-go-import').click();
    const picker = page.getByTestId('chat-project-picker');
    await picker.getByText('还没有项目，在下面新建一个吧。', { exact: true }).waitFor();
    assert.equal(await picker.getByTestId('chat-project-create').isDisabled(), true);
    await picker.getByRole('textbox', { name: '项目名称', exact: true }).fill('../无效名称');
    assert.equal(await picker.getByTestId('chat-project-create').isDisabled(), true);
    await picker.getByRole('textbox', { name: '项目名称', exact: true }).fill('期末复习');
    await picker.getByTestId('chat-project-create').click();
    await picker.waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('chat-go-import').innerText(), '期末复习');
    const project = (await call('GET', '/resources')).entries.find(entry => entry.name === '项目：期末复习');
    assert.ok(project?.folderId);
    assert.ok(fs.statSync(path.join(directory, 'files', project.scope.workspacePath)).isDirectory());
    await input.fill('在项目里开始复习');
    const submitted = page.waitForResponse(response => response.url().includes('/api/v1/cloud/tasks') && response.request().method() === 'POST');
    await page.getByTestId('chat-send').click();
    await page.getByTestId('chat-import-strip').waitFor({ state: 'hidden' });
    await page.waitForFunction(async () => {
      const { useCourseChat } = await window.loadTestModule('/src/store/courseChat.ts');
      return useCourseChat.getState().activeId != null;
    });
    const sessionId = await page.evaluate(async () => (await window.loadTestModule('/src/store/courseChat.ts')).useCourseChat.getState().activeId);
    await submitted;
    const session = (await call('GET', `/cloud/record?table=chatSessions&key=${sessionId}`)).value;
    assert.equal(session.projectFolderId, project.folderId, 'project association persists on first send');
    await page.reload();
    await input.waitFor();
    assert.equal(await page.getByTestId('chat-import-strip').count(), 0, 'persisted conversations keep the strip collapsed after reload');
    await page.getByTestId('nav-rail-home').click();
    const projectTile = page.getByTestId('resource-entry').filter({ hasText: '项目：期末复习' });
    await projectTile.waitFor();
    await projectTile.getByRole('button', { name: '更多操作 · 项目：期末复习' }).click();
    await page.getByRole('menuitem', { name: '文件夹颜色', exact: true }).hover();
    await page.getByRole('menuitemradio', { name: '紫色', exact: true }).click();
    await projectTile.locator('[data-folder-color="purple"]').waitFor();
    await page.reload();
    await projectTile.locator('[data-folder-color="purple"]').waitFor();
    await page.screenshot({ path: path.join(shots, 'folder-color-desktop.png'), animations: 'disabled' });
    await projectTile.locator('.resource-open').click();
    await page.getByTestId('btn-new-folder').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').fill('章节');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    const child = page.getByTestId('resource-entry').filter({ hasText: '章节' });
    await child.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await child.getByRole('button', { name: '更多操作 · 章节' }).click();
    await page.getByRole('menuitem', { name: '文件夹颜色', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '绿色', exact: true }).click();
    await child.locator('[data-folder-color="green"]').waitFor();
    await page.screenshot({ path: path.join(shots, 'folder-color-mobile.png'), animations: 'disabled' });

    // Local/offline mode uses the same picker and the same resource folder, without a Bot or backend.
    const local = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    await local.addInitScript(() => {
      window.loadTestModule = path => {
        const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
        return import(entry?.name ?? path);
      };
    });
    await local.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
    await local.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    const localPage = await local.newPage();
    localPage.on('pageerror', error => errors.push(error.message));
    await localPage.goto(origin);
    await localPage.getByTestId('chat-go-import').click();
    const localPicker = localPage.getByTestId('chat-project-picker');
    await localPicker.getByRole('textbox', { name: '项目名称', exact: true }).fill('本地学习');
    await localPicker.getByTestId('chat-project-create').click();
    await localPicker.waitFor({ state: 'hidden' });
    assert.equal(await localPage.getByTestId('chat-go-import').innerText(), '本地学习');
    await localPage.getByTestId('chat-go-import').click();
    await localPicker.getByRole('button', { name: '本地学习', exact: true }).waitFor();
    await localPage.screenshot({ path: path.join(shots, 'project-picker-mobile.png'), animations: 'disabled' });
    await localPicker.getByRole('button', { name: '取消', exact: true }).click();
    const scope = await localPage.evaluate(async () => {
      const { db } = await window.loadTestModule('/src/store/db.ts');
      const { useCourseChat } = await window.loadTestModule('/src/store/courseChat.ts');
      const { createLibraryAssistantExecutor } = await window.loadTestModule('/src/harness/libraryAssistant.ts');
      const folderId = useCourseChat.getState().project.folderId;
      const child = await db.folders.add({ name: '项目子文件夹', parentId: folderId, createdAt: Date.now() });
      const other = await db.folders.add({ name: '其他项目', createdAt: Date.now() });
      const makeCourse = (id, folderId) => ({ id, name: id, folderId, createdAt: Date.now(), size: 0, mimeType: 'video/mp4', duration: 10, status: 'transcribed' });
      await db.videos.bulkAdd([...Array.from({ length: 7 }, (_, i) => makeCourse(`project-${i}`, folderId)), makeCourse('nested-project', child), makeCourse('outside-project', other)]);
      await db.segments.bulkAdd(['project-0', 'nested-project', 'outside-project'].map((videoId, idx) => ({ videoId, idx, start: 0, end: 1, status: 1, text: `共同关键词 ${videoId}` })));
      const execute = createLibraryAssistantExecutor({ projectFolderId: folderId });
      return {
        listing: await execute('list_courses', {}),
        search: await execute('search_course_library', { query: '共同关键词' }),
        all: await execute('search_course_library', { query: '共同关键词', scope: 'all' }),
        missing: await createLibraryAssistantExecutor({ projectFolderId: 999999 })('search_course_library', { query: '共同关键词' }),
      };
    });
    assert.ok(scope.listing.includes('project-6') && scope.listing.includes('nested-project') && !scope.listing.includes('outside-project'));
    assert.ok(scope.search.includes('nested-project') && scope.search.includes('project-0') && !scope.search.includes('outside-project'));
    assert.ok(scope.all.includes('outside-project'), 'explicit whole-library searches remain available');
    assert.ok(!scope.missing.includes('outside-project'), 'a missing project never silently expands search');
    await localPage.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true }).fill('本地项目测试');
    await localPage.getByTestId('chat-send').click();
    await localPage.getByTestId('chat-import-strip').waitFor({ state: 'hidden' });
    await localPage.reload();
    await localPage.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true }).waitFor();
    assert.equal(await localPage.getByTestId('chat-import-strip').count(), 0);
    await localPage.getByTestId('chat-add').click();
    await localPage.getByTestId('chat-select-project').click();
    await localPicker.getByRole('button', { name: '本地学习', exact: true }).waitFor();
    assert.equal(await localPicker.getByRole('button', { name: '本地学习', exact: true }).getAttribute('aria-pressed'), 'true');
    await localPicker.getByRole('button', { name: '取消', exact: true }).click();
    await localPage.evaluate(() => { location.hash = '#/library'; });
    await localPage.getByText('项目：本地学习', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: cloud/local project creation, real prefixed folders, association/collapse/reload, project switching, nested project search without a five-course cap, desktop/mobile persistent folder colors.');
  }
} catch (error) {
  if (debugPage) {
    console.error(await debugPage.locator('body').ariaSnapshot());
    console.error('Browser errors:', errors);
    await debugPage.screenshot({ path: path.join(shots, 'failure.png') });
  }
  throw error;
} finally {
  await browser?.close(); await vite?.close(); await api.close(); fs.rmSync(directory, { recursive: true, force: true });
}
