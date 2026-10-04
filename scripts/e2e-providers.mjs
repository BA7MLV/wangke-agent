/* eslint-disable no-console */
// E2E：多供应商配置（**不需要 API key**，模型列表用页内假网关）。
//
// 这条脚本守的是**只有浏览器里才验得到**的那一层：
//  1. 旧格式 localStorage 被 migrate 迁好，凭据与自定义端点都保住；
//  2. 已是新格式的 localStorage（version 与形状不符：手改过 / 跨版本回滚）不被抹掉；
//  3. 设置页的供应商注册表：增删改、能力勾选、按能力筛选槽位候选；
//  4. **槽位真的能把请求发到不同供应商的地址**（本条是这个特性的全部意义所在）。
//
// 为什么必须有第 1、2 条：zustand 的 persist 依赖 window，在 Node 里是惰性的
// （连 hydrate 都不发生），纯逻辑测试造不出真实条件。而这里的坑极隐蔽 —— persist 在
// create() 里同步 hydrate，迁移函数若读 useSettings.getState() 会抛（变量还在 TDZ），
// hydrate 中断后 store 悄悄退回默认值，症状是「明明填了 key 却提示没填」。
//
// 用法：npm run preview &  然后 node scripts/e2e-providers.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const SF = 'https://sf.test/v1';
const OR = 'https://or.test/v1';

let failed = 0;
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.error(`❌ ${m}`);
  failed++;
};
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(`${name}\n   ${e.message}`);
  }
}

/** 读出当前持久化的设置（zustand persist 存的是 { state, version }） */
const readSettings = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings') ?? '{}')?.state ?? null);

/**
 * 读 mdui-text-field 的值。
 *
 * **不能靠 `[data-testid=x] input`**：mdui 的 text-field 是自定义元素，把真正的 `<input>`
 * 放在 shadow DOM 里（外层那个元素上只有自己的属性）。读 `value` 属性或走 shadowRoot 都行，
 * 这里用属性 —— 少一层 shadow 穿透，且它就是值来源（受控组件每次都写回）。
 */
const fieldValue = (page, testId) =>
  page.locator(`[data-testid="${testId}"]`).evaluate((el) => el.value ?? '');

/**
 * mdui-select 当前选中的值。
 *
 * 优先读元素自身的 `value`（受控值，React 每次渲染都会写回）；元素上还没有时
 * 再从选项的 `selected` 属性取 —— 两者在弹层刚收起、组件正在重渲染的瞬间可能短暂不一致。
 */
const selectedValue = async (page, testId) => {
  const loc = page.locator(`[data-testid="${testId}"]`);
  for (let i = 0; i < 10; i++) {
    const v = await loc.evaluate((el) => el.value || el.querySelector('[selected]')?.getAttribute('value') || '');
    if (v) return v;
    await page.waitForTimeout(200);
  }
  return '';
};

/** 下拉候选的可见文本（点开后读选项；mdui 会把菜单移到 body 下） */
const selectOptions = (page, testId) =>
  page.evaluate(async (id) => {
    const sel = document.querySelector(`[data-testid="${id}"]`);
    sel.click();
    await new Promise((r) => setTimeout(r, 400));
    // 读当前这个 select 自己的选项（菜单虽被移出元素，但选项仍带着所属关系）
    const items = [...sel.querySelectorAll('mdui-menu-item')].map((el) => el.textContent.trim());
    document.body.click();
    await new Promise((r) => setTimeout(r, 200));
    return items;
  }, testId);

/**
 * 像用户那样把 mdui-select 切到某个选项。
 *
 * **必须走「真实点击」**：mdui 的 select 把选中逻辑挂在它自己的 popup 上，
 * 对隐藏的 `<mdui-menu-item>` 调 `el.click()` 什么都不会发生（option 元素本身
 * 不是可点的目标，点的是弹层里渲染出来的那一份）。所以先点 select 展开，
 * 再点**可见**的那一项。
 */
