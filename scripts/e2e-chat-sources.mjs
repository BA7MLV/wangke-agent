/* eslint-disable no-console */
// E2E：课程助手的「来源文件 / 消息操作行 / 会话选中」（**不需要 API key**）。
//
// 为什么不像 e2e-course-chat-cards 那样用假模型流：这几条要验的东西全在**渲染层** ——
// 来源是从**已经落库的回答正文**里解析出来的，操作行与来源行的出现时机只取决于
// `message.streaming`。直接往 chats 表里种一条写好的回答，比让假模型把它吐出来更快更稳；
// 模型流本身（工具调用 ↔ 卡片 ↔ 落库）已由 e2e-course-chat-cards 覆盖，两者不重叠。
//
// 覆盖点：
//   1. Recent：当前会话是唯一 aria-selected=true 的那条；点另一条高亮跟着走
//   2. 带引用的回答 → 直接显示来源文件名链接，不显示计数与位置（书名号要脱掉）
//   3. 不带引用的回答 → 根本不渲染来源行（解析不到就不摆一行空壳）
//   4. 来源行里点课程 → 跳播放页
//   5. 复制这条回答 → 剪贴板里是 Markdown 原文（加粗标记与课程链接都在）
//   6. 「更多」→ 复制纯文本（剪贴板里不该再有 ** 与 ](#/player/）
//   7. 「更多」→ 导出本次会话（文件名 = 课程库-<标题>.md，内容是整会话）
//   8. ~~顶栏「新建对话」真的新建一条并切过去~~ —— 那颗按钮 2026-10-15 已删，
//      这条覆盖跟着消失，理由写在文件末尾 §4 的位置。
//
// 用法：npm run preview &  然后 node scripts/e2e-chat-sources.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
/** 课程库助手的 videoId 哨兵值（会话与消息都挂在它下面） */
const AID = '__library_assistant__';
const TARGET_TITLE = '来源与操作行';

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
// clipboard-read 必需：断言是「剪贴板里到底有什么」，不是「按钮点了没报错」
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
page.on('pageerror', (e) =>
  fail(`页面异常：${e.message}\n${String(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`),
);

/**
 * 目标回答：两门课、三种位置标记（时间点 / 长时分 / 页码）。
 * 课程链接刻意写成正文里那种 `[《课名》](#/player/<id>)` 形态 —— 解析器认的是
 * 「指向播放页的链接」，不是裸写的课程名。
 */
const ANSWER_WITH_SOURCES = [
  '这个线框图是很典型的仪表盘外壳：常驻侧栏、顶栏，以及一块可滚动的卡片与图表区。',
  '',
  '几点值得注意：',
  '',
  '1. **侧栏常驻**——它承担导航，所以内容区的宽度必须能自适应收缩；',
  '2. **顶栏只放全局动作**——搜索、通知、账号，不放页面级操作。',
  '',
  '对照你的课程 [《高等数学（上）》](#/player/c-math)，12:34 与 第 3 页 的板书里也提过同样的分区思路。',
  '',
  '另一门 [《行测判断推理》](#/player/c-xingce) 的 05:20 讲的是另一回事。',
].join('\n');

/** 只有时间标记、一个课程链接都没有 —— 用来验「解析不到就不渲染来源行」 */
const ANSWER_WITHOUT_SOURCES = '240–280px 是常见区间，见 05:20 那段。再宽就只是留白。';

// ── 原始 IndexedDB 工具（只种状态，不种文件）────────────────────────────────
const dbHelper = (fn, arg) =>
  page.evaluate(
    async ([body, payload]) => {
      const run = new Function(`return (${body})`)();
      const req = indexedDB.open('wangke');
      const idb = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const out = await run(idb, payload);
      idb.close();
      return out;
    },
    [fn.toString(), arg ?? null],
  );

