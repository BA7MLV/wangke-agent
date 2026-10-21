import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Dev-server regression: real UI, skill/resource executor, agent loop and persistence;
// only model responses are mocked. No real API credentials or user data are used.
const base = process.env.BASE_URL || 'http://localhost:5173';
const shots = new URL('../e2e-shots/', import.meta.url);
await mkdir(shots, { recursive: true });
const sse = (delta, finish_reason = 'stop') => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(15000);
const errors = [], requests = [], imageRequests = [];
const handoutText = '# 测试课程讲义\n\n覆盖范围：00:00–01:00。\n\n## 核心概念\n\n核心定义来自课程字幕。[00:00]\n\n## 复习清单\n\n- 区分定义与应用条件。';
const manualText = handoutText.replace('核心定义来自课程字幕', '核心定义已由用户修订') + '\n\n我的笔记：不能被旧聊天覆盖。';
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.context().addInitScript(() => {
    window.__handoutImport = (path) => {
      const entry = performance.getEntriesByType('resource').findLast((e) => new URL(e.name).pathname === path);
      return import(entry?.name ?? path);
    };
    if (localStorage.getItem('wangke-settings')) return;
    localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      theme: 'light', dynamicColor: false,
      providers: [
        { id: 'main', name: 'Text', baseUrl: 'https://handout-main.test/v1', apiKey: 'test', protocol: 'openai-chat', catalogId: '', serves: ['chat'] },
        { id: 'reader', name: 'Reader', baseUrl: 'https://handout-reader.test/v1', apiKey: 'test', protocol: 'openai-chat', catalogId: '', serves: ['vision'] },
      ],
      llmModel: { providerId: 'main', model: 'text-only' }, visionModel: { providerId: '', model: '' },
      savedModels: [
        { providerId: 'main', model: 'text-only', name: '', slots: ['chat'], inputCapabilities: ['text'], toolCalling: true },
        { providerId: 'reader', model: 'image-reader', name: '', slots: ['vision'], inputCapabilities: ['text', 'image'] },
      ],
    } }));
  });
  await page.route('https://models.dev/api.json', (route) => route.fulfill({ json: {
    test: { models: { unused: { modalities: { input: ['text'], output: ['text'] } } } },
  } }));
  await page.route('https://handout-reader.test/**', async (route) => {
    imageRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '截图原文：学习目标与核心定义。' } }] } });
  });
  await page.route('https://handout-main.test/**', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const turn = body.messages.slice(body.messages.findLastIndex((m) => m.role === 'user') + 1);
    const results = turn.filter((m) => m.role === 'tool');
    const path = '/courses/current/handout.md';
    const call = (index, id, name, args) => ({ index, id: `${id}-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    let response;
    if (!results.length) {
      response = sse({ role: 'assistant', tool_calls: [
        call(0, 'skill', 'read', { path: `/skills/${encodeURIComponent('课程讲义')}` }),
        call(1, 'source', 'read', { path: '/courses/current/transcript', start: 0, end: 60 }),
        call(2, 'handout', 'read', { path }),
      ] }, 'tool_calls');
    } else if (!turn.some((m) => m.tool_calls?.some((t) => t.function.name === 'edit'))) {
      const exists = results.some((m) => String(m.content).includes('核心定义已由用户修订'));
      response = sse({ role: 'assistant', tool_calls: [call(0, 'save', 'edit', exists
        ? { path, edits: [{ old_string: '核心定义已由用户修订。[00:00]', new_string: '核心定义已由用户修订。[00:00]\n\n截图原文：学习目标与核心定义。' }] }
        : { path, create: true, content: handoutText })] }, 'tool_calls');
    } else if (results.at(-1).tool_call_id.startsWith('save-')) {
      response = sse({ role: 'assistant', tool_calls: [call(0, 'verify', 'read', { path })] }, 'tool_calls');
    } else {
      const current = String(results.at(-1).content);
      const text = current.split('\n').filter((line) => /^\d+: /.test(line)).map((line) => line.replace(/^\d+: /, '')).join('\n');
      const link = current.split('\n').find((line) => line.startsWith('讲义文件：'));
      response = sse({ role: 'assistant', content: `${text}\n\n已保存，以文件为准。${link}` });
    }
    await route.fulfill({ contentType: 'text/event-stream', body: response });
  });
  await page.goto(`${base}/#/chat`);
  await page.getByTestId('chat-add').waitFor();
  await page.evaluate(async () => {
    const { db } = await window.__handoutImport('/src/store/db.ts');
    const folderId = await db.folders.add({ name: '讲义测试目录', createdAt: Date.now() });
    await db.videos.put({ id: 'handout-test', folderId, name: '测试课程', duration: 60, size: 0, mimeType: 'video/mp4', fileDeleted: 1, createdAt: Date.now(), status: 'transcribed' });
    await db.segments.add({ videoId: 'handout-test', idx: 0, start: 0, end: 60, text: '核心定义来自课程字幕，理解应用条件后再做例题。', status: 1 });
    await db.chatSessions.add({ videoId: 'handout-test', title: '新会话', createdAt: Date.now(), skillIds: [] });
    await db.handouts.add({ videoId: 'handout-test', title: '历史讲义', createdAt: Date.now(), outlineJson: '{}', blob: new Blob(['legacy']) });
  });
  const openCourse = async () => {
    const toggle = page.getByTestId('study-assistant-toggle');
    await toggle.waitFor();
    if (await toggle.getAttribute('aria-label') === '打开学习助手') await toggle.click();
    await page.getByTestId('panel-tab-chat').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="panel-chat-add"]').disabled);
  };
  await page.goto(`${base}/#/player/handout-test`);
  await openCourse();
  assert.equal(await page.getByTestId('panel-tab-handout').count(), 0, 'no standalone handout tab');
  const input = page.getByRole('textbox', { name: '给学习助手发送消息' });
  await input.fill('重点讲解定义');
  await page.getByTestId('panel-chat-add').click();
  await page.getByTestId('handout-prompt').click();
  await page.waitForFunction(() => document.querySelector('[aria-label="给学习助手发送消息"]').value.includes('/skills/'));
  const draft = await input.inputValue();
  assert.ok(draft.includes('重点讲解定义'), 'existing draft survives');
  assert.ok(draft.includes('Markdown'));
  assert.equal(requests.length, 0, 'shortcut only prepares a draft, does not spend tokens');
  const scope = await page.evaluate(async () => {
    const { db } = await window.__handoutImport('/src/store/db.ts');
    const skill = await db.skills.filter((s) => s.name === '课程讲义').first();
    const session = await db.chatSessions.where('videoId').equals('handout-test').first();
    return { actual: session.skillIds, expected: [skill.id] };
  });
  assert.deepEqual(scope.actual, scope.expected, 'explicit shortcut adds only its skill to a restricted session');
  await page.getByTestId('panel-chat-add').click();
  await page.getByTestId('handout-prompt').click();
  assert.equal(await input.inputValue(), draft, 'repeated insertion is idempotent');
  await page.getByTestId('chat-send').click();
  await page.getByRole('heading', { name: '测试课程讲义', exact: true }).waitFor();
  await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
  assert.equal(requests.length, 4);
  assert.ok(requests[1].messages.some((m) => m.role === 'tool' && String(m.content).includes('对话内生成讲义')), 'real skill body was loaded');
  assert.ok(requests[1].messages.some((m) => m.role === 'tool' && String(m.content).includes('核心定义来自课程字幕')), 'existing read tool fetched source');
  assert.equal(imageRequests.length, 0, 'text handouts need no image model calls');
  const stored = await page.evaluate(async () => {
    const { db } = await window.__handoutImport('/src/store/db.ts');
    const { handoutFileOf } = await window.__handoutImport('/src/materials/handoutFile.ts');
    const source = await db.videos.get('handout-test');
    const file = handoutFileOf(source);
    const row = await db.videos.get(file.id);
    return { handouts: await db.handouts.count(), frames: await db.frames.count(), answers: await db.chats.filter((r) => r.role === 'assistant').count(), sameFolder: row.folderId === source.folderId, md: row.materialFormat };
  });
  assert.deepEqual(stored, { handouts: 1, frames: 0, answers: 1, sameFolder: true, md: 'md' }, 'legacy data retained; ordinary Markdown is saved beside source');
  await page.reload();
  await openCourse();
  await page.getByRole('heading', { name: '测试课程讲义', exact: true }).waitFor();

  // Open the saved file in the existing reader/editor. Manual edits, not old chat text, win.
  const openedFile = page.waitForEvent('popup');
  await page.locator('a[href="#/player/__course_handout__handout-test"]').last().click();
  const filePage = await openedFile;
  filePage.on('pageerror', (error) => errors.push(error.message));
  await filePage.getByTestId('md-edit-toggle').click();
  await filePage.locator('.cm-content[contenteditable="true"]').fill(manualText);
  await filePage.getByTestId('md-edit-toggle').click();
  await filePage.waitForFunction(async () => {
    const { getMaterialFile } = await window.__handoutImport('/src/store/fileStore.ts');
    return (await (await getMaterialFile('__course_handout__handout-test')).text()).includes('不能被旧聊天覆盖');
  });
  await filePage.close();
  await page.goto(`${base}/#/player/handout-test`);
  await openCourse();

  // Existing screenshot/crop entry goes through the same vision resolver.
  await page.evaluate(async () => {
    const { useSelectionAsk } = await window.__handoutImport('/src/store/selectionAsk.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const dataUrl = canvas.toDataURL('image/png');
    useSelectionAsk.getState().ask({ text: '引用截图', source: 'subtitle', unitLabel: '00:00', image: { dataUrl, thumb: dataUrl } }, 'compose');
  });
  await input.fill('把截图定义也补入讲义');
  await page.getByTestId('chat-send').click();
  await page.waitForFunction(async () => (await window.__handoutImport('/src/store/db.ts')).db.chats.filter((r) => r.role === 'assistant').count().then((n) => n === 2));
  await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
  assert.equal(imageRequests.length, 1, 'text main automatically uses configured image reader');
  assert.equal(imageRequests[0].model, 'image-reader');
  assert.ok(JSON.stringify(requests.at(-1)).includes('截图原文：学习目标与核心定义'));
  assert.ok(!JSON.stringify(requests.at(-1)).includes('image_url'), 'text main receives image description, not unsupported pixels');
  const latest = await page.evaluate(async () => {
    const { getMaterialFile } = await window.__handoutImport('/src/store/fileStore.ts');
    return (await getMaterialFile('__course_handout__handout-test')).text();
  });
  assert.ok(latest.includes('不能被旧聊天覆盖'));
  assert.ok(latest.includes('核心定义已由用户修订'));
  assert.ok(latest.includes('截图原文：学习目标与核心定义'));
  const openedLatest = page.waitForEvent('popup');
  await page.locator('a[href="#/player/__course_handout__handout-test"]').last().click();
  const latestPage = await openedLatest;
  await latestPage.getByText('我的笔记：不能被旧聊天覆盖。', { exact: true }).waitFor();
  await latestPage.screenshot({ path: new URL('handout-file-source.png', shots).pathname });
  await latestPage.close();

  // Same shortcut in the library assistant, including the empty skill whitelist.
  await page.goto(`${base}/#/chat`);
  await page.getByTestId('chat-add').waitFor();
  await page.evaluate(async () => {
    const { useCourseChat } = await window.__handoutImport('/src/store/courseChat.ts');
    useCourseChat.getState().setSkillIds([]);
    useCourseChat.getState().setDraft('保留课程助手草稿');
  });
  await page.getByTestId('chat-add').click();
  await page.getByTestId('handout-prompt').click();
  const libraryInput = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await page.waitForFunction(() => document.querySelector('[aria-label="给 AI 助手发送消息"]').value.includes('/skills/'));
  assert.ok((await libraryInput.inputValue()).includes('保留课程助手草稿'));
  assert.equal(await page.evaluate(async () => (await window.__handoutImport('/src/store/courseChat.ts')).useCourseChat.getState().skillIds.length), 1);
  await page.evaluate(async () => {
    const { db } = await window.__handoutImport('/src/store/db.ts');
    await db.skills.filter((s) => s.name === '课程讲义').modify({ enabled: 0 });
  });
  const beforeDisabled = await libraryInput.inputValue();
  await page.getByTestId('chat-add').click();
  await page.getByTestId('handout-prompt').click();
  await page.getByText('请先在「设置 → 写作技能」中启用「课程讲义」', { exact: true }).waitFor();
  assert.equal(await libraryInput.inputValue(), beforeDisabled, 'disabled skills never discard drafts');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId('chat-add').click();
  await page.getByTestId('handout-prompt').waitFor();
  const bounds = await page.getByTestId('handout-prompt').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 375, 'shortcut fits mobile menu');
  await page.screenshot({ path: new URL('handout-chat-mobile.png', shots).pathname });
  assert.deepEqual(errors, []);
  console.log('PASS: handout menu, drafts, skill scopes, real read/edit, Markdown source of truth, folder placement, manual edits, vision fallback, legacy data and mobile layout');
} catch (error) {
  await page.screenshot({ path: new URL('handout-chat-error.png', shots).pathname });
  console.error({ url: page.url(), errors, tools: JSON.stringify(requests.at(-1)?.messages.filter((m) => m.role === 'tool').map((m) => ({ id: m.tool_call_id, text: String(m.content).slice(0, 600) }))), text: (await page.locator('body').innerText()).slice(-6000) });
  throw error;
} finally {
  await browser.close();
}
