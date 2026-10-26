// Real ask_user suspension + TurnResume, fake model and isolated browser data only.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const shots = new URL('../e2e-shots/', import.meta.url);
await mkdir(shots, { recursive: true });
const html = `<section id="visual-route"><fieldset class="wbw-options"><legend>对比学习路线</legend>
<label class="wbw-choice"><input type="radio" name="route" value="short">15 分钟回顾</label>
<label class="wbw-choice"><input type="radio" name="route" value="deep">45 分钟练习</label></fieldset>
<button id="submit" type="button">提交路线</button><button id="invalid" type="button">测试无效答案</button><output></output>
<script>(()=>{const api=window.__wbw,root=document.querySelector('#visual-route');root.dataset.run=String(Math.random());
const answer=(ids)=>({status:'answered',mode:'selection',selectedIds:ids,selectedLabels:['FORGED_LABEL'],text:'',note:'每天 45 分钟'});
const status=root.querySelector('output');
function restore(){root.querySelectorAll('input').forEach(el=>{el.checked=api.answerInput?.answer?.selectedIds?.includes(el.value)||false;el.disabled=api.answerInput?.submitted||false;});root.querySelector('#submit').disabled=api.answerInput?.submitted||false;}
root.onchange=()=>api.setAnswerDraft(answer([root.querySelector(':checked').value])).catch(e=>status.textContent=e.message);
root.querySelector('#submit').onclick=()=>api.submitAnswer(answer([root.querySelector(':checked')?.value||'deep'])).then(()=>status.textContent='已确认').catch(e=>status.textContent=e.message);
root.querySelector('#invalid').onclick=()=>api.submitAnswer(answer(['fake'])).catch(e=>status.textContent=e.message);
api.submitAnswer(answer(['deep'])).catch(()=>{});
restore();window.addEventListener('wbw:answerchange',restore);})();</script></section>`;
const ask = { question: '你想选择哪条学习路线？', type: 'multiple', minSelections: 1, maxSelections: 2,
  options: [{ id: 'short', label: '快速回顾' }, { id: 'deep', label: '深入练习' }], presentation: { html } };