/** 清空会话数据后种入两门课 + 两条会话。返回两个会话的 id，供断言定位。 */
const seed = () =>
  dbHelper(
    async (idb, { aid, title, answer1, answer2 }) => {
      const now = Date.now();
      await new Promise((res, rej) => {
        const tx = idb.transaction(['videos', 'chatSessions', 'chats'], 'readwrite');
        tx.objectStore('chatSessions').clear();
        tx.objectStore('chats').clear();
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });

      const tx = idb.transaction(['videos', 'chatSessions', 'chats'], 'readwrite');
      const vs = tx.objectStore('videos');
      vs.put({ id: 'c-math', name: '高等数学（上）', kind: 'video', size: 1, mimeType: 'video/mp4', duration: 3600, createdAt: 3, status: 'transcribed' });
      vs.put({ id: 'c-xingce', name: '行测判断推理', kind: 'video', size: 1, mimeType: 'video/mp4', duration: 2400, createdAt: 2, status: 'transcribed' });

      const add = (store, row) =>
        new Promise((res, rej) => {
          const r = store.add(row);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      const ss = tx.objectStore('chatSessions');
      const cs = tx.objectStore('chats');
      // 目标会话**故意**比陪跑的旧：store 默认选最新那条，于是「切回目标会话」这一步
      // 顺带把 Recent 的点击路径也走了一遍，不用额外造一个空会话当落点。
      const target = await add(ss, { videoId: aid, title, createdAt: now - 5000 });
      const decoy = await add(ss, { videoId: aid, title: '陪跑会话', createdAt: now - 1000 });
      await add(cs, { videoId: aid, sessionId: target, role: 'user', content: '这个线框图你觉得怎么样？', createdAt: now - 4900 });
      await add(cs, { videoId: aid, sessionId: target, role: 'assistant', content: answer1, createdAt: now - 4800 });
      await add(cs, { videoId: aid, sessionId: target, role: 'user', content: '那侧栏该多宽？', createdAt: now - 4700 });
      await add(cs, { videoId: aid, sessionId: target, role: 'assistant', content: answer2, createdAt: now - 4600 });
      await add(cs, { videoId: aid, sessionId: decoy, role: 'user', content: '陪跑消息', createdAt: now - 900 });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      return { target, decoy };
    },
    { aid: AID, title: TARGET_TITLE, answer1: ANSWER_WITH_SOURCES, answer2: ANSWER_WITHOUT_SOURCES },
  );

async function waitFor(fn, { timeout = 15000, step = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return null;
    await page.waitForTimeout(step);
  }
}

/**
 * 轮询剪贴板直到满足条件（返回最后一次读到的内容）。
 *
 * 为什么不 waitForSelector 等 toast：toast 只是「点了」的证据，剪贴板才是「对了」的证据；
 * 两者之间隔着一次 await，等 toast 再读剪贴板偶发会读到旧值。直接轮询目标本身更稳，
 * 也顺带把 toast 的实现细节（换过两次了）从断言里摘出去。
 */
async function clipboardUntil(predicate, { timeout = 8000, step = 100 } = {}) {
  const end = Date.now() + timeout;
  let last = '';
  for (;;) {
    last = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    if (predicate(last)) return last;
    if (Date.now() > end) return last;
    await page.waitForTimeout(step);
  }
}

/**
 * 轮询消息区的 innerText 直到判据成立，返回最后一次读到的内容。
 *
 * 为什么必须轮询而不能读一次：点 Recent 之后**高亮**是同步跟着 store 走的，
 * 而**消息体**要先读一次 Dexie 才渲染 —— 中间隔着一个异步。只等高亮就去断言内容，
 * 等于在赌那次读库已经回来：单跑几乎必中，机器一忙（一键跑分里前后都是重脚本）
 * 就变成假红，而它红在对话页上，看着像对话链路坏了。断言的目标是内容，那就等内容。
 * 与上面 `clipboardUntil` 同一条理由、同一套写法。
 */
async function messageTextUntil(predicate, { timeout = 10000, step = 100 } = {}) {
  const end = Date.now() + timeout;
  let last = '';
  for (;;) {
    last = await page.locator('[data-testid="course-chat-messages"]').innerText();
    if (predicate(last)) return last;
    if (Date.now() > end) return last;
    await page.waitForTimeout(step);
  }
}

const openChat = async () => {
  await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
};

/** 第一条助手消息（带引用的那条）——操作行与来源行都挂在它下面 */
const firstAiBubble = () => page.locator('.course-chat__bubble--ai').first();

// ── 开跑 ────────────────────────────────────────────────────────────────────
await openChat();
const { target, decoy } = await seed();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });

console.log('—— 1. Recent 的选中态 ——');
await check('默认停在最新会话，Recent 里只有它 aria-selected=true', async () => {
  const selected = page.locator('[aria-label="Recent"] [aria-selected="true"]');
  await selected.first().waitFor({ timeout: 10000 });
  assert.equal(await selected.count(), 1, 'Recent 里应当**只有一条**被选中');
  assert.equal(
    await selected.first().getAttribute('data-testid'),
    `chat-recent-${decoy}`,
    '选中的应当是 store 默认打开的最新那条',
  );
});

await check('点另一条 Recent → 高亮跟着走，且消息换成目标会话', async () => {
  await page.click(`[data-testid="chat-recent-${target}"]`);
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-selected') === 'true',
    `chat-recent-${target}`,
    { timeout: 10000 },
  );
  const selected = page.locator('[aria-label="Recent"] [aria-selected="true"]');
  assert.equal(await selected.count(), 1, '切换后仍应只有一条被选中');
  // 等的是**内容**，不是高亮（理由见 messageTextUntil）：这条断言的宾语就是内容
  const text = await messageTextUntil((t) => /这个线框图你觉得怎么样/.test(t));
  assert.match(text, /这个线框图你觉得怎么样/, '消息区应当换成目标会话的内容');
  assert.doesNotMatch(text, /陪跑消息/, '陪跑会话的消息不该混进来');
});

console.log('—— 2. 来源文件 ——');
await check('带引用的回答：直接显示可点击的文件名，不显示计数与位置', async () => {
  const sources = page.locator('[data-testid="chat-sources"]');
  await sources.first().waitFor({ timeout: 10000 });
  assert.equal(
    await sources.count(),
    1,
    '四条消息里只有第一条回答带引用 —— 来源行应当只出现一次',
  );

  assert.equal(await page.locator('[data-testid="chat-sources-trigger"]').count(), 0, '不再显示折叠入口');
  const items = page.locator('[data-testid="chat-source-item"]:visible');
  await items.first().waitFor({ timeout: 10000 });
  assert.equal(await items.count(), 2, '应当直接列出两个文件名');

  const text = (await items.allInnerTexts()).join('\n');
  assert.match(text, /高等数学（上）/, '要显示课程名');
  assert.doesNotMatch(text, /《/, '书名号是链接文本的装饰，来源列表里要脱掉');
  assert.doesNotMatch(text, /12:34|第 3 页|05:20|个来源/, '来源区只显示文件名');
  assert.match(text, /行测判断推理/, '第二门课同样要列出来');
});

await check('不带引用的回答：一条来源行都不渲染', async () => {
  const ai = page.locator('.course-chat__bubble--ai');
  assert.equal(await ai.count(), 2, '目标会话应当有两条助手回答');
  assert.equal(
    await ai.nth(1).locator('[data-testid="chat-sources"]').count(),
    0,
    '正文里只有时间标记、没有课程链接时不归属任何来源，不该摆一行「0 个来源」',
  );
});

