#!/usr/bin/env node
// 真客户端 / 路由 / 历史准备 + 假网关：无需 API Key，无外部网络。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'fake-indexeddb/auto';
import { unzipSync, strFromU8 } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = join(tmpdir(), 'opencode');
mkdirSync(scratch, { recursive: true });
const out = mkdtempSync(join(scratch, 'jev-test-'));
let passed = 0;
const failures = [];
const originalFetch = globalThis.fetch;
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: (key) => memory.delete(key),
};
// zustand v5 的浏览器存储从 window.localStorage 读取。
globalThis.window = globalThis;
async function test(name, run) {
  try { await run(); passed++; console.log(`  ok - ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL - ${name}\n${error.stack}`); }
}

try {
  const entry = join(out, 'entry.ts');
  writeFileSync(entry, `
    export * from '${join(root, 'src/api/typesafe.ts')}';
    export * from '${join(root, 'src/harness/jevContext.ts')}';
    export { fitHistoryToBudget } from '${join(root, 'src/harness/context.ts')}';
    export * from '${join(root, 'src/store/contextCompression.ts')}';
    export { routeSkillsWithJev } from '${join(root, 'src/skills/jevRoute.ts')}';
    export { routeHandoutSkills } from '${join(root, 'src/skills/router.ts')}';
    export { loadEnabledSkillMeta } from '${join(root, 'src/skills/store.ts')}';
    export { useSettings, getSettings, defaultJevSettings, migrateSettings, decisionConfigOf } from '${join(root, 'src/store/settings.ts')}';
    export { editModelPatch, modelsForSlot, suggestedModelSlots } from '${join(root, 'src/store/modelLibrary.ts')}';
    export { refreshModelMeta, parseModelMeta } from '${join(root, 'src/api/modelMeta.ts')}';
    export { pickSyncSettings } from '${join(root, 'src/sync/units.ts')}';
    export { exportMigrationZip } from '${join(root, 'src/store/migration.ts')}';
    export { db } from '${join(root, 'src/store/db.ts')}';
  `);
  await build({ entryPoints: [entry], outfile: join(out, 'bundle.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', loader: { '.md': 'text' } });
  const api = await import(pathToFileURL(join(out, 'bundle.mjs')).href);
  const config = { ...api.defaultJevSettings(), apiKey: 'jev-secret', skillRouting: true, contextCompression: true };
  const question = { type: 'noul', instructions: 'Is this relevant?' };
  let seen;
  const serve = (answer = () => 0.1) => {
    seen = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url: String(url), init, body });
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: answer(id, body) }])) });
    };
  };
  const history = (n = 8, size = 700) => Array.from({ length: n }, (_, i) => [
    { id: i * 2, role: 'user', content: `question ${i}: ${'课程'.repeat(size)}` },
    { id: i * 2 + 1, role: 'assistant', content: `answer ${i}: ${'材料'.repeat(size)}` },
  ]).flat();

  await test('专用端点、Bearer、固定模型、去尾斜杠，不混入生成参数', async () => {
    serve(() => 0.87);
    const result = await api.evaluateNouls({ ...config, baseUrl: 'https://api.typesafe.ai/v1///' }, { state: 'hello', questions: { check: question } });
    assert.equal(result.check, 0.87);
    assert.equal(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer jev-secret');
    assert.equal(seen[0].init.redirect, 'error');
    assert.deepEqual(Object.keys(seen[0].body).sort(), ['model', 'questions', 'state']);
    assert.equal(seen[0].body.model, 'jev-1.13.0');
  });
  await test('缺失、字符串、NaN、越界概率均拒绝', async () => {
    for (const value of [undefined, '0.9', null, -0.1, 1.1]) {
      serve(() => value);
      await assert.rejects(api.evaluateNouls(config, { state: '', questions: { check: question } }), /无效/);
    }
    globalThis.fetch = async () => Response.json({ answers: {} });
    await assert.rejects(api.evaluateNouls(config, { state: '', questions: { check: question } }), /无效/);
  });
  await test('请求字节数 / 问题数量 / HTTP 地址 / 空 Key 均在出网前检查', async () => {
    serve();
    for (const [cfg, request] of [
      [config, { state: '中'.repeat(24_000), questions: { check: question } }],
      [config, { state: '', questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, question])) }],
      [{ ...config, baseUrl: 'http://remote.test/v1' }, { state: '', questions: { check: question } }],
      [{ ...config, apiKey: '' }, { state: '', questions: { check: question } }],
    ]) await assert.rejects(api.evaluateNouls(cfg, request));
    assert.equal(seen.length, 0);
  });
  await test('超时与取消都能终止请求', async () => {
    globalThis.fetch = async (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    await assert.rejects(api.evaluateNouls(config, { state: '', questions: { check: question } }, { timeoutMs: 5 }), /超时/);
    const controller = new AbortController();
    const pending = api.evaluateNouls(config, { state: '', questions: { check: question } }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  });

  const skills = [{ id: 1, name: 'formal', description: '公文讲义' }, { id: 2, name: 'math', description: '数学公式' }];
  await test('技能路由支持多选、全不选，不确定回退而不是猜测', async () => {
    serve((id) => id === 'skill_1' ? 0.9 : 0.1);
    assert.deepEqual(await api.routeSkillsWithJev(config, skills, '课程', '字幕'), new Set([1]));
    serve(() => 0.99);
    assert.deepEqual(await api.routeSkillsWithJev(config, skills, '课程', '字幕'), new Set([1, 2]));
    serve(() => 0.01);
    assert.deepEqual(await api.routeSkillsWithJev(config, skills, '课程', '字幕'), new Set());
    serve(() => 0.6);
    assert.equal(await api.routeSkillsWithJev(config, skills, '课程', '字幕'), null);
  });
  await test('技能路由关闭不出网，接口失败回退', async () => {
    serve();
    assert.equal(await api.routeSkillsWithJev({ ...config, skillRouting: false }, skills, '', ''), null);
    assert.equal(seen.length, 0);
    globalThis.fetch = async () => new Response('', { status: 429 });
    assert.equal(await api.routeSkillsWithJev(config, skills, '', ''), null);
  });

  await test('压缩只删除高概率旧轮次，保留最近两轮、原顺序、对象与源数据', async () => {
    const rows = history();
    const snapshot = structuredClone(rows);
    let omitted = 0;
    serve((id) => id === 'turn_1' ? 0.99 : 0.6);
    const result = await api.prepareHistoryWithJev(rows, 50_000, '现在的问题', config, { force: true, onCompressed: (n) => omitted = n });
    assert.deepEqual(result, rows.filter((_, i) => i !== 2 && i !== 3));
    assert.equal(result[0], rows[0]);
    assert.deepEqual(rows, snapshot);
    assert.equal(omitted, 1);
    for (const { body } of seen) {
      assert.equal(body.questions.turn_6, undefined);
      assert.equal(body.questions.turn_7, undefined);
      assert.equal(body.state.current_request, '现在的问题');
      assert.equal(body.state.latest_turns.length, 4);
      assert.equal(body.state.older_turns[0].messages[0].id, undefined, '仅发送文本，不发送数据库元数据');
    }
  });
  await test('预算裁剪按整轮，语义筛选能让更早的重要轮次留下来', async () => {
    const rows = history(8, 500);
    const budget = 6000;
    serve((id) => ['turn_1', 'turn_2', 'turn_3', 'turn_4'].includes(id) ? 0.99 : 0.01);
    const result = await api.prepareHistoryWithJev(rows, budget, '继续', config);
    assert.equal(api.fitHistoryToBudget(rows, budget).includes(rows[0]), false);
    assert.equal(result.includes(rows[0]), true);
    assert.ok(result.every((row, i) => row.role === (i % 2 === 0 ? 'user' : 'assistant')));
  });
  await test('不确定 / 429 / 畸形响应时保持原有预算裁剪', async () => {
    const rows = history();
    const expected = api.fitHistoryToBudget(rows, 8000);
    serve(() => 0.94);
    assert.deepEqual(await api.prepareHistoryWithJev(rows, 8000, '问题', config), expected);
    globalThis.fetch = async () => new Response('', { status: 429 });
    assert.deepEqual(await api.prepareHistoryWithJev(rows, 8000, '问题', config), expected);
    globalThis.fetch = async () => Response.json({ answers: {} });
    assert.deepEqual(await api.prepareHistoryWithJev(rows, 8000, '问题', config), expected);
  });
  await test('关闭、短对话、最近两轮超预算、工具链均不出网', async () => {
    serve(() => 0.99);
    const rows = history();
    await api.prepareHistoryWithJev(rows, 8000, '问题', { ...config, contextCompression: false });
    await api.prepareHistoryWithJev(history(3, 10), 8000, '问题', config);
    await api.prepareHistoryWithJev(rows, 1000, '问题', config);
    await api.prepareHistoryWithJev([...rows, { role: 'tool', content: 'tool result' }], 50_000, '问题', config);
    await api.prepareHistoryWithJev([...rows, { role: 'assistant', content: 'call', tool_calls: [{}] }], 50_000, '问题', config);
    assert.equal(seen.length, 0);
  });
  await test('中断 / 挂起的旧轮次不参与语义删除', async () => {
    serve(() => 0.99);
    const rows = history();
    rows[1].interrupted = true;
    rows[3].resume = { toolName: 'ask_user' };
    const result = await api.prepareHistoryWithJev(rows, 50_000, '问题', config, { force: true });
    assert.ok(result.includes(rows[0]) && result.includes(rows[1]));
    assert.ok(result.includes(rows[2]) && result.includes(rows[3]));
    for (const { body } of seen) {
      assert.equal(body.questions.turn_0, undefined);
      assert.equal(body.questions.turn_1, undefined);
    }
  });
  await test('大历史分批有上限，超大轮次保留且不截断发送', async () => {
    serve(() => 0.99);
    const rows = history(40, 800);
    rows[20].content = '中'.repeat(30_000);
    const result = await api.prepareHistoryWithJev(rows, 300_000, '问题', config, { force: true });
    assert.ok(seen.length > 0 && seen.length <= 4);
    assert.ok(result.includes(rows[20]));
    for (const { body } of seen) assert.ok(new TextEncoder().encode(JSON.stringify(body)).length <= api.JEV_REQUEST_BYTES);
    assert.ok(result.includes(rows[0]), '检查范围外的历史不被 Jev 删除');
  });
  await test('压缩阶段按停止不触发失败回退，也不继续问答', async () => {
    const controller = new AbortController();
    globalThis.fetch = async (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    const pending = api.prepareHistoryWithJev(history(), 50_000, '问题', config, { force: true, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  });

  await test('只有达到真实历史预算才自动压缩，手动可绕过门槛', async () => {
    serve(() => 0.99);
    const rows = history();
    await api.prepareSessionHistory(100, rows, 50_000, '问题', config);
    assert.equal(seen.length, 0);
    await api.prepareSessionHistory(100, rows, 50_000, '问题', config, { force: true });
    assert.ok(seen.length > 0);
    assert.equal(api.useContextCompressionStore.getState().sessions[100].phase, 'success');
    serve(() => 0.99);
    await api.prepareSessionHistory(101, rows, 8000, '问题', config);
    assert.ok(seen.length > 0);
  });
  await test('手动压缩计划被后续发送与 UI 复用，不删除原行、不跨会话', async () => {
    serve((id) => id === 'turn_1' ? 0.99 : 0.01);
    const rows = history();
    const snapshot = structuredClone(rows);
    await api.prepareSessionHistory(102, rows, 50_000, '问题', config, { force: true });
    const plan = api.useContextCompressionStore.getState().sessions[102];
    const effective = api.retainedContext(rows, plan);
    assert.equal(effective.length, rows.length - 2);
    const count = seen.length;
    assert.deepEqual(await api.prepareSessionHistory(102, rows, 50_000, '接着说', config), effective);
    assert.equal(seen.length, count);
    assert.deepEqual(rows, snapshot);
    assert.deepEqual(await api.prepareSessionHistory(103, rows, 50_000, '问题', config), rows);
    const uiRows = rows.map(({ id, role, content }) => ({ rowId: id, role: role === 'assistant' ? 'ai' : role, content }));
    assert.equal(api.retainedContext(uiRows, plan).length, effective.length);
    assert.deepEqual(await api.prepareSessionHistory(102, rows, 50_000, '问题', { ...config, contextCompression: false }), rows);
  });
  await test('历史编辑、重试后保护最近两轮，不沿用失效的旧选择', async () => {
    const plan = api.useContextCompressionStore.getState().sessions[102];
    const rows = history();
    rows[2].content = '内容已经编辑';
    assert.ok(api.retainedContext(rows, plan).includes(rows[2]));
    assert.deepEqual(api.retainedContext(rows.slice(0, 4), plan), rows.slice(0, 4));
    assert.deepEqual(api.retainedContext(rows.slice(2, 4), plan), rows.slice(2, 4));
  });
  await test('失败 / 无可压缩项不冒充成功，自动重试不会形成循环', async () => {
    serve(() => 0.94);
    const rows = history();
    await api.prepareSessionHistory(104, rows, 8000, '问题', config);
    assert.equal(api.useContextCompressionStore.getState().sessions[104].phase, 'unchanged');
    const count = seen.length;
    await api.prepareSessionHistory(104, rows, 8000, '问题', config);
    assert.equal(seen.length, count);
    globalThis.fetch = async () => new Response('', { status: 503 });
    await api.prepareSessionHistory(105, rows, 8000, '问题', config);
    const state = api.useContextCompressionStore.getState().sessions[105];
    assert.equal(state.phase, 'error');
    assert.equal(state.omitted.size, 0);
  });
  await test('同会话的压缩与发送串行，等待期间能停止，其他会话不受影响', async () => {
    const rows = history();
    const controller = new AbortController();
    globalThis.fetch = async (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    const manual = api.prepareSessionHistory(106, rows, 50_000, '问题', config, { force: true, signal: controller.signal });
    assert.equal(api.useContextCompressionStore.getState().sessions[106].phase, 'compressing');
    const waiting = new AbortController();
    const send = api.prepareSessionHistory(106, rows, 50_000, '问题', config, { signal: waiting.signal });
    waiting.abort();
    await assert.rejects(send, (error) => error.name === 'AbortError');
    serve(() => 0.99);
    await api.prepareSessionHistory(107, rows, 50_000, '问题', config, { force: true });
    assert.equal(api.useContextCompressionStore.getState().sessions[107].phase, 'success');
    controller.abort();
    await assert.rejects(manual, (error) => error.name === 'AbortError');
    assert.equal(api.useContextCompressionStore.getState().sessions[106].phase, 'idle');
  });

  await test('旧设置补默认值且不自动启用；读取副本不污染凭据', async () => {
    assert.deepEqual(api.migrateSettings({ apiKey: 'old-key' }, 1).jev, { skillRouting: false, contextCompression: false });
    const initial = api.getSettings();
    const { decisionModel: unused, ...legacy } = initial;
    const migrated = api.migrateSettings({ ...legacy, jev: config }, 3);
    api.useSettings.setState(migrated);
    assert.deepEqual(migrated.jev, { skillRouting: true, contextCompression: true });
    assert.equal(api.decisionConfigOf(migrated).apiKey, 'jev-secret');
    assert.equal(migrated.providers.length, initial.providers.length + 1);
    assert.deepEqual(api.migrateSettings(migrated, 3), migrated, '重复迁移不新增连接或模型');
    const copied = api.getSettings();
    copied.providers.find((p) => p.id === copied.decisionModel.providerId).apiKey = 'changed';
    assert.equal(api.decisionConfigOf(api.getSettings()).apiKey, 'jev-secret');
    memory.set('wangke-settings', JSON.stringify({ version: 3, state: { ...legacy, jev: { apiKey: 'local-only' } } }));
    await api.useSettings.persist.rehydrate();
    assert.equal(api.decisionConfigOf(api.getSettings()).apiKey, 'local-only');
    assert.deepEqual(api.getSettings().jev, { skillRouting: false, contextCompression: false });
    api.useSettings.setState(migrated);
  });
  await test('全类型目录、决策用途和协议确认，不按文本模态误当聊天模型', async () => {
    let catalogUrl;
    globalThis.fetch = async (url) => {
      catalogUrl = String(url);
      return Response.json({ test: { models: { decision: { type: 'decision', modalities: { input: ['text'], output: ['text'] }, limit: { context: 64000, output: 0 } } } } });
    };
    await api.refreshModelMeta();
    assert.ok(catalogUrl.endsWith('?type=all'));
    assert.deepEqual(api.suggestedModelSlots('test', 'decision'), ['decision']);
    const settings = api.getSettings();
    const draft = { providerId: settings.providers[0].id, model: 'new-decision', name: '', slots: ['decision'] };
    assert.throws(() => api.editModelPatch(settings, null, draft), /协议/);
    assert.throws(() => api.editModelPatch(settings, null, { ...draft, slots: ['decision', 'chat'], decisionProtocol: 'typesafe-systemone' }), /混用/);
    assert.throws(() => api.editModelPatch(settings, null, { ...draft, decisionProtocol: 'typesafe-systemone', decisionBaseUrl: 'https://host.test/v1?key=secret' }), /地址/);
    const patch = api.editModelPatch(settings, null, { ...draft, decisionProtocol: 'typesafe-systemone', maxOutputTokens: 0 });
    assert.equal(api.modelsForSlot({ ...settings, ...patch }, 'decision').length, 2);
    assert.equal(api.parseModelMeta({ type: 'decision', limit: { output: 0 } }).declaredOutput, 0);
  });
  await test('决策槽位按模型端点取供应商 Key；切换目标关闭授权，删除供应商不回退聊天', async () => {
    const settings = api.getSettings();
    const selected = settings.savedModels.find((m) => m.modelType === 'decision');
    const patch = api.editModelPatch(settings, selected, { ...selected, decisionBaseUrl: 'https://decision.test/v1' });
    api.useSettings.getState().update(patch);
    assert.deepEqual(api.getSettings().jev, { skillRouting: false, contextCompression: false });
    assert.equal(api.decisionConfigOf(api.getSettings()).baseUrl, 'https://decision.test/v1');
    assert.equal(api.decisionConfigOf(api.getSettings()).apiKey, 'jev-secret');
    assert.equal(api.decisionConfigOf({ ...settings, providers: [] }).apiKey, '');
    assert.equal(api.decisionConfigOf({ ...settings, savedModels: [{ ...selected, decisionProtocol: undefined }] }).apiKey, '');
    api.useSettings.getState().update({ decisionModel: { providerId: '', model: '' } });
    assert.equal(api.decisionConfigOf(api.getSettings()).model, '');
    api.useSettings.setState(settings);
  });
  await test('真实讲义路由保留 pin / drop 覆盖，Jev 失败退回 LLM', async () => {
    await api.loadEnabledSkillMeta();
    await api.db.skills.toCollection().modify({ enabled: 0 });
    const one = await api.db.skills.add({ name: 'one', description: '技能一', body: '正文一', enabled: 1, updatedAt: Date.now() });
    const two = await api.db.skills.add({ name: 'two', description: '技能二', body: '正文二', enabled: 1, updatedAt: Date.now() });
    await api.db.videos.put({ id: 'jev-test', name: '课程', skillOverride: { pin: [one], drop: [two] } });
    serve((id) => id === `skill_${two}` ? 0.99 : 0.01);
    const routed = await api.routeHandoutSkills('jev-test', '课程', '字幕');
    assert.ok(seen.length > 0, '真实路由必须使用决策槽位');
    assert.deepEqual(routed.selected.map((skill) => skill.id), [one]);
    const settings = api.getSettings();
    api.useSettings.getState().update({ providers: settings.providers.map((p) => ({ ...p, apiKey: 'llm-key' })) });
    api.useSettings.getState().update({ jev: { skillRouting: true, contextCompression: true } });
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/systemone')) return new Response('', { status: 503 });
      return Response.json({ choices: [{ message: { role: 'assistant', content: '{"skills":["two"]}' } }] });
    };
    await api.routeHandoutSkills('jev-test', '课程', '字幕');
    assert.ok(calls.some((url) => url.endsWith('/systemone')));
    assert.ok(calls.some((url) => url.endsWith('/chat/completions')));
  });
  await test('Jev 配置与 Key 不进入同步载荷或迁移包', async () => {
    const synced = JSON.stringify(api.pickSyncSettings(api.getSettings()));
    assert.ok(!synced.includes('jev-secret') && !synced.includes('"jev"'));
    const zip = await api.exportMigrationZip();
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    const settings = strFromU8(files['settings.json']);
    assert.ok(!settings.includes('jev-secret') && !settings.includes('"jev"'));
    await api.db.delete();
  });
} finally {
  globalThis.fetch = originalFetch;
  rmSync(out, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
