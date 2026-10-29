import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { FOLDER_SPRING_OPEN_MS } from '../apps/web/src/ui/interactionTiming.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-resource-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let vite, browser, page;
const errors = [];
const screenshots = process.env.SCREENSHOT_DIR ?? path.resolve('test-results/resource-folders');
fs.mkdirSync(screenshots, { recursive: true });
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  let r = await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'resource-ui-password' } });
  assert.equal(r.statusCode, 201);
  r = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'resource-ui-password' } });
  const cookie = r.headers['set-cookie'].split(';')[0];
  const call = async (method, url, payload) => {
    const result = await api.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });
    assert.ok(result.statusCode < 300, result.body); return result.json();
  };
  const config = await call('GET', '/cloud/config');
  await call('PUT', '/cloud/config', { ...config, providers: [{ id: 'offline', name: 'Offline', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'test-only', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'offline', model: 'test' }, visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' }, decisionModel: { providerId: '', model: '' } });
  await call('POST', '/cloud/records', { mutations: [{ id: 'language', table: 'preferences', key: 'uiLanguage', before: null, after: { id: 'uiLanguage', value: 'zh-CN' } }] });
  const recentSession = { id: 91001, videoId: '__library_assistant__', title: '最近的学习对话', createdAt: Date.now() };
  await call('POST', '/cloud/records', { mutations: [
    { id: 'recent-session', table: 'chatSessions', key: recentSession.id, before: null, after: recentSession },
    { id: 'recent-message', table: 'chats', key: 91001, before: null, after: { id: 91001, sessionId: recentSession.id, videoId: recentSession.videoId, role: 'user', content: '资源页也能继续这段对话', createdAt: recentSession.createdAt } },
  ] });
  const fixture = await call('POST', '/resources/folders', { name: '设计资料' });
  await call('PUT', `/projects/${fixture.id}/text?path=${encodeURIComponent('笔记.txt')}`, { text: '人和 Bot 读写同一份文件。', expectedRevision: null });
  await call('PUT', `/projects/${fixture.id}/text?path=${encodeURIComponent('资料.md')}`, { text: '# 学习资料\n\nMarkdown 继续使用原来的封面文件样式。', expectedRevision: null });
  await call('PUT', `/projects/${fixture.id}/text?path=${encodeURIComponent('空白.markdown')}`, { text: '', expectedRevision: null });
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { host: '127.0.0.1', port: process.env.RESOURCE_PREVIEW ? 5189 : 0 }, plugins: [{
    name: 'resource-test-login',
    configureServer(server) {
      // Local fixture only: enter a disposable account, before Vite's SPA fallback.
      server.middlewares.use('/__fixture_login', (_req, res) => {
        res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.writeHead(302, { location: '/#/library' }); res.end();
      });
    },
  }] });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  if (process.env.RESOURCE_PREVIEW) {
    console.log(`RESOURCE_PREVIEW ${origin}/__fixture_login DATA_DIR=${directory}`);
    await new Promise(resolve => process.once('SIGTERM', resolve));
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/__fixture_login`);
    await page.getByTestId('resource-list').waitFor({ timeout: 60000 });
    await page.getByTestId('chat-recent-91001').waitFor();
    await page.evaluate(() => { window.resourceSidebar = document.querySelector('[data-testid="nav-rail"]'); });
    await page.getByTestId('chat-recent-91001').click();
    await page.getByTestId('course-chat-messages').getByText('资源页也能继续这段对话', { exact: true }).waitFor();
    await page.getByTestId('nav-rail-chat').click();
    assert.equal(await page.getByTestId('page-title').innerText(), '主页');
    await page.getByTestId('nav-rail-home').click();
    await page.getByTestId('resource-list').waitFor();
    assert.equal(await page.evaluate(() => window.resourceSidebar === document.querySelector('[data-testid="nav-rail"]')), true,
      'cloud resource/home/history share one persistent sidebar');
    await page.getByTestId('chat-recent-91001').waitFor();
    assert.equal(await page.getByTestId('nav-rail-projects').count(), 0);
    await page.getByTestId('btn-new-folder').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').fill('真实文件夹');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByTestId('resource-entry').filter({ hasText: '真实文件夹' }).waitFor();
    const created = (await call('GET', '/resources')).entries.find(e => e.name === '真实文件夹');
    assert.ok(fs.statSync(path.join(directory, 'files', created.scope.workspacePath)).isDirectory());
    await page.getByTestId('resource-entry').filter({ hasText: '设计资料' }).locator('.resource-open').click();
    const material = page.getByTestId('resource-entry').filter({ hasText: '资料.md' });
    const cover = material.locator('.finder-document img');
    await cover.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.finder-document img')].length === 2 && [...document.querySelectorAll('.finder-document img')].every(img => img.complete && img.naturalWidth > 0));
    assert.equal(await material.locator('.finder-file-extension').innerText(), 'MD');
    assert.equal(await page.getByTestId('resource-entry').filter({ hasText: '空白.markdown' }).locator('.finder-file-extension').innerText(), 'MD', 'long Markdown extensions use the original compact badge');
    assert.equal(await material.locator('.finder-document').evaluate(el => getComputedStyle(el).width), '74px', 'restore the original document shape');
    const originalCover = await cover.getAttribute('src');
    await page.getByRole('button', { name: '切换显示方式' }).click();
    assert.equal(await material.locator('.finder-document').evaluate(el => getComputedStyle(el).width), '18px', 'list view keeps a compact document thumbnail');
    await page.getByRole('button', { name: '切换显示方式' }).click();
    const note = page.getByTestId('resource-entry').filter({ hasText: '笔记.txt' });
    await note.locator('.resource-open').click();
    await dialog.locator('textarea').fill('界面保存到真实磁盘，Bot 可以直接读取。');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const physical = path.join(directory, 'files', fixture.workspacePath);
    assert.equal(fs.readFileSync(path.join(physical, '笔记.txt'), 'utf8'), '界面保存到真实磁盘，Bot 可以直接读取。');
    fs.writeFileSync(path.join(physical, '资料.md'), '# 更新后的资料封面\n\n文件变化后重新生成。');
    await page.waitForFunction(old => {
      const tile = [...document.querySelectorAll('[data-testid="resource-entry"]')].find(el => el.textContent.includes('资料.md'));
      const img = tile?.querySelector('.finder-document img');
      return img?.src !== old && img?.complete && img?.naturalWidth > 0;
    }, originalCover, { timeout: 15000 });
    fs.writeFileSync(path.join(physical, 'Bot 创建的文件.txt'), 'Bot direct filesystem output');
    await page.getByTestId('resource-entry').filter({ hasText: 'Bot 创建的文件.txt' }).waitFor({ timeout: 15000 });
    await page.locator('input[type=file]').setInputFiles({ name: '上传.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded') });
    await page.getByTestId('resource-entry').filter({ hasText: '上传.txt' }).waitFor();
    assert.equal(fs.readFileSync(path.join(physical, '上传.txt'), 'utf8'), 'uploaded');
    await page.getByTestId('btn-new-folder').click();
    await dialog.locator('input').fill('子文件夹');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByTestId('resource-entry').filter({ hasText: '子文件夹' }).waitFor();
    assert.ok(fs.statSync(path.join(physical, '子文件夹')).isDirectory());
    assert.equal(await page.locator('[data-testid="resource-entry"] > .resource-open > :is(svg, .resource-file-icon)').count(), await page.getByTestId('resource-entry').count(), 'all files and folders have a visible icon');

    // Existing click menus must retain their keyboard/focus and pointer-leave behavior.
    const more = page.getByRole('button', { name: '更多操作', exact: true });
    await more.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menu').waitFor();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole('menu').isVisible(), true, 'click menu does not close on pointer leave');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem');
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.equal(await more.evaluate(el => el === document.activeElement), true, 'Escape restores focus to the anchor');
    await more.click();
    await page.getByRole('menu').waitFor();
    // React Aria makes the background inert while open; hit-test a real outside
    // point rather than asking Playwright to click through the dismiss layer.
    const titleBox = await page.locator('.finder-title').boundingBox();
    await page.mouse.click(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
    await page.getByRole('menu').waitFor({ state: 'hidden' });

    await call('POST', `/projects/${fixture.id}/directories?path=${encodeURIComponent('子文件夹/深层')}`);
    await page.evaluate(() => {
      window.resourceDragEvents = [];
      for (const name of ['dragstart', 'dragenter', 'dragover', 'dragleave', 'dragend', 'drop']) {
        window.addEventListener(name, event => {
          const row = event.target.closest?.('.resource-tile');
          const record = { name, row: row?.querySelector('.resource-open > span:last-of-type')?.textContent, types: [...event.dataTransfer.types], x: event.clientX, y: event.clientY };
          window.resourceDragEvents.push(record);
          if (window.resourceDragEvents.length > 80) window.resourceDragEvents.shift();
        }, true);
      }
    });
    const originalDirectoryUrl = page.url();
    const tile = name => page.locator('[data-testid="resource-entry"]:not([data-drag-retained])').filter({ has: page.locator('.resource-open > span', { hasText: name }) });
    const hoverDragTarget = async name => {
      const box = await tile(name).boundingBox();
      assert.ok(box, `drag target ${name} exists`);
      await page.mouse.move(box.x + box.width / 2, box.y + 28, { steps: 12 });
      // Chromium's native DnD needs another move after dragenter for dragover.
      await page.mouse.move(box.x + box.width / 2 + 1, box.y + 28);
    };
    const startDrag = async () => {
      const box = await tile('上传.txt').boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + 30);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 14, box.y + 30, { steps: 6 });
      await hoverDragTarget('子文件夹');
      await page.locator('[data-drop-target="true"]').waitFor();
    };
    const waitForPath = p => page.waitForURL(url => new URLSearchParams(url.hash.split('?')[1]).get('path') === p);

    await startDrag();
    await page.mouse.move(5, 5, { steps: 6 });
    await page.waitForTimeout(FOLDER_SPRING_OPEN_MS + 100);
    assert.equal(page.url(), originalDirectoryUrl, 'brief folder hover followed by leaving does not navigate');
    await page.mouse.up();

    await startDrag();
    await waitForPath('子文件夹');
    await tile('深层').waitFor();
    assert.equal(await page.locator('[data-drag-retained="true"]').count(), 1, 'native source survives directory navigation');
    await hoverDragTarget('深层');
    await waitForPath('子文件夹/深层');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForURL(originalDirectoryUrl);
    await tile('上传.txt').waitFor();
    assert.equal(fs.existsSync(path.join(physical, '上传.txt')), true, 'canceling a nested drag never moves the file');
    assert.equal(await page.locator('[data-drag-retained="true"]').count(), 0);

    await startDrag();
    await waitForPath('子文件夹');
    await tile('深层').waitFor();
    await hoverDragTarget('深层');
    await waitForPath('子文件夹/深层');
    await page.getByTestId('resource-list').filter({ has: page.locator('.project-empty') }).waitFor();
    const dropBox = await page.getByTestId('resource-list').boundingBox();
    await page.mouse.move(dropBox.x + dropBox.width - 24, dropBox.y + dropBox.height - 24, { steps: 8 });
    await page.mouse.up();
    await tile('上传.txt').waitFor();
    assert.equal(fs.existsSync(path.join(physical, '上传.txt')), false);
    assert.equal(fs.readFileSync(path.join(physical, '子文件夹/深层/上传.txt'), 'utf8'), 'uploaded', 'native drag can move through two folder levels');
    assert.equal(await page.locator('[data-drag-retained="true"]').count(), 0);
    await page.getByRole('button', { name: '设计资料', exact: true }).click();
    await material.waitFor();

    await page.screenshot({ path: path.join(screenshots, 'resources-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await material.locator('.finder-document').evaluate(el => getComputedStyle(el).width), '60px', 'mobile retains the document shape');
    assert.equal(await cover.evaluate(img => img.complete && img.naturalWidth > 0), true, 'mobile shows the Markdown cover');
    await page.screenshot({ path: path.join(screenshots, 'resources-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile must not overflow');
    await page.getByTestId('resource-entry').filter({ hasText: '子文件夹' }).locator('.resource-open').click();
    await tile('深层').waitFor();
    const markdown = '# 共享 Markdown\n\n阅读器直接读取真实文件。';
    await call('PUT', `/projects/${fixture.id}/text?path=${encodeURIComponent('子文件夹/阅读笔记.md')}`, { text: markdown, expectedRevision: null });
    const indexed = (await call('GET', `/resources?projectId=${fixture.id}&path=${encodeURIComponent('子文件夹')}`)).entries.find(e => e.name === '阅读笔记.md');
    const before = (await call('GET', `/cloud/record?table=videos&key=${encodeURIComponent(JSON.stringify(indexed.courseId))}`)).value;
    await call('POST', '/cloud/records', { mutations: [{ id: 'parsed-markdown', table: 'videos', key: before.id, before, after: { ...before, status: 'transcribed', unitCount: 2 } }] });
    await page.getByTestId('resource-entry').filter({ hasText: '阅读笔记.md' }).locator('.resource-open').click({ timeout: 15000 });
    const reader = page.getByTestId('material-reader');
    await reader.getByText('阅读器直接读取真实文件。', { exact: true }).waitFor();
    const edit = page.getByTestId('md-edit-toggle');
    await edit.click();
    const markdownEditor = page.getByTestId('md-editor').locator('.cm-content');
    const saved = '# 阅读器编辑\n\n界面和 Bot 共用这一份 Markdown。';
    await markdownEditor.fill(saved);
    await edit.click();
    await markdownEditor.waitFor({ state: 'hidden' });
    const markdownPath = path.join(physical, '子文件夹/阅读笔记.md');
    assert.equal(fs.readFileSync(markdownPath, 'utf8'), saved);
    assert.ok((await call('GET', '/cloud/records')).records.some(r => r.table === 'materialBlocks' && r.value?.materialId === indexed.courseId && r.value.text.includes('Bot 共用')));
    const remote = '# Bot 直接写入\n\n阅读器也会自动更新。';
    fs.writeFileSync(markdownPath, remote);
    await reader.getByText('阅读器也会自动更新。', { exact: true }).waitFor({ timeout: 15000 });
    await edit.click();
    const draft = '# 冲突时保留我的草稿';
    await markdownEditor.fill(draft);
    fs.writeFileSync(markdownPath, '# 同时发生的 Bot 修改');
    await edit.click();
    await page.getByTestId('md-save-error').waitFor();
    assert.equal(await markdownEditor.innerText(), draft);
    assert.equal(fs.readFileSync(markdownPath, 'utf8'), '# 同时发生的 Bot 修改');
    await page.reload();
    await reader.getByText('同时发生的 Bot 修改', { exact: true }).waitFor();
    await page.getByTestId('nav-back').click();
    await page.getByTestId('resource-entry').filter({ hasText: '阅读笔记.md' }).waitFor();
    assert.equal(new URLSearchParams(page.url().split('?')[1]).get('path'), '子文件夹', 'reader returns to the original directory, including after reload');
    const resourceToDelete = page.getByTestId('resource-entry').filter({ hasText: '阅读笔记.md' });
    await resourceToDelete.locator('.resource-more').click();
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    const deleteDialog = page.getByTestId('confirm-dialog-danger');
    await deleteDialog.getByRole('button', { name: '删除', exact: true }).click();
    await resourceToDelete.waitFor({ state: 'detached' });
    assert.equal(fs.existsSync(markdownPath), false, 'Resource Library deletion removes the source file');
    assert.equal((await call('GET', `/cloud/record?table=videos&key=${encodeURIComponent(JSON.stringify(indexed.courseId))}`)).value, null, 'Resource Library deletion removes the learning record');
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '导入课程 / B 站视频' }).click();
    await dialog.getByTestId('btn-bili-import').click();
    await page.getByTestId('bili-cancel').click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '导入课程 / B 站视频' }).click();
    const imported = '# 从课程导入流程进入同一目录';
    await page.getByTestId('import-input').setInputFiles({ name: '课程导入.md', mimeType: 'text/markdown', buffer: Buffer.from(imported) });
    await page.getByTestId('resource-entry').filter({ hasText: '课程导入.md' }).waitFor({ timeout: 15000 });
    assert.equal(fs.readFileSync(path.join(physical, '子文件夹/课程导入.md'), 'utf8'), imported);
    await page.goto(`${origin}/#/projects/${fixture.id}/files`);
    await page.getByTestId('resource-entry').filter({ hasText: '笔记.txt' }).waitFor();
    assert.match(page.url(), /library\?folder=/, 'legacy project links open real folders');
    assert.deepEqual(errors, []);
    console.log(`Resource UI: native nested spring drag/drop/cancel, menu keyboard/focus/outside dismissal, desktop/mobile/list Markdown covers and live updates, real mkdir/upload, shared external files, Markdown reader/edit/index/conflicts, directory return, Bilibili import entry, old links and no page errors OK. Screenshots: ${screenshots}`);
  }
} catch (error) {
  if (page && !page.isClosed()) {
    fs.writeFileSync(path.join(screenshots, 'failure.txt'), JSON.stringify({ url: page.url(), errors, dragEvents: await page.evaluate(() => window.resourceDragEvents), text: await page.locator('body').innerText() }, null, 2));
    await page.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close(); await vite?.close(); await api.close();
  if (!process.env.RESOURCE_PREVIEW) fs.rmSync(directory, { recursive: true, force: true });
}