await check('来源行里点课程 → 跳播放页', async () => {
  await page.locator('[data-testid="chat-source-item"]:visible a').first().click();
  await page.waitForURL(/#\/player\/c-math$/, { timeout: 10000 });
  ok('  （已跳到 #/player/c-math）');
});

// 回到对话页继续验操作行
await openChat();
await page.click(`[data-testid="chat-recent-${target}"]`);
await firstAiBubble().waitFor({ timeout: 10000 });

console.log('—— 3. 消息操作行 ——');
await check('复制这条回答 → 剪贴板里是 Markdown 原文', async () => {
  const ai = firstAiBubble();
  await ai.hover();
  const actions = ai.locator('[data-testid="chat-message-actions"]');
  await actions.waitFor({ state: 'visible', timeout: 10000 });
  await actions.locator('[data-testid="chat-copy-message"]').click();
  const clip = await clipboardUntil((t) => t.includes('侧栏常驻'));
  assert.match(clip, /\*\*侧栏常驻\*\*/, 'Markdown 的加粗标记要原样保留（这是「复制原文」不是「复制纯文本」）');
  assert.match(clip, /\]\(#\/player\/c-math\)/, '课程链接要原样保留');
  assert.match(clip, /05:20/, '整条回答都在，不是只复制了第一段');
});

await check('「更多」→ 复制纯文本：不再有 Markdown 标记，链接只留文字', async () => {
  const ai = firstAiBubble();
  await ai.hover();
  await ai.locator('[data-testid="chat-message-more"]').click();
  const item = page.locator('[data-testid="chat-copy-plain"]');
  await item.waitFor({ timeout: 10000 });
  await item.click();
  const clip = await clipboardUntil((t) => t.includes('侧栏常驻') && !t.includes('**'));
  assert.match(clip, /侧栏常驻/, '文字本身要留下');
  assert.doesNotMatch(clip, /\*\*/, '加粗标记要去掉');
  assert.doesNotMatch(clip, /\]\(#\/player\//, '链接语法要去掉');
  assert.match(clip, /高等数学（上）/, '链接的可见文字要留下');
});

await check('「更多」→ 导出本次会话：文件名与内容都对', async () => {
  const ai = firstAiBubble();
  await ai.hover();
  await ai.locator('[data-testid="chat-message-more"]').click();
  const item = page.locator('[data-testid="chat-export-session"]');
  await item.waitFor({ timeout: 10000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), item.click()]);
  assert.equal(download.suggestedFilename(), `资料-${TARGET_TITLE}.md`, '文件名应当是 资料-<会话标题>.md');
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(await download.path(), 'utf8');
  assert.match(content, new RegExp(`^# ${TARGET_TITLE}`), '文件头是会话标题');
  assert.match(content, /## 我/, '用户轮');
  assert.match(content, /## 助手/, '助手轮');
  assert.match(content, /\]\(#\/player\/c-math\)/, '导出的正文应当是 Markdown 原文');
  assert.match(content, /240–280px/, '整会话都导出了，不只是这一条回答');
});

// §4 原有「顶栏『新建对话』真的新建一条并切过去、消息区回到空态」这条用例，
// 2026-10-15 随那颗按钮一并删掉：顶栏右侧的「设置 / 搜索 / 新建对话」被用户整组否掉
// （见 docs/plans/2026-10-14-对话页改版-design.md 的修订段）。
//
// 入口 2026-10-15 二轮长回来了 —— 落在**侧栏首项「新会话」**（原「AI 助手」，见
// components/appNav.tsx）。等价用例归 `e2e-lazy-session` §6：点一下 → 回到草稿态
// （标题「新会话」、消息区空态、Recent 无选中项、**库里不新增行**）。
// 懒创建之后「点一下新建」不再等于「插一条空行」，所以那条用例必须在
// 有会话在手上的场景里验 —— 本脚本的夹具是直接往 IndexedDB 种回答，
// 种出来的东西验不到「点一下真的切过去」。
// （它专用的 `readSessions()` helper 也一并删了 —— §4 是那个 helper 唯一的使用者，
//  留着就是一段没人调的代码。）

await context.close();
await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