const sse = (delta, finish_reason = 'stop') => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=MacAppCodeSignClone'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const requests = [];
  await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await context.addInitScript(() => {
    if (window.top !== window) return;
    if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: {
      theme: 'light', uiLanguage: 'zh-CN', providers: [{ id: 'test', name: 'Test', baseUrl: 'https://ask-visual.test/v1', apiKey: 'fake-key', serves: ['chat'], catalogId: '' }],
      llmModel: { providerId: 'test', model: 'fake-model' },
    } }));
    window.__askImport = path => {
      const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
  });
  await context.route('https://ask-visual.test/**', route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'ask-visual-call'))
      return route.fulfill({ contentType: 'text/event-stream', body: sse({ role: 'assistant', content: '已收到真实路线答案，继续安排学习。' }) });
    return route.fulfill({ contentType: 'text/event-stream', body: sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'ask-visual-call', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(ask) } }] }, 'tool_calls') });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(BASE);
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).fill('请让我选择学习路线');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).press('Enter');
  const frame = () => page.getByTestId('widget-frame').contentFrame();
  await frame().getByRole('button', { name: '提交路线' }).waitFor();
  assert.equal(await page.getByTestId('ask-visual-confirm').count(), 0, 'load cannot submit');
  await page.evaluate(() => window.postMessage({ __wbw: 'wbw:answer-submit', payload: { requestId: 900, value: { status: 'answered', mode: 'selection', selectedIds: ['deep'], selectedLabels: [], text: '', note: '' } } }, '*'));
  assert.equal(await page.getByTestId('ask-visual-confirm').count(), 0, 'wrong window/origin cannot submit');
  await frame().getByRole('button', { name: '测试无效答案' }).click();
  await frame().locator('output').filter({ hasText: '选项 ID 无效、重复或超过数量上限' }).waitFor();
  assert.equal(await page.getByTestId('ask-visual-confirm').count(), 0);
  await frame().getByRole('radio', { name: '45 分钟练习' }).check();
  await page.getByRole('checkbox', { name: '深入练习' }).check();
  // The native input and visual input share the same canonical draft.
  assert.equal(await frame().getByRole('radio', { name: '45 分钟练习' }).isChecked(), true);
  const run = await frame().locator('section').getAttribute('data-run');
  await page.evaluate(async () => (await window.__askImport('/src/store/settings.ts')).useSettings.getState().update({ theme: 'dark' }));
  await frame().locator('html[data-wbw-theme="dark"]').waitFor();
  assert.equal(await frame().locator('section').getAttribute('data-run'), run);
  await frame().getByRole('button', { name: '提交路线' }).click();
  await page.getByTestId('ask-visual-confirm').waitFor();
  assert.ok((await page.getByTestId('ask-visual-confirm').innerText()).includes('深入练习'));
  assert.ok(!(await page.getByTestId('ask-visual-confirm').innerText()).includes('FORGED_LABEL'));
  await page.getByRole('button', { name: '继续修改', exact: true }).click();
  assert.equal(requests.length, 1, 'cancel does not resume model');
  await page.waitForFunction(async () => {
    const { useCourseChat } = await window.__askImport('/src/store/courseChat.ts');
    const { db } = await window.__askImport('/src/store/db.ts');
    return (await db.chats.where('sessionId').equals(useCourseChat.getState().activeId).toArray()).some(row => row.resume?.toolName === 'ask_user');
  });
  const sessionId = await page.evaluate(async () => (await window.__askImport('/src/store/courseChat.ts')).useCourseChat.getState().activeId);
  await page.reload();
  await page.waitForFunction(async () => (await window.__askImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async id => (await window.__askImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), sessionId);
  await page.getByTestId('ask-restored').waitFor();
  await frame().getByRole('radio', { name: '45 分钟练习' }).check();
  await page.setViewportSize({ width: 320, height: 780 });
  await frame().getByRole('button', { name: '提交路线' }).click();
  await page.getByTestId('ask-visual-confirm').waitFor();
  await page.screenshot({ path: new URL('ask-visual-confirm-mobile.png', shots).pathname });
  await page.getByRole('button', { name: '确认回答', exact: true }).click();
  await page.getByText('已收到真实路线答案，继续安排学习。', { exact: true }).waitFor();
  assert.equal(requests.length, 2, 'the original tool resumes once, no new prompt');
  const tool = requests[1].messages.find(message => message.role === 'tool' && message.tool_call_id === 'ask-visual-call');
  assert.equal(JSON.parse(tool.content).selectedLabels[0], '深入练习');
  assert.equal(JSON.parse(tool.content).selectedIds[0], 'deep');
  const saved = await page.evaluate(async id => (await window.__askImport('/src/store/db.ts')).db.chats.where('sessionId').equals(id).toArray(), sessionId);
  assert.equal(saved.find(row => row.ask)?.ask.answer.selectedIds[0], 'deep');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.reload();
  await page.waitForFunction(async () => (await window.__askImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async id => (await window.__askImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), sessionId);
  await frame().getByRole('radio', { name: '45 分钟练习' }).waitFor();
  assert.equal(await frame().getByRole('radio', { name: '45 分钟练习' }).isChecked(), true);
  assert.equal(await frame().getByRole('button', { name: '提交路线' }).isDisabled(), true);
  await page.screenshot({ path: new URL('ask-visual-answered-mobile.png', shots).pathname });
  // Native fallback is not a second answer source: it resumes the same tool.
  await page.evaluate(async () => (await window.__askImport('/src/store/courseChat.ts')).useCourseChat.getState().createSession());
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).fill('再次选择路线');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).press('Enter');
  await frame().getByRole('button', { name: '提交路线' }).waitFor();
  await page.getByRole('checkbox', { name: '快速回顾' }).focus();
  await page.getByRole('checkbox', { name: '快速回顾' }).press('Space');
  await frame().getByRole('radio', { name: '15 分钟回顾' }).waitFor();
  assert.equal(await frame().getByRole('radio', { name: '15 分钟回顾' }).isChecked(), true, 'native changes synchronize visual draft');
  await page.getByRole('button', { name: '提交选择', exact: true }).click();
  await page.getByText('已收到真实路线答案，继续安排学习。', { exact: true }).waitFor();
  assert.equal(requests.length, 4);
  const nativeResult = requests[3].messages.find(message => message.role === 'tool' && message.tool_call_id === 'ask-visual-call');
  assert.deepEqual(JSON.parse(nativeResult.content).selectedIds, ['short']);
  // Stopping while host confirmation is open invalidates its pending receipt.
  await page.evaluate(async () => (await window.__askImport('/src/store/courseChat.ts')).useCourseChat.getState().createSession());
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).fill('停止前的路线问题');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).press('Enter');
  await frame().getByRole('button', { name: '提交路线' }).click();
  await page.getByTestId('ask-visual-confirm').waitFor();
  await page.evaluate(async () => (await window.__askImport('/src/store/courseChat.ts')).useCourseChat.getState().stop());
  await page.getByTestId('ask-visual-confirm').waitFor({ state: 'detached' });
  assert.equal(requests.length, 5, 'stopped question cannot resume or spend another request');
  await page.getByTestId('ask-card-expired').waitFor();
  console.log('PASS: real ask_user visual draft, trusted canonical confirmation/cancel, theme retention, refresh TurnResume, one original tool result, answered replay and 320px.');
} finally { await browser.close(); }
