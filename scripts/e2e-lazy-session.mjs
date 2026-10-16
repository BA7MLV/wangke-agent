/* eslint-disable no-console */
// E2E：懒创建会话（草稿态）的**页面链路**（**不需要 API key**）。
//
// 数据层的不变量（草稿态不落库、删到不剩回草稿态、失败不留半截）由
// `test-lazy-session.mjs` 直接驱动 store 守住 —— 那边能断言「库里到底有几行」，
// 比在浏览器里绕一圈更准。这里只补它做不到的两件事：
//
//   1. **页面在草稿态下真的能用**（输入框没被禁用、空态在、顶栏标题留空）；
//   2. **刷新**之后不产生空壳 —— 这是「懒创建」唯一会翻车的地方（刷新会重跑 bootstrap，
//      而 bootstrap 上一版正是「没有会话就现开一条」的那一处）。
//
// 模型流是**页内假的**（`addInitScript` 换掉 `window.fetch`），所以既不依赖 SF_KEY 也不花钱。
// 覆盖点：
//   1. 全新库进对话页：草稿态 —— Recent 整组不渲染、库里 0 行、标题留空、输入框可用
//   2. 发第一条消息：**这时才**落库（1 行），标题 = 首条消息截断，Recent 出现且选中它
//   3. 刷新：仍然只有 1 行（bootstrap 不再补空会话）
//   4. 删掉唯一会话：回到草稿态 —— 库里 0 行、Recent 消失、标题回留空、空态回来
//   5. 草稿态再发一条：又落 1 行（草稿态不是死状态）
//   6. **侧栏首项「新会话」**（原「AI 助手」）：它是动作不是目的地 —— 有会话在手上时
//      也不高亮；点一下回到草稿态且**不落库**（连点也不会攒出空壳）
//
// 用法：npm run preview &  然后 node scripts/e2e-lazy-session.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
/** 假的 OpenAI 兼容端点：只要请求打到这里就被脚本接管 */
const FAKE_API = 'https://sf.test/v1';
/** 课程库助手的 videoId 哨兵值（会话与消息都挂在它下面） */
const AID = '__library_assistant__';

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

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) =>
  fail(`页面异常：${e.message}\n${String(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`),
);