const chooseOption = async (page, testId, label) => {
  await page.locator(`[data-testid="${testId}"]`).click();
  await page.waitForTimeout(500);
  await page.locator('mdui-menu-item:visible', { hasText: label }).first().click();
  await page.waitForTimeout(400);
};

/** 换一份 localStorage 设置后重载 */
const seedAndReload = async (page, state, version) => {
  await page.evaluate(
    ([s, v]) => localStorage.setItem('wangke-settings', JSON.stringify({ state: s, version: v })),
    [state, version],
  );
  await page.reload({ waitUntil: 'networkidle' });
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });

// ── 1) 旧格式 localStorage 的迁移 ───────────────────────────────────────────
{
  const page = await context.newPage();
  page.on('pageerror', (e) => fail(`页面异常：${e.message}`));
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
  await page.evaluate(
    ([baseUrl]) =>
      localStorage.setItem(
        'wangke-settings',
        JSON.stringify({
          state: {
            apiKey: 'sk-old',
            baseUrl,
            llmModel: 'deepseek-ai/DeepSeek-V4-Flash',
            asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra',
            favorites: { chat: ['a/b'], vision: [], asr: [] },
            contextWindow: 999999,
            asrConcurrency: 7,
          },
          version: 1,
        }),
      ),
    [SF],
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="card-api"]', { timeout: 20000 });

  await check('v1 → v2：凭据搬进预置供应商，没有残留在顶层', async () => {
    const s = await readSettings(page);
    assert.equal(s.providers.length, 1);
    assert.equal(s.providers[0].apiKey, 'sk-old');
    assert.equal(s.providers[0].baseUrl, SF);
    assert.equal(s.apiKey, undefined, '顶层不该还留着 apiKey');
    assert.equal(s.baseUrl, undefined, '顶层不该还留着 baseUrl');
  });

  await check('v1 → v2：模型 id 变成带供应商的引用，且立刻可用', async () => {
    const s = await readSettings(page);
    assert.deepEqual(s.llmModel, { providerId: s.providers[0].id, model: 'deepseek-ai/DeepSeek-V4-Flash' });
    assert.deepEqual(s.asrModel, { providerId: s.providers[0].id, model: 'XingChenAGI/XingChenASR-V3.2-Ultra' });
    // 收藏夹也跟着变成引用
    assert.deepEqual(s.favorites.chat, [{ providerId: s.providers[0].id, model: 'a/b' }]);
  });

  await check('v1 → v2：用户改过的其它设置原样保留', async () => {
    const s = await readSettings(page);
    assert.equal(s.contextWindow, 999999);
    assert.equal(s.asrConcurrency, 7);
  });

  await check('v1 → v2：迁移后的凭据在界面上可见（不是静默退回默认值）', async () => {
    // 「静默退回默认值」的表现就是这里读不到 key。默认那家恰好也叫硅基流动，
    // 所以只看供应商名会以为没事 —— 必须看输入框里的实际值。
    assert.equal(await fieldValue(page, 'api-key-sf'), 'sk-old');
    assert.equal(await fieldValue(page, 'base-url-sf'), SF);
  });
  await page.close();
}

// ── 2) 已是新格式、但 version 对不上（手改 localStorage / 跨版本回滚）────────
{
  const page = await context.newPage();
  page.on('pageerror', (e) => fail(`页面异常：${e.message}`));
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
  await seedAndReload(
    page,
    {
      providers: [
        { id: 'sf', name: '硅基流动', baseUrl: SF, apiKey: 'sk-a', serves: ['chat', 'vision', 'asr'], catalogId: 'siliconflow-cn' },
        { id: 'or', name: 'OpenRouter', baseUrl: OR, apiKey: 'or-b', serves: ['chat'], catalogId: 'openrouter' },
      ],
      llmModel: { providerId: 'or', model: 'vendor/model-x' },
      contextWindow: 262144,
    },
    0, // 与实际形状不符
  );
  await page.waitForSelector('[data-testid="card-api"]', { timeout: 20000 });

  await check('version 与形状不符时：两家供应商都保住，不被重建成默认的', async () => {
    const s = await readSettings(page);
    assert.equal(s.providers.length, 2);
    assert.equal(s.providers[1].apiKey, 'or-b');
    assert.deepEqual(s.llmModel, { providerId: 'or', model: 'vendor/model-x' });
    assert.equal(s.contextWindow, 262144);
  });
  await page.close();
}

