import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-cloud-e2e-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret'), FILES_DIR: path.join(directory, 'files') });
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
Object.assign(process.env, { PUBLIC_ORIGIN: `http://localhost:${port}`, WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_RP_NAME: 'Cloud Test' });
let courseId;
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (_url, init) => {
  const payload = JSON.parse(init.body);
  await new Promise(r => setTimeout(r, 1500));
  if (payload.stream && payload.messages.some(m => m.role === 'user' && String(m.content).includes('追问测试')) && !payload.messages.some(m => m.role === 'tool')) {
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'ask-test', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '请选择接下来的学习主题', type: 'text' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (payload.stream && payload.messages.some(m => m.role === 'user' && String(m.content).includes('审批修改')) && !payload.messages.some(m => m.role === 'tool')) {
    const revoked = payload.messages.some(m => String(m.content).includes('撤销测试'));
    const argumentsJSON = JSON.stringify({ path: `/courses/${courseId}/material`, edits: [{ old_string: revoked ? '经过审批后修改的课程。' : '跨设备学习记录与字幕讲义。', new_string: revoked ? '禁止写入这段内容。' : '经过审批后修改的课程。' }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'edit-test', type: 'function', function: { name: 'edit', arguments: argumentsJSON } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  const answer = payload.messages.some(m => JSON.stringify(m.content).includes('跨设备课程问答')) ? '另一台设备提交的课程问答已完成。' : '云端执行完成，网页关闭后继续运行。';
  if (payload.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '云端回复' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
} });
let browser;
try {
  await app.listen({ host: '127.0.0.1', port });
  const origin = process.env.PUBLIC_ORIGIN;
  browser = await chromium.launch();
  const a = await browser.newContext({ serviceWorkers: 'block' });
  const b = await browser.newContext({ serviceWorkers: 'block' });
  let page = await a.newPage();
  const authenticator = async page => {
    const client = await page.context().newCDPSession(page);
    await client.send('WebAuthn.enable');
    const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    return { client, authenticatorId };
  };
  const passkeyA = await authenticator(page);
  page.on('pageerror', error => console.error('PAGE:', error.message));
  await page.goto(`${origin}/#/setup`);
  const legacySettings = JSON.stringify({ state: { contextWindow: 65536 }, version: 3 });
  await page.evaluate(async settings => {
    localStorage.setItem('wangke-settings', settings);
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('wangke');
      request.onupgradeneeded = () => {
        for (const table of ['videos', 'files', 'chats', 'chatSessions']) request.result.createObjectStore(table, { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['videos', 'files', 'chats', 'chatSessions'], 'readwrite');
        tx.objectStore('videos').put({ id: 'legacy-md', name: '旧版课程.md', kind: 'material', materialFormat: 'md', status: 'ready', coverState: 'skipped', createdAt: 1, size: 12 });
        tx.objectStore('files').put({ id: 'legacy-md', blob: new Blob(['旧版课程正文'], { type: 'text/markdown' }) });
        tx.objectStore('files').put({ id: 'legacy-attachment', blob: new Blob(['旧聊天附件'], { type: 'text/plain' }) });
        tx.objectStore('chatSessions').put({ id: 42, videoId: '', title: '旧聊天', createdAt: 1 });
        tx.objectStore('chats').put({ id: 43, sessionId: 42, videoId: '', role: 'user', content: '旧问题', createdAt: 1, attachments: [{ id: 'legacy-attachment', storage: 'local', name: 'notes.txt' }] });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
  }, legacySettings);
  await page.getByLabel('一次性初始化密钥', { exact: true }).fill(fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim());
  await page.getByLabel('账号', { exact: true }).fill('CloudTest');
  await page.getByLabel('密码', { exact: true }).fill('test-password-12345');
  await page.getByRole('button', { name: '创建管理员', exact: true }).click();
  await page.getByRole('heading', { name: '配置个人云端' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '添加模型服务', exact: true }).click();
  await page.getByLabel('API 地址', { exact: true }).fill('https://model.example/v1');
  await page.getByLabel('API Key', { exact: true }).fill('test-secret');
  await page.getByLabel('llmModel 服务', { exact: true }).selectOption({ label: '模型服务' });
  await page.getByLabel('llmModel 模型 ID', { exact: true }).fill('test-model');
  await page.getByRole('button', { name: '保存服务器配置', exact: true }).click();
  await page.getByText('服务器配置已保存', { exact: true }).waitFor();
  assert.ok(!(await (await a.request.get(`${origin}/api/v1/cloud/config`)).text()).includes('test-secret'));
  assert.equal(await page.evaluate(() => localStorage.getItem('wangke-settings')), legacySettings, 'cloud login preserves legacy settings');
  await page.getByRole('button', { name: '导入旧版浏览器数据', exact: true }).click();
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  await page.getByText('本机数据导入完成', { exact: true }).waitFor({ timeout: 30000 });
  const attachment = (await (await a.request.get(`${origin}/api/v1/cloud/record?table=files&key=%22legacy-attachment%22`)).json()).value;
  assert.equal(await (await a.request.get(`${origin}/api/v1/files/${attachment.blob.$file}`)).text(), '旧聊天附件');
  await page.getByRole('button', { name: '添加当前设备 Passkey', exact: true }).click();
  await page.getByText('Passkey 已添加', { exact: true }).waitFor();
  const credentials = (await passkeyA.client.send('WebAuthn.getCredentials', { authenticatorId: passkeyA.authenticatorId })).credentials;
  assert.equal(credentials.length, 1);
  await page.getByRole('button', { name: '进入课程', exact: true }).click();
  await page.goto(`${origin}/#/library`);
  await page.getByTestId('import-input').setInputFiles({ name: '云端课程.md', mimeType: 'text/markdown', buffer: Buffer.from('# 云端课程\n\n跨设备学习记录与字幕讲义。') });
  const until = async (fn, description) => {
    for (let i = 0; i < 160; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 500)); }
    console.error(await (await a.request.get(`${origin}/api/v1/cloud/tasks`)).text());
    throw new Error(`Timed out: ${description}`);
  };
  await until(async () => {
    const response = await a.request.get(`${origin}/api/v1/cloud/tasks`);
    return (await response.json()).tasks.some(t => t.kind === 'material' && t.status === 'completed');
  }, 'server material parser');
  courseId = (await (await a.request.get(`${origin}/api/v1/cloud/records`)).json()).records.find(r => r.table === 'videos' && r.value?.name === '云端课程').key;
  const second = await b.newPage();
  const passkeyB = await authenticator(second);
  await passkeyB.client.send('WebAuthn.addCredential', { authenticatorId: passkeyB.authenticatorId, credential: credentials[0] });
  await second.goto(`${origin}/#/library`);
  await second.getByLabel('账号', { exact: true }).fill('CloudTest');
  await second.getByLabel('密码', { exact: true }).fill('test-password-12345');
  await second.getByRole('button', { name: '登录', exact: true }).click();
  await second.getByText('云端课程.md', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.goto(`${origin}/#/chat`);
  const textarea = page.locator('textarea').first();
  await textarea.fill('请验证后台任务');
  await textarea.press('Enter');
  let chat;
  await until(async () => { const data = await (await a.request.get(`${origin}/api/v1/cloud/tasks`)).json(); chat = data.tasks.find(t => t.kind === 'chat'); return !!chat; }, 'chat submitted');
  await page.close();
  await until(async () => {
    const task = await (await a.request.get(`${origin}/api/v1/cloud/tasks/${chat.id}`)).json();
    if (task.status === 'failed') { console.error(task); throw new Error(task.error); }
    return task.status === 'completed';
  }, 'chat finishes after originating tab closes');
  await second.goto(`${origin}/#/chat`);
  await second.getByText('请验证后台任务', { exact: true }).first().click();
  try { await second.getByText('云端执行完成，网页关闭后继续运行。', { exact: false }).first().waitFor({ timeout: 30000 }); }
  catch (e) { console.error('TASK', await (await a.request.get(`${origin}/api/v1/cloud/tasks/${chat.id}`)).text()); console.error('PAGE', await second.locator('body').innerText()); throw e; }
  const sessionId = chat.input.sessionId;
  // A fresh session keeps the mock's tool envelope independent of the first turn.
  const editSessionId = sessionId + 1;
  await a.request.post(`${origin}/api/v1/cloud/records`, { data: { mutations: [{ id: crypto.randomUUID(), table: 'chatSessions', key: editSessionId, before: null, after: { id: editSessionId, videoId: '', title: '审批测试', createdAt: Date.now() } }] } });
  const editTask = await (await a.request.post(`${origin}/api/v1/cloud/tasks`, { data: { nonce: crypto.randomUUID(), kind: 'chat', resource: `session:${editSessionId}`, input: { sessionId: editSessionId, text: '审批修改课程', attachments: [] } } })).json();
  let approval;
  await until(async () => { approval = (await (await a.request.get(`${origin}/api/v1/cloud/permissions`)).json()).permissions.find(p => p.taskId === editTask.id && p.status === 'pending'); return approval; }, 'edit awaiting approval');
  assert.equal(approval.capability, 'write');
  assert.ok(approval.arguments.includes('经过审批后修改的课程'));
  const resolved = await a.request.post(`${origin}/api/v1/cloud/permissions/${approval.id}/resolve`, { data: { approved: true } });
  assert.equal(resolved.status(), 200);
  await until(async () => {
    const task = await (await a.request.get(`${origin}/api/v1/cloud/tasks/${editTask.id}`)).json();
    if (task.status === 'failed') { console.error(JSON.stringify(task)); console.error(await (await a.request.get(`${origin}/api/v1/cloud/permissions`)).text()); throw new Error(task.error); }
    return task.status === 'completed';
  }, 'approved edit completed');
  const fileRecord = (await (await a.request.get(`${origin}/api/v1/cloud/record?table=files&key=${encodeURIComponent(JSON.stringify(courseId))}`)).json()).value;
  if (!fileRecord) console.error('EDIT', await (await a.request.get(`${origin}/api/v1/cloud/tasks/${editTask.id}`)).text());
  const editedText = await (await a.request.get(`${origin}/api/v1/files/${fileRecord?.blob.$file}`)).text();
  if (!editedText.includes('经过审批后修改的课程')) console.error('EDIT', await (await a.request.get(`${origin}/api/v1/cloud/tasks/${editTask.id}`)).text());
  assert.ok(editedText.includes('经过审批后修改的课程'));
  assert.equal((await a.request.post(`${origin}/api/v1/cloud/permissions/${approval.id}/resolve`, { data: { approved: true } })).status(), 409);
  const makeSession = async (id, videoId = '') => {
    const response = await a.request.post(`${origin}/api/v1/cloud/records`, { data: { mutations: [{ id: crypto.randomUUID(), table: 'chatSessions', key: id, before: null, after: { id, videoId, title: '云端交互测试', createdAt: Date.now() } }] } });
    assert.equal(response.status(), 200);
  };
  const submit = async (kind, input) => (await a.request.post(`${origin}/api/v1/cloud/tasks`, { data: { nonce: crypto.randomUUID(), kind, resource: `session:${input.sessionId}`, input } })).json();
  await makeSession(editSessionId + 1, courseId);
  await second.goto(`${origin}/#/player/${courseId}`);
  await second.reload();
  await second.getByRole('button', { name: '打开学习助手', exact: true }).click();
  await second.locator('textarea').first().waitFor();
  const qa = await submit('qa', { sessionId: editSessionId + 1, videoId: courseId, text: '跨设备课程问答', materialKind: 'para', materialFormat: 'md' });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${qa.id}`)).json()).status === 'completed', 'QA completes');
  try { await second.getByText('另一台设备提交的课程问答已完成。', { exact: false }).first().waitFor({ timeout: 30000 }); }
  catch (error) { console.error('QA', await (await a.request.get(`${origin}/api/v1/cloud/tasks/${qa.id}`)).text(), await second.locator('body').innerText()); throw error; }
  await makeSession(editSessionId + 2);
  const asking = await submit('chat', { sessionId: editSessionId + 2, text: '追问测试', attachments: [] });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${asking.id}`)).json()).progress?.view?.pendingAsk, 'waiting for question answer');
  assert.equal((await b.request.post(`${origin}/api/v1/cloud/tasks/${asking.id}/commands`, { data: { nonce: crypto.randomUUID(), action: 'answerAsk', value: '继续学习数学' } })).status(), 200);
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${asking.id}`)).json()).status === 'completed', 'question resumes from another device');
  await makeSession(editSessionId + 3);
  const cancelled = await submit('chat', { sessionId: editSessionId + 3, text: '追问测试', attachments: [] });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${cancelled.id}`)).json()).status === 'waiting_user', 'task awaits before cancellation');
  await b.request.post(`${origin}/api/v1/cloud/tasks/${cancelled.id}/cancel`);
  assert.equal((await (await a.request.get(`${origin}/api/v1/cloud/tasks/${cancelled.id}`)).json()).status, 'cancelled');
  await makeSession(editSessionId + 4);
  const revoked = await submit('chat', { sessionId: editSessionId + 4, text: '审批修改课程，撤销测试', attachments: [] });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/permissions`)).json()).permissions.some(p => p.taskId === revoked.id && p.status === 'pending'), 'pending permission before policy revocation');
  const policyConfig = await (await a.request.get(`${origin}/api/v1/cloud/config`)).json();
  await a.request.put(`${origin}/api/v1/cloud/config`, { data: { ...policyConfig, policy: { ...policyConfig.policy, write: 'deny' } } });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${revoked.id}`)).json()).status === 'completed', 'policy revocation terminates approval wait');
  const unchanged = (await (await a.request.get(`${origin}/api/v1/cloud/record?table=files&key=${encodeURIComponent(JSON.stringify(courseId))}`)).json()).value;
  assert.equal(unchanged.blob.$file, fileRecord.blob.$file);
  await a.request.put(`${origin}/api/v1/cloud/config`, { data: policyConfig });
  await second.goto(`${origin}/#/settings/models`);
  await second.getByRole('button', { name: '退出登录', exact: true }).click();
  await second.getByRole('heading', { name: '登录网课云端' }).waitFor();
  assert.equal(await second.getByText('云端课程.md', { exact: true }).count(), 0);
  await second.getByRole('button', { name: '使用 Passkey 登录', exact: true }).click();
  await second.getByRole('button', { name: '退出登录', exact: true }).waitFor({ timeout: 30000 });
  await second.setViewportSize({ width: 390, height: 844 });
  assert.equal(await second.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile settings fit viewport');
  // Exercise server-side video decoding/Canvas as well as document parsing.
  const video = await second.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#174d70'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#ffffff'; ctx.font = '32px sans-serif'; ctx.fillText('Cloud video', 40, 100);
    const stream = canvas.captureStream(10), recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }), chunks = [];
    const done = new Promise(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = resolve; });
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 1200)); recorder.stop(); await done;
    stream.getTracks().forEach(track => track.stop());
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  const uploaded = await a.request.post(`${origin}/api/v1/files`, { headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'sample.webm', 'x-file-mime': 'video/webm' }, data: Buffer.from(video) });
  assert.equal(uploaded.status(), 201);
  const videoFile = await uploaded.json(), videoId = crypto.randomUUID();
  await a.request.post(`${origin}/api/v1/cloud/records`, { data: { mutations: [
    { id: crypto.randomUUID(), table: 'videos', key: videoId, before: null, after: { id: videoId, name: 'Video decoder test', kind: 'video', duration: 1, status: 'transcribed', createdAt: Date.now(), size: video.length } },
    { id: crypto.randomUUID(), table: 'courseFiles', key: videoId, before: null, after: { id: videoId, fileId: videoFile.id, mimeType: 'video/webm', size: video.length, directory: 'videos' } },
  ] } });
  const cover = await submit('cover', { videoId });
  await until(async () => {
    const task = await (await a.request.get(`${origin}/api/v1/cloud/tasks/${cover.id}`)).json();
    if (task.status === 'failed') throw new Error(task.error);
    return task.status === 'completed';
  }, 'server video cover generation');
  const coverRecord = (await (await a.request.get(`${origin}/api/v1/cloud/record?table=covers&key=${encodeURIComponent(JSON.stringify(videoId))}`)).json()).value;
  assert.ok(coverRecord?.blob.$file, 'server video decoding produced a persisted cover');
  console.log('Cloud e2e: setup, legacy data/attachments, Passkey, encrypted config, server document/video processing, two-device QA, background chat, one-shot editing/revocation, question resume, cancellation, mobile settings and logout isolation passed');
} finally {
  await browser?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true });
}