// ── 设置 + 假模型流 ─────────────────────────────────────────────────────────
await page.addInitScript((baseUrl) => {
  localStorage.setItem(
    'wangke-settings',
    JSON.stringify({
      state: {
        providers: [
          {
            id: 'sf',
            name: '硅基流动',
            baseUrl,
            apiKey: 'test-key',
            serves: ['chat', 'vision', 'asr'],
            catalogId: 'siliconflow-cn',
          },
        ],
        llmModel: { providerId: 'sf', model: 'test-model' },
        visionModel: { providerId: 'sf', model: 'test-model' },
        asrModel: { providerId: 'sf', model: 'test-model' },
        contextWindow: 32768,
        agentRounds: 6,
      },
      version: 3,
    }),
  );

  const nativeFetch = window.fetch.bind(window);
  window.__LLM__ = { queue: [] };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/chat/completions')) return nativeFetch(input, init);
    const step = window.__LLM__.queue.shift() ?? { content: '（没有脚本可播）' };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: step.content } }] })}\n\n`),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}, FAKE_API);

const push = (content) => page.evaluate((c) => window.__LLM__.queue.push({ content: c }), content);

// ── 原生 IndexedDB 工具：只碰库，不碰 DOM ───────────────────────────────────
/** 会话行数 —— 「有没有偷偷补一条空会话」的唯一硬判据 */
const sessionCount = () =>
  page.evaluate(async () => {
    const req = indexedDB.open('wangke');
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const n = await new Promise((res, rej) => {
      const tx = db.transaction('chatSessions', 'readonly');
      const q = tx.objectStore('chatSessions').count();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    return n;
  });

const sessionTitles = () =>
  page.evaluate(async () => {
    const req = indexedDB.open('wangke');
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const rows = await new Promise((res, rej) => {
      const tx = db.transaction('chatSessions', 'readonly');
      const q = tx.objectStore('chatSessions').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    return rows.map((r) => r.title);
  });

/** 把会话数据清空，回到「全新安装」 */
const clearSessions = () =>
  page.evaluate(async () => {
    const req = indexedDB.open('wangke');
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction(['chats', 'chatSessions'], 'readwrite');
      tx.objectStore('chats').clear();
      tx.objectStore('chatSessions').clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  });

// ── DOM 工具 ───────────────────────────────────────────────────────────────
const pageTitle = () => page.locator('[data-testid="page-title"]').innerText();
/** Recent 整组在不在（一条会话都没有时 layout 根本不渲染这一段） */
const recentGroup = () => page.locator('[aria-label="Recent"]');
const recentRows = () => page.locator('[data-testid^="chat-recent-"]:not([data-testid*="-menu-"])');

/**
 * 输入并发送。
 *
 * ⚠️ 选择器要同时收两种形态：HeroUI 的 `TextArea` 把 `className` 落在 **textarea 元素本身**，
 * 只写后代选择器 `.course-chat__input textarea` 一条都匹配不到，报出来是「输入框不可见」，
 * 看着像页面挂了（实测踩过，见 e2e-course-chat-cards 的注释）。
 */
async function typeAndSend(text) {
  const input = page.locator(
    '.course-chat__input textarea, .course-chat__input input, textarea.course-chat__input, input.course-chat__input',
  );
  await input.first().fill(text);
  await page.click('[data-testid="chat-send"]');
}

/**
 * 等这一轮真的写完。
 *
 * ⚠️ **只等「停止键消失」是不够的**：`send` 要 await 一次落库（懒创建）才把 `loading`
 * 置 true，而停止键是 `loading` 渲染出来的 —— 点完发送立刻去问「停止键还在不在」，
 * 答案必然是「不在」，于是这一步**当场返回**，后面的断言读到的还是落库前那一刻的状态
 * （实测：库里标题仍是「新会话」，而界面与内存里早已是新标题）。
 * 所以先等**用户真正看得见的那个结果**（回答出现在消息区），再等停止键收回去。
 */
async function waitAnswerDone(answerText) {
  await page.waitForFunction(
    (t) => document.querySelector('[data-testid="course-chat-messages"]')?.innerText.includes(t),
    answerText,
    { timeout: 20000 },
  );
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-stop"]'), null, {
    timeout: 20000,
  });
}

await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
// 清场：上一次跑留下的会话会让「全新库」那几条断言假过
await clearSessions();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
await page.waitForTimeout(600);

// ── 1. 全新库：草稿态 ─────────────────────────────────────────────────────
await check('全新库进对话页 = 草稿态：库里 0 行、Recent 整组不渲染', async () => {
  assert.equal(await sessionCount(), 0, '全新库不该有任何会话行');
  assert.equal(await recentGroup().count(), 0, '一条会话都没有时 Recent 不该渲染');
});

await check('草稿态顶栏标题留空（不写「新会话」，也不用页面名「AI 助手」兜底）', async () => {
  const title = await pageTitle();
  assert.equal(title, '', `顶栏标题应当留空，实际「${title}」`);
});

await check('草稿态的消息区是空态，输入框与发送键可用（不是死状态）', async () => {
  const messages = page.locator('[data-testid="course-chat-messages"]');
  assert.match(await messages.innerText(), /有什么想聊的|问你的全部资料/, '应当停在空态文案上');
  const input = page.locator('textarea.course-chat__input, input.course-chat__input').first();
  assert.equal(await input.isDisabled(), false, '草稿态输入框必须可用，否则连第一条都发不出去');
  await input.fill('占位');
  assert.equal(await page.locator('[data-testid="chat-send"]').isDisabled(), false, '有内容时发送键应当可用');
  await input.fill('');
});

// ── 2. 首条消息才落库 ─────────────────────────────────────────────────────
const FIRST = '帮我看看这门课的重点是什么，顺便列个复习顺序出来';
const FIRST_ANSWER = '重点有三处，按这个顺序复习就行。';
await check('发第一条消息：这时才落库（1 行），标题 = 首条消息截断', async () => {
  await push(FIRST_ANSWER);
  await typeAndSend(FIRST);
  await waitAnswerDone(FIRST_ANSWER);
  const titles = await sessionTitles();
  assert.deepEqual(titles, [`${FIRST.slice(0, 18)}…`], `库里的标题不对：${JSON.stringify(titles)}`);
});

await check('落库之后：Recent 出现该行且只有它被选中，顶栏标题跟着变', async () => {
  await page.waitForSelector('[data-testid^="chat-recent-"]', { timeout: 10000 });
  assert.equal(await recentRows().count(), 1, 'Recent 里应当只有刚落的这一条');
  const selected = page.locator('[aria-label="Recent"] [aria-selected="true"]');
  assert.equal(await selected.count(), 1, '应当有且只有一条被选中');
  assert.match(await pageTitle(), /帮我看看这门课的重点/, '顶栏标题应当换成会话标题');
});

// ── 3. 刷新不产生空壳 ─────────────────────────────────────────────────────
await check('刷新：仍然只有 1 行（bootstrap 不再补空会话）', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
  await page.waitForTimeout(600);
  assert.equal(await sessionCount(), 1, `刷新后应当仍然是 1 行，实际 ${await sessionCount()} 行`);
  assert.equal(await recentRows().count(), 1, 'Recent 里应当仍然只有那一条');
});

// ── 4. 删掉唯一会话 → 草稿态 ──────────────────────────────────────────────
/**
 * 走行尾菜单删除（「更多」→ 删除 → 确认）。
 *
 * ⚠️ 行尾那颗**垃圾桶**已经没有了：Recent 的四个动作 2026-10-15 收进了一颗「更多」菜单
 * （见 docs/plans/2026-10-15-recent-会话操作菜单-design.md）。`RecentItem.deleteTestId`
 * 还在接口里但**没人渲染**，所以点 `chat-recent-delete-*` 会一直等一个不存在的元素，
 * 而失败信息只会说「超时」，看不出是入口搬了家。
 */
async function deleteViaMenu() {
  const row = page.locator('[data-testid^="chat-recent-"]:not([data-testid*="-menu-"])').first();
  const rowTestId = await row.getAttribute('data-testid');
  await row.hover();
  await page.click(`[data-testid="${rowTestId}-menu-trigger"]`);
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  await page.click(`[data-testid="${rowTestId}-menu-delete"]`);
  await page.waitForSelector('[data-testid="confirm-dialog-danger"]', { timeout: 5000 });
  await page.click('[data-testid="confirm-dialog-confirm"]');
  await page.waitForSelector('[data-testid="confirm-dialog-danger"]', { state: 'detached', timeout: 5000 });
}

await check('删掉唯一会话：回到草稿态 —— 库里 0 行、Recent 消失、标题回留空', async () => {
  await deleteViaMenu();
  await page.waitForTimeout(600);

  assert.equal(await sessionCount(), 0, '删到不剩时不该补一条空会话');
  assert.equal(await recentGroup().count(), 0, 'Recent 整组应当消失');
  assert.equal(await pageTitle(), '', '顶栏标题应当回到留空');
  const messages = page.locator('[data-testid="course-chat-messages"]');
  assert.match(await messages.innerText(), /有什么想聊的|问你的全部资料/, '消息区应当回到空态');
});

// ── 5. 草稿态再发一条 ─────────────────────────────────────────────────────
await check('草稿态再发一条：又落 1 行（草稿态可复用，不是死状态）', async () => {
  await push('这次换一个话题。');
  await typeAndSend('换个话题：怎么安排每天的学习时间？');
  await waitAnswerDone('这次换一个话题。');
  const titles = await sessionTitles();
  assert.equal(titles.length, 1, `应当又落成 1 行，实际 ${titles.length} 行`);
  assert.match(titles[0], /换个话题/, `标题不对：${JSON.stringify(titles)}`);
  await page.waitForSelector('[data-testid^="chat-recent-"]', { timeout: 10000 });
});

// ── 6. 侧栏「新会话」入口 ─────────────────────────────────────────────────
/**
 * 侧栏首项（原「AI 助手」，现「新会话」）。
 *
 * 这一格是**动作**不是目的地：它在 `NavItem.isAction` 上，从不进 `selectedKeys`
 * （见 ui/layout.tsx）。所以这里量两件事 —— 它自己什么时候都不高亮，
 * 以及点它真的回到草稿态而不落库。
 */
const navNewSession = page.locator('[data-testid="nav-rail-chat"]');
/** Recent 里被选中的那条（草稿态应当一条都没有） */
const selectedRecentCount = () => page.locator('[aria-label="Recent"] [aria-selected="true"]').count();

await check('「新会话」是动作项：看着会话时它自己不高亮，Recent 才是「你在哪」的出口', async () => {
  assert.equal(await recentRows().count(), 1, '前置：此时 Recent 里应当有一条会话');
  assert.notEqual(
    await navNewSession.getAttribute('aria-selected'),
    'true',
    '「新会话」是动作不是目的地，不该有选中态',
  );
  assert.equal(await selectedRecentCount(), 1, 'Recent 里应当有且只有一条被选中');
  // 图标与标签的对应关系也钉一下：改了 label 却忘了测试选择器是常规翻车法
  assert.equal((await navNewSession.innerText()).trim(), '新会话', '首项文案应当是「新会话」');
});

await check('点「新会话」：回到草稿态 —— 标题回留空、消息区空态、Recent 无选中项、库里不新增行', async () => {
  const before = await sessionCount();
  await navNewSession.click();
  await page.waitForTimeout(400);

  assert.equal(await pageTitle(), '', '顶栏标题应当回到留空');
  assert.match(
    await page.locator('[data-testid="course-chat-messages"]').innerText(),
    /有什么想聊的|问你的全部资料/,
    '消息区应当回到空态',
  );
  assert.equal(await selectedRecentCount(), 0, '草稿态还没有那条会话，Recent 里不该有选中项');
  assert.equal(await sessionCount(), before, `点「新会话」不该落库（应当仍是 ${before} 行）`);
});

await check('草稿态连点「新会话」是幂等的：库里仍是那些行（攒不出空壳）', async () => {
  const before = await sessionCount();
  await navNewSession.click();
  await navNewSession.click();
  await navNewSession.click();
  await page.waitForTimeout(400);

  assert.equal(await sessionCount(), before, `连点不该产生任何会话行（应当仍是 ${before} 行）`);
  assert.equal(await pageTitle(), '', '顶栏标题仍应当留空');
  assert.notEqual(
    await navNewSession.getAttribute('aria-selected'),
    'true',
    '点完之后它自己也不该变成选中态',
  );
});

await context.close();
await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
