#!/usr/bin/env node
/**
 * 供应商注册表：模型引用、目标解析、导入合并（纯逻辑，不需要 API key）。
 *
 * 守的是三件事：
 *  1. **模型身份带 provider** —— 同名模型在两家都存在时不能认混；
 *  2. **凭据缺失 / 供应商被删时报人话** —— 这两类都是「去设置里改一下」就能解决的，
 *     报错必须指明是哪一家，而不是旧实现里那句永远指向硅基流动的「请填写 API Key」；
 *  3. **导入不覆盖凭据** —— 迁移包与同步载荷都不带 key，整表替换会把本机 key 清空。
 *
 * 用法：node scripts/test-providers.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// settings.ts 依赖 zustand/middleware（persist 需要 localStorage），Node 里跑不了整包。
// 这里只取纯函数的部分：把下面这些导出经 esbuild 打成一个不带 persist 的小包。
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '.cache');
const entry = join(dir, 'providers-entry.ts');
const outfile = join(dir, 'providers-bundle.mjs');
mkdirSync(dir, { recursive: true });

// zustand 的 persist 中间件在 Node 里会立刻读 localStorage。塞个空实现即可
// （只为了让模块能加载；本文件只测纯函数，不碰 store）。
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
};

{
  const { build } = await import('esbuild');
  writeFileSync(
    entry,
    `import {
       mergeImportedProviders, migrateSettings, nextProviderId, providerOf,
       providersForSlot, sameRef, targetOfSlot, targetOrNull, catalogOf,
       SLOT_LABEL, DEFAULT_MODELS,
     } from '../../src/store/settings.ts';
     export {
       mergeImportedProviders, migrateSettings, nextProviderId, providerOf,
       providersForSlot, sameRef, targetOfSlot, targetOrNull, catalogOf,
       SLOT_LABEL, DEFAULT_MODELS,
     };
    `,
  );
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    // 只需要这些纯函数：把 store 的创建部分与 zustand 一并 tree-shake 掉。
    // external 留着 zustand 也行（Node 装得上），但没被引用的代码不该进包。
    external: ['zustand', 'zustand/middleware'],
  });
}
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const M = await import(outfile);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL - ${name}\n    ${error.message}`);
  }
}

const P = (over = {}) => ({
  id: 'sf',
  name: '硅基流动',
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: 'sk-1',
  serves: ['chat', 'vision', 'asr'],
  catalogId: 'siliconflow-cn',
  ...over,
});

const baseSettings = (over = {}) => ({
  providers: [P(), P({ id: 'or', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-1', serves: ['chat'], catalogId: 'openrouter' })],
  asrModel: { providerId: 'sf', model: 'XingChenAGI/XingChenASR-V3.2-Ultra' },
  llmModel: { providerId: 'or', model: 'deepseek-ai/DeepSeek-V4-Flash' },
  visionModel: { providerId: 'sf', model: 'Qwen/Qwen3.6-35B-A3B' },
  favorites: { chat: [], vision: [], asr: [] },
  ...over,
});

await test('ASR 与文本可以指向不同供应商，各自解析出各自的端点', () => {
  const s = baseSettings();
  const asr = M.targetOfSlot(s, 'asr');
  const chat = M.targetOfSlot(s, 'chat');
  assert.equal(asr.baseUrl, 'https://api.siliconflow.cn/v1');
  assert.equal(asr.apiKey, 'sk-1');
  assert.equal(asr.model, 'XingChenAGI/XingChenASR-V3.2-Ultra');
  assert.equal(asr.catalogId, 'siliconflow-cn');
  assert.equal(chat.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(chat.apiKey, 'or-1');
  assert.equal(chat.catalogId, 'openrouter');
  assert.notEqual(asr.providerId, chat.providerId);
});

await test('端点尾部的斜杠被去掉（拼路径时会出现 //models）', () => {
  const s = baseSettings({
    providers: [P({ baseUrl: 'https://api.siliconflow.cn/v1///' })],
    llmModel: { providerId: 'sf', model: 'm' },
  });
  assert.equal(M.targetOfSlot(s, 'chat').baseUrl, 'https://api.siliconflow.cn/v1');
});

await test('凭据两端的空白被去掉', () => {
  const s = baseSettings({
    providers: [P({ apiKey: '  sk-1  ' })],
    llmModel: { providerId: 'sf', model: 'm' },
  });
  assert.equal(M.targetOfSlot(s, 'chat').apiKey, 'sk-1');
});

await test('key 为空时报错指明是哪一家', () => {
  const s = baseSettings({
    providers: [P({ apiKey: '' })],
    llmModel: { providerId: 'sf', model: 'm' },
  });
  assert.throws(() => M.targetOfSlot(s, 'chat'), (e) => {
    assert.match(e.message, /硅基流动/, '必须点名是哪一家');
    assert.match(e.message, /API Key/);
    return true;
  });
});

await test('供应商被删时报错说清是哪个槽位', () => {
  const s = baseSettings({
    providers: [P({ id: 'or', name: 'OpenRouter' })],
    llmModel: { providerId: 'sf', model: 'm' }, // sf 不在了
  });
  assert.throws(() => M.targetOfSlot(s, 'chat'), (e) => {
    assert.match(e.message, new RegExp(M.SLOT_LABEL.chat));
    assert.match(e.message, /已被删除/);
    return true;
  });
});

await test('ASR 槽位缺 key 时，报错说的是 ASR 而不是笼统的「API Key」', () => {
  const s = baseSettings({
    providers: [P({ apiKey: '' })],
  });
  assert.throws(() => M.targetOfSlot(s, 'asr'), /硅基流动/);
});

await test('targetOrNull 不抛：供应商没了返回 null，供 UI 自行表现', () => {
  const s = baseSettings({ providers: [P({ id: 'or', name: 'OpenRouter' })] });
  assert.equal(M.targetOrNull(s, { providerId: 'sf', model: 'm' }), null);
  assert.equal(M.targetOrNull(s, { providerId: 'or', model: 'm' }).model, 'm');
});

await test('targetOrNull 不校验 key（UI 判断能力不该要求先填 key）', () => {
  const s = baseSettings({ providers: [P({ apiKey: '' })] });
  assert.ok(M.targetOrNull(s, { providerId: 'sf', model: 'm' }));
});

await test('providersForSlot 按手动勾选的能力筛选', () => {
  const s = baseSettings();
  const chat = M.providersForSlot(s, 'chat');
  assert.deepEqual(chat.map((p) => p.id), ['sf', 'or']);
  // OpenRouter 只勾了 chat，ASR 槽位里不该出现
  assert.deepEqual(M.providersForSlot(s, 'asr').map((p) => p.id), ['sf']);
  assert.deepEqual(M.providersForSlot(s, 'vision').map((p) => p.id), ['sf']);
});

await test('一家都不提供某槽位时返回空数组（UI 要能显示「没有可用供应商」）', () => {
  const s = baseSettings({ providers: [P({ id: 'or', name: 'OpenRouter', serves: ['chat'] })] });
  assert.deepEqual(M.providersForSlot(s, 'asr'), []);
});

await test('sameRef 用 provider + model 一起比，同名不同家不算同一个', () => {
  const a = { providerId: 'sf', model: 'Qwen/Qwen3' };
  const b = { providerId: 'or', model: 'Qwen/Qwen3' };
  assert.equal(M.sameRef(a, a), true);
  assert.equal(M.sameRef(a, b), false, '同名模型在两家是不同的引用');
  assert.equal(M.sameRef(a, { providerId: 'sf', model: 'other' }), false);
});

await test('catalogOf：没登记能力数据源时是空串，而不是猜一个', () => {
  assert.equal(M.catalogOf(baseSettings(), 'sf'), 'siliconflow-cn');
  assert.equal(M.catalogOf(baseSettings(), 'or'), 'openrouter');
  assert.equal(M.catalogOf(baseSettings(), 'gone'), '');
});

await test('nextProviderId 不与现有 id 撞车', () => {
  // 'sf' 是预置供应商的 id，不在候选短名里 —— 新建的那家永远不会是 sf
  assert.equal(M.nextProviderId({ providers: [] }), 'or');
  assert.equal(M.nextProviderId({ providers: [P({ id: 'sf' }), P({ id: 'or' })] }), 'dm');
  assert.equal(M.nextProviderId({ providers: [P({ id: 'sf' }), P({ id: 'or' }), P({ id: 'dm' })] }), 'pp');
  // 短名全占满后退到 p2 / p3…，仍不撞
  const many = ['or', 'dm', 'pp', 'kk', 'xf', 'ali', 'gt', 'nb'].map((id) => P({ id }));
  assert.equal(M.nextProviderId({ providers: many }), 'p2');
  assert.equal(M.nextProviderId({ providers: [...many, P({ id: 'p2' })] }), 'p3');
});

await test('导入时按 id 合并，凭据只从本机取', () => {
  const local = [P({ apiKey: 'sk-local-1' }), P({ id: 'or', name: 'OpenRouter', apiKey: 'or-local', serves: ['chat'] })];
  const incoming = [
    // 包里没有 apiKey
    { id: 'sf', name: '硅基流动（改过名）', baseUrl: 'https://api.siliconflow.cn/v1/', serves: ['chat'], catalogId: 'siliconflow-cn' },
    { id: 'nb', name: 'NaN', baseUrl: 'https://api.nomic.ai/v1', serves: ['chat'], catalogId: 'nomic' },
  ];
  const out = M.mergeImportedProviders(local, incoming);
  assert.equal(out.length, 3);
  // 非凭据字段取包里的
  assert.equal(out[0].name, '硅基流动（改过名）');
  assert.deepEqual(out[0].serves, ['chat']);
  // 凭据只从本机取（包外那家 key 为空，等用户填）
  assert.equal(out[0].apiKey, 'sk-local-1');
  assert.equal(out[1].apiKey, 'or-local');
  assert.equal(out[2].apiKey, '');
});

await test('导入时忽略包里的 apiKey（老包里可能有凭据）', () => {
  const local = [P({ apiKey: 'sk-local' })];
  const out = M.mergeImportedProviders(local, [{ id: 'sf', apiKey: 'sk-from-package' }]);
  assert.equal(out[0].apiKey, 'sk-local');
});

await test('导入不删除本机多出来的供应商', () => {
  const local = [P({ id: 'sf' }), P({ id: 'or', name: 'OpenRouter' })];
  const out = M.mergeImportedProviders(local, [{ id: 'sf' }]);
  assert.deepEqual(out.map((p) => p.id), ['sf', 'or']);
});

await test('导入时不修改本机对象（返回值是新引用）', () => {
  const local = [P({ apiKey: 'sk-local', serves: ['chat'] })];
  const snapshot = JSON.stringify(local);
  const out = M.mergeImportedProviders(local, [{ id: 'sf', name: 'X' }]);
  out[0].serves.push('asr');
  assert.equal(JSON.stringify(local), snapshot);
  assert.notEqual(out[0], local[0]);
  assert.notEqual(out[0].serves, local[0].serves);
});

await test('导入载荷缺字段时回落到本机值（老包只有部分字段）', () => {
  const local = [P({ apiKey: 'k', name: '本地名', baseUrl: 'https://local/v1', catalogId: 'sf-cn' })];
  const out = M.mergeImportedProviders(local, [{ id: 'sf' }]);
  assert.equal(out[0].name, '本地名');
  assert.equal(out[0].baseUrl, 'https://local/v1');
  assert.equal(out[0].catalogId, 'sf-cn');
});

await test('导入载荷里非法的 serves 值被过滤掉', () => {
  const out = M.mergeImportedProviders([], [{ id: 'x', serves: ['chat', 'ASR', 'embed', 42] }]);
  assert.deepEqual(out[0].serves, ['chat']);
});

await test('导入载荷里没有 serves 时沿用本机的', () => {
  const out = M.mergeImportedProviders([P({ serves: ['chat', 'asr'] })], [{ id: 'sf' }]);
  assert.deepEqual(out[0].serves, ['chat', 'asr']);
});

// ── v1 → v2 迁移 ────────────────────────────────────────────────────────────
//
// 老用户升级的路径。这组用例特别钉两件事：
//  1. 凭据从顶层搬进 providers 后**不能还留在顶层**（那等于多一份副本）；
//  2. 旧包缺字段时不能变成 undefined（zustand persist 是浅合并，undefined 会覆盖默认值）。

await test('v1 的顶层 apiKey / baseUrl 搬进预置供应商', () => {
  const out = M.migrateSettings(
    { apiKey: 'sk-old', baseUrl: 'https://old.example.com/v1' },
    1,
  );
  assert.equal(out.providers.length, 1);
  assert.equal(out.providers[0].apiKey, 'sk-old');
  assert.equal(out.providers[0].baseUrl, 'https://old.example.com/v1');
  assert.deepEqual(out.providers[0].serves, ['chat', 'vision', 'asr']);
  assert.equal(out.providers[0].catalogId, 'siliconflow-cn');
  assert.equal('apiKey' in out, false, '顶层不该残留 apiKey');
  assert.equal('baseUrl' in out, false, '顶层不该残留 baseUrl');
});

await test('v1 的裸模型 id 变成带供应商的引用', () => {
  const out = M.migrateSettings(
    {
      apiKey: 'sk-old',
      asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra',
      llmModel: 'deepseek-ai/DeepSeek-V4-Flash',
      visionModel: 'Qwen/Qwen3.6-35B-A3B',
    },
    1,
  );
  const pid = out.providers[0].id;
  assert.deepEqual(out.asrModel, { providerId: pid, model: 'XingChenAGI/XingChenASR-V3.2-Ultra' });
  assert.deepEqual(out.llmModel, { providerId: pid, model: 'deepseek-ai/DeepSeek-V4-Flash' });
  assert.deepEqual(out.visionModel, { providerId: pid, model: 'Qwen/Qwen3.6-35B-A3B' });
  // 迁移后的配置立刻能用：目标解析得出端点
  assert.equal(M.targetOfSlot(out, 'chat').model, 'deepseek-ai/DeepSeek-V4-Flash');
});

await test('v1 的收藏夹（字符串数组）变成引用数组，空串被丢掉', () => {
  const out = M.migrateSettings(
    { apiKey: 'k', favorites: { chat: ['a', '', 'b'], vision: [], asr: ['c'] } },
    1,
  );
  const pid = out.providers[0].id;
  assert.deepEqual(out.favorites.chat, [
    { providerId: pid, model: 'a' },
    { providerId: pid, model: 'b' },
  ]);
  assert.deepEqual(out.favorites.asr, [{ providerId: pid, model: 'c' }]);
  assert.deepEqual(out.favorites.vision, []);
});

await test('v1 迁移后没丢用户改过的其它设置', () => {
  const out = M.migrateSettings(
    {
      apiKey: 'k',
      asrConcurrency: 9,
      theme: 'dark',
      thinkingEnabled: true,
      thinkingEffort: 'max',
      agentRounds: 20,
      customRates: [1.25, 3.5],
      studyIdleMinutes: 12,
      contextWindow: 262144,
      captionScale: 1.7,
      bilibiliCookie: 'SESSDATA=x',
    },
    1,
  );
  assert.equal(out.asrConcurrency, 9);
  assert.equal(out.theme, 'dark');
  assert.equal(out.thinkingEnabled, true);
  assert.equal(out.thinkingEffort, 'max');
  assert.equal(out.agentRounds, 20);
  assert.deepEqual(out.customRates, [1.25, 3.5]);
  assert.equal(out.studyIdleMinutes, 12);
  assert.equal(out.contextWindow, 262144);
  assert.equal(out.captionScale, 1.7);
  assert.equal(out.bilibiliCookie, 'SESSDATA=x');
});

await test('v1 迁移：旧包缺字段时拿到默认值，而不是 undefined', () => {
  // zustand persist 的 migrate 返回值会浅合并到初始 state；返回 undefined 会**覆盖**默认值
  const out = M.migrateSettings({ apiKey: 'k' }, 1);
  for (const k of [
    'contextWindow',
    'asrConcurrency',
    'thinkingEffort',
    'agentRounds',
    'customRates',
    'theme',
    'studyIdleMinutes',
    'syncEndpoint',
    'syncToken',
  ]) {
    assert.notEqual(out[k], undefined, `${k} 不该是 undefined`);
  }
  assert.ok(Array.isArray(out.customRates));
  // 模型没给就用默认值
  assert.equal(out.llmModel.model, M.DEFAULT_MODELS.llmModel);
});

await test('v0 → v1 的旧默认视觉模型仍会被换新（迁移顺序不能倒）', () => {
  // 历史链条：v0 的默认视觉模型是 Qwen3-VL-32B-Instruct，v1 起改成 Qwen3.6-35B-A3B。
  // v1→v2 的迁移必须**顺带**做这件事，所以 migrate 里对 version < 1 才有那个分支。
  const out = M.migrateSettings({ apiKey: 'k', visionModel: 'Qwen/Qwen3-VL-32B-Instruct' }, 0);
  assert.equal(out.visionModel.model, M.DEFAULT_MODELS.visionModel);
  // 用户自己填的同名之外的模型不动
  const kept = M.migrateSettings({ apiKey: 'k', visionModel: 'user/own' }, 0);
  assert.equal(kept.visionModel.model, 'user/own');
});

await test('迁移出的凭据两端空白被去掉（老包里可能有换行）', () => {
  const out = M.migrateSettings({ apiKey: '  sk-old\n', baseUrl: '  https://x/v1  ' }, 1);
  assert.equal(out.providers[0].apiKey, 'sk-old');
  assert.equal(out.providers[0].baseUrl, 'https://x/v1');
});

await test('迁移时 baseUrl 为空串则回落到默认地址', () => {
  const out = M.migrateSettings({ apiKey: 'k', baseUrl: '   ' }, 1);
  assert.equal(out.providers[0].baseUrl, 'https://api.siliconflow.cn/v1');
});

// ⚠️ 「migrate 被 zustand persist 调用时的环境」这一层**不在本文件里测**。
// persist 依赖 `window`，Node 里它是惰性的（连 hydrate 都不会发生），所以那里造不出
// 真实条件。改在浏览器里验：scripts/e2e-providers.mjs。
//
// 那里的坑值得记在这里：persist 在 create() 里**同步**完成首次 hydrate，migrate 执行时
// `useSettings` 这个变量还没被赋值。迁移函数里任何 `useSettings.getState()` 都会抛，
// hydrate 中断，store 悄悄退回默认值 —— 症状是「明明填了 key 却提示没填」，而提示里
// 点名的偏偏是默认那家（硅基流动），极具误导性。所以默认值必须是独立函数 initialSettings()。

await test('默认模型都指向预置的那家供应商', () => {
  const s = baseSettings();
  assert.equal(M.providerOf(s, 'sf').name, '硅基流动');
  assert.equal(M.providerOf(s, 'nope'), undefined);
  assert.ok(M.DEFAULT_MODELS.asrModel.length > 0);
  assert.ok(M.DEFAULT_MODELS.llmModel.length > 0);
  assert.ok(M.DEFAULT_MODELS.visionModel.length > 0);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