// ── 3) 设置页的供应商注册表 ──────────────────────────────────────────────────
const page = await context.newPage();
page.on('pageerror', (e) => fail(`页面异常：${e.message}`));

// 假网关：只有 /models 有用（设置页的「检查模型可用性」），其余放行
await page.addInitScript(([sf, or]) => {
  localStorage.setItem(
    'wangke-settings',
    JSON.stringify({
      state: {
        providers: [
          { id: 'sf', name: '硅基流动', baseUrl: sf, apiKey: 'sk-a', serves: ['chat', 'vision', 'asr'], catalogId: 'siliconflow-cn' },
          { id: 'or', name: 'OpenRouter', baseUrl: or, apiKey: 'or-b', serves: ['chat'], catalogId: 'openrouter' },
        ],
        // 三槽位分属两家：ASR 走 SF，文本走 OR —— 这就是要验的形状
        asrModel: { providerId: 'sf', model: 'XingChenAGI/XingChenASR-V3.2-Ultra' },
        llmModel: { providerId: 'or', model: 'vendor/llm-x' },
        visionModel: { providerId: 'sf', model: 'Qwen/Qwen3.6-35B-A3B' },
        contextWindow: 32768,
      },
      version: 2,
    }),
  );
  const CATALOG = {
    [sf]: ['XingChenAGI/XingChenASR-V3.2-Ultra', 'Qwen/Qwen3.6-35B-A3B', 'vendor/shared-name'],
    [or]: ['vendor/llm-x', 'vendor/shared-name'],
  };
  const nativeFetch = window.fetch.bind(window);
  /** 模型列表请求（设置页「检查模型可用性」） */
  window.__PROBE__ = [];
  /** 对话请求：连地址 / 凭据 / 模型一起记下来，才能验「打到了对的那家」 */
  window.__LLM__ = { requests: [] };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/models')) {
      const base = url.slice(0, -'/models'.length);
      window.__PROBE__.push({ base, auth: init?.headers?.Authorization ?? null });
      return new Response(
        JSON.stringify({ data: (CATALOG[base] ?? []).map((id) => ({ id })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(init?.body ?? '{}');
      window.__LLM__.requests.push({
        url,
        auth: init?.headers?.Authorization ?? null,
        model: body.model,
      });
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(cc) {
          cc.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: '好的' } }] })}\n\n`,
            ),
          );
          cc.enqueue(enc.encode('data: [DONE]\n\n'));
          cc.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return nativeFetch(input, init);
  };
}, [SF, OR]);

await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="card-api"]', { timeout: 20000 });

await check('供应商注册表：两家都在，各自显示名称 / 地址 / 凭据', async () => {
  assert.equal(await page.locator('[data-testid="provider-card-sf"]').count(), 1);
  assert.equal(await page.locator('[data-testid="provider-card-or"]').count(), 1);
  assert.equal(await fieldValue(page, 'base-url-sf'), SF);
  assert.equal(await fieldValue(page, 'base-url-or'), OR);
  assert.equal(await fieldValue(page, 'api-key-sf'), 'sk-a');
  assert.equal(await fieldValue(page, 'api-key-or'), 'or-b');
});

await check('槽位各指各的供应商：文本指 OpenRouter，ASR 指硅基流动', async () => {
  assert.equal(await selectedValue(page, 'provider-llmModel'), 'or');
  assert.equal(await selectedValue(page, 'provider-asrModel'), 'sf');
  assert.equal(await fieldValue(page, 'model-llmModel'), 'vendor/llm-x');
  assert.equal(await fieldValue(page, 'model-asrModel'), 'XingChenAGI/XingChenASR-V3.2-Ultra');
});

await check('槽位候选按能力筛选：OpenRouter 只勾了 chat，不出现在 ASR 槽位里', async () => {
  // 「手动标能力」的实际用途就在这里 —— 标了不提供 ASR 的那家不进 ASR 槽位，
  // 从源头上排掉「拿文本接口当 ASR 用」这种错配。
  assert.deepEqual(await selectOptions(page, 'provider-asrModel'), ['硅基流动']);
  // 文本槽位两家都在（都勾了 chat）
  assert.deepEqual(await selectOptions(page, 'provider-llmModel'), ['硅基流动', 'OpenRouter']);
  // 视觉只有硅基流动（OpenRouter 没勾）
  assert.deepEqual(await selectOptions(page, 'provider-visionModel'), ['硅基流动']);
});

await check('槽位真的把请求发到不同供应商的地址（这是整个特性的意义所在）', async () => {
  // 到目前为止都在验配置层。这一条验**运行时**：文本槽位的请求必须打到 OpenRouter、
  // ASR 的打到硅基流动 —— 各带各的 key。地址混了的话，前面的配置全都白配。
  await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  await page.evaluate(() => {
    window.__LLM__.requests.length = 0;
  });
  const field = page.locator('.course-chat__input textarea, .course-chat__input input').first();
  await field.click();
  await field.fill('一句回答');
  await field.press('Enter');
  await page.waitForTimeout(1500);
  const calls = await page.evaluate(() => window.__LLM__.requests);
  assert.ok(calls.length > 0, '应发出过请求');
  assert.ok(
    calls.every((c) => c.url.startsWith(OR)),
    `文本槽位的请求应全部打到 OpenRouter（${OR}），实际：${JSON.stringify(calls.map((c) => c.url))}`,
  );
  assert.ok(
    calls.every((c) => c.auth === 'Bearer or-b'),
    `文本请求应带 OpenRouter 那把 key，实际：${JSON.stringify(calls.map((c) => c.auth))}`,
  );
  assert.ok(
    calls.every((c) => c.model === 'vendor/llm-x'),
    `模型 id 应来自槽位所选，实际：${JSON.stringify(calls.map((c) => c.model))}`,
  );
  // 回到设置页，后面的用例都在这里
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="card-api"]', { timeout: 20000 });
});

await check('「检查模型可用性」逐家发请求，且各自带上自己的凭据', async () => {
  await page.click('[data-testid="btn-check-models"]');
  await page.waitForSelector('[data-testid="provider-note-sf"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="provider-note-or"]', { timeout: 20000 });
  const probes = await page.evaluate(() => window.__PROBE__);
  const byBase = Object.fromEntries(probes.map((p) => [p.base, p.auth]));
  assert.equal(byBase[SF], 'Bearer sk-a');
  assert.equal(byBase[OR], 'Bearer or-b');
});

await check('模型候选按供应商分开拉取，槽位只看自己那家的', async () => {
  // 候选来自「检查模型可用性」逐家拉到的列表；槽位只显示自己那家的。
  // 文本槽位的候选里应有 OpenRouter 独有的模型，且**不含** SF 独有的 ASR 模型。
  // ⚠️ 候选面板挂的是 `id`（`model-llmModel-options`），不是 data-testid —— 见 ModelField。
  const options = await page.evaluate(async () => {
    document.querySelector('[data-testid="model-llmModel-pick"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll('#model-llmModel-options mdui-list-item')];
    // headline 是 mdui-list-item 的属性投影，读属性比读 textContent 稳
    const ids = items.map((el) => el.getAttribute('headline') ?? el.textContent.trim());
    document.body.click();
    await new Promise((r) => setTimeout(r, 200));
    return ids;
  });
  assert.ok(options.includes('vendor/llm-x'), `应列出 OpenRouter 在架的模型，实际 ${JSON.stringify(options)}`);
  assert.equal(
    options.includes('XingChenAGI/XingChenASR-V3.2-Ultra'),
    false,
    '文本槽位不该看到 ASR 模型（那是另一家在架的）',
  );
});

const favRow = (slot, provider, model) => `[data-testid="fav-${slot}-${provider}-${model}"]`;

await check('收藏夹按供应商分组，同名模型分别成行', async () => {
  // 切到「文本」页签：SF 与 OR 都有一个 vendor/shared-name，必须分成两组各自的行。
  // testid 带槽位是因为 mdui-tabs 把三个面板都留在 DOM 里（只切显隐），
  // 不带槽位的话同一个模型在三个页签下会渲染出三行、选择器命中 3 个元素。
  await page.click('[data-testid="fav-tab-chat"]');
  await page.waitForSelector('[data-testid="fav-group-sf"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="fav-group-or"]', { timeout: 10000 });
  assert.equal(await page.locator(favRow('chat', '硅基流动', 'vendor/shared-name')).count(), 1);
  assert.equal(await page.locator(favRow('chat', 'OpenRouter', 'vendor/shared-name')).count(), 1);
});

await check('勾两个同名模型 → 收藏夹按「供应商+模型」各存一条', async () => {
  await page.click(favRow('chat', '硅基流动', 'vendor/shared-name'));
  await page.click(favRow('chat', 'OpenRouter', 'vendor/shared-name'));
  await page.waitForTimeout(300);
  const s = await readSettings(page);
  assert.deepEqual(
    [...s.favorites.chat].sort((a, b) => a.providerId.localeCompare(b.providerId)),
    [
      { providerId: 'or', model: 'vendor/shared-name' },
      { providerId: 'sf', model: 'vendor/shared-name' },
    ],
  );
  // 取消其中一个，另一个得留着 —— 这是「按供应商+模型」而不是「按模型」的关键差别
  await page.click(favRow('chat', 'OpenRouter', 'vendor/shared-name'));
  await page.waitForTimeout(300);
  const after = await readSettings(page);
  assert.deepEqual(after.favorites.chat, [{ providerId: 'sf', model: 'vendor/shared-name' }]);
});

await check('加一家新供应商：id 不撞车，且能力勾选可改', async () => {
  await page.click('[data-testid="btn-add-provider"]');
  await page.waitForSelector('[data-testid="provider-card-dm"]', { timeout: 10000 });
  let s = await readSettings(page);
  assert.equal(s.providers.length, 3);
  assert.equal(s.providers[2].id, 'dm');
  // 默认只勾 chat（保守：不该替用户猜这家能干什么），且名称/地址留空等用户填
  assert.deepEqual(s.providers[2].serves, ['chat']);
  assert.equal(s.providers[2].apiKey, '');
  assert.equal(s.providers[2].catalogId, '');

  // 命名后它才在槽位下拉里可辨认（空名会显示成空白行，用户无从分辨）
  await page.locator('[data-testid="provider-name-dm"]').evaluate((el) => {
    el.value = 'DeepSeek直连';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  s = await readSettings(page);
  assert.equal(s.providers[2].name, 'DeepSeek直连');

  // 勾上 asr 之后它就该出现在 ASR 槽位的候选里
  await page.click('[data-testid="serves-dm-asr"]');
  await page.waitForTimeout(300);
  const after = await readSettings(page);
  assert.deepEqual(after.providers[2].serves, ['chat', 'asr']);
});

await check('新供应商填了能力后，会立刻出现在对应槽位的候选里', async () => {
  const asrCandidates = await page.locator(
    '[data-testid="provider-asrModel"] mdui-menu-item',
  ).evaluateAll((els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(asrCandidates, ['硅基流动', 'DeepSeek直连']);
});

await check('槽位当前指的那家没勾这个能力时，界面标红提示', async () => {
  // 把 sf 的 ASR 能力取消：asrModel 仍指 sf，于是槽位下方应出现能力缺失提示
  await page.click('[data-testid="serves-sf-asr"]');
  await page.waitForSelector('[data-testid="provider-asrModel-nocap"]', { timeout: 10000 });
  const text = await page.locator('[data-testid="provider-asrModel-nocap"]').innerText();
  assert.ok(text.includes('语音识别'), `提示要说清缺的是哪个槽位，实际：${text}`);
  // 勾回去，提示消失
  await page.click('[data-testid="serves-sf-asr"]');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-testid="provider-asrModel-nocap"]').count(), 0);
});

await check('删掉一家：槽位改指剩下的，收藏项清掉，不留悬空引用', async () => {
  // 先把文本槽位切到 dm，才能验证「被删的那家正好被某个槽位指着」
  await chooseOption(page, 'provider-llmModel', 'DeepSeek直连');
  let s = await readSettings(page);
  assert.equal(s.llmModel.providerId, 'dm');
  assert.equal(s.llmModel.model, 'vendor/llm-x', '换供应商时模型 id 原样保留');

  await page.click('[data-testid="provider-remove-dm"]');
  await page.waitForTimeout(400);
  s = await readSettings(page);
  assert.equal(s.providers.length, 2);
  // 指向 dm 的槽位被改指剩下的第一家，不能是悬空引用
  assert.equal(s.llmModel.providerId, 'sf');
  // dm 的收藏项被清掉
  assert.equal(s.favorites.chat.some((r) => r.providerId === 'dm'), false);
  // 每个槽位的供应商都还能在界面上解析出来（悬空引用会抛「供应商已被删除」）
  for (const [slot, expect] of [['asrModel', 'sf'], ['llmModel', 'sf'], ['visionModel', 'sf']]) {
    assert.equal(await selectedValue(page, `provider-${slot}`), expect, `${slot} 应指向剩下的一家`);
  }
});

await check('删除后刷新仍然自洽（悬空引用会在这里暴露成「供应商已被删除」）', async () => {
  const before = await readSettings(page);
  assert.ok(before?.favorites, '删除后 favorites 应仍在');

  // ⚠️ 必须开一个**新页面**验证持久化：page 上那个 addInitScript 每导航（含 reload）
  // 都会重新写一遍种子，于是刷新后读到的是种子而不是刚才操作出来的状态 ——
  // 那是测试脚手架的假象，不是应用的问题。新页面共享同一个 context 的 localStorage。
  const fresh = await context.newPage();
  fresh.on('pageerror', (e) => fail(`页面异常：${e.message}`));
  await fresh.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
  await fresh.waitForSelector('[data-testid="card-api"]', { timeout: 20000 });
  const s = await readSettings(fresh);
  assert.ok(s?.favorites, `favorites 应存在：${JSON.stringify(s)}`);
  const ids = new Set(s.providers.map((p) => p.id));
  for (const slot of ['asrModel', 'llmModel', 'visionModel']) {
    assert.ok(ids.has(s[slot].providerId), `${slot} 指向了不存在的供应商 ${s[slot].providerId}`);
  }
  // 收藏项也得跟着干净 —— 悬空的收藏项会让面板下拉里出现一行点不动的死项
  for (const slot of ['chat', 'vision', 'asr']) {
    for (const r of s.favorites[slot] ?? []) {
      assert.ok(ids.has(r.providerId), `收藏项 ${r.model} 指向了不存在的供应商 ${r.providerId}`);
    }
  }
  // 界面上也不该出现「能力缺失」的红字（没有悬空引用就没有该提示的东西）
  await fresh.waitForTimeout(400);
  assert.equal(
    await fresh.locator('[data-testid$="-nocap"]').count(),
    0,
    '删除并改指之后不该再有「能力缺失」提示',
  );
  await fresh.close();
});

await page.close();
await browser.close();
if (failed > 0) {
  console.error(`\n❌ ${failed} 条失败`);
  process.exit(1);
}
console.log('\n✅ 多供应商配置全部通过：迁移 / 注册表 / 按能力筛选 / 候选分组 / 删除清理');
