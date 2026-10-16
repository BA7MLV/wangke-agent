/* eslint-disable no-console */
// E2E：侧栏 Recent 的行尾菜单（右键 + 点「更多」两个入口）、四个动作、归档过滤与恢复。
//
// 为什么不需要 API key：这一整轮要验的全在**渲染与交互层** —— 菜单能不能被两种手势打开、
// 置顶后排序有没有变、归档后 Recent 里有没有少这一条、设置里那张卡有没有把它接住。
// 直接往 chats 表里种几条写好的会话即可，让模型把它吐出来反而更慢更不稳。
//
// 覆盖点：
//   1. 每行只有**一颗**行尾图标（「更多」）—— 重心就是这一颗
//   2. 宽屏：行尾「更多」**只认悬停**，选中行 / 焦点行都不常驻
//   3. 点「更多」→ 菜单打开，四个动作都在
//   4. 右键整行 → **同一个**菜单打开（宽屏的第二入口）
//   5. 菜单开着时，锚点按钮不跟着鼠标隐身
//   6. 重命名 → 输入框回车 → 侧栏与顶栏标题一起变
//   7. 置顶 → 该行排到 Recent 最前
//   8. 归档 → 该行从 Recent 消失
//   9. 设置 → 数据 → 已归档会话 → 能看到它，且能恢复回 Recent
//  10. 窄屏：行尾「更多」常驻显形（触屏没有 hover，藏起来就等于入口不存在）
//
// ⚠️ 夹具自己种（见 `seedOneSession`）：懒创建之后「挂载即现开一条新会话」那个副作用
// 已经没有了，空库进去 Recent 整组都不渲染。归档/删除到一条不剩会落到**草稿态**
// （Recent 消失、顶栏标题变「新会话」）—— 那条不变量由 e2e-lazy-session 守，本脚本只借用它。
//
// 用法：npm run preview &  然后 node scripts/e2e-recent-menu.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';

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

/** 课程库助手的 videoId 哨兵值（会话与消息都挂在它下面） */
const AID = '__library_assistant__';

/**
 * 种一条「有内容」的会话当夹具。
 *
 * ⚠️ **必须自己种，不能靠页面挂载的副作用**。上一版这里写的是「对话页每次挂载都会现开
 * 一条『新会话』」—— 那条路已经在懒创建里删掉了：空库进去是**草稿态**，
 * 一条会话行都没有，Recent 整组都不渲染，`waitForSelector` 必然超时。
 * 见 docs/plans/2026-10-15-懒创建会话-design.md。
 */
const seedOneSession = () =>
  page.evaluate(async (aid) => {
    const req = indexedDB.open('wangke');
    const idb = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const now = Date.now();
    const tx = idb.transaction(['chatSessions', 'chats'], 'readwrite');
    const add = (store, row) =>
      new Promise((res, rej) => {
        const r = store.add(row);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const sid = await add(tx.objectStore('chatSessions'), {
      videoId: aid,
      title: '待整理会话',
      createdAt: now,
    });
    await add(tx.objectStore('chats'), {
      videoId: aid,
      sessionId: sid,
      role: 'user',
      content: '这条会话是夹具',
      createdAt: now,
    });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    idb.close();
  }, AID);

await page.goto(`${BASE}/#/chat`, { waitUntil: 'networkidle' });
await seedOneSession();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid^="chat-recent-"]', { timeout: 20000 });

/**
 * Recent 里当前所有**行**的标题。
 *
 * `:not([data-testid*="-menu-"])` 不能省：行尾那颗按钮的 testid 是
 * `chat-recent-<id>-menu-trigger`，四个菜单项是 `…-menu-rename` 之类，
 * 全都以 `chat-recent-` 开头。不排掉的话标题数组里会混进菜单文字，
 * 断言就会在「菜单恰好开着」的时候莫名其妙地过（实测过一次）。
 */
const recentTitles = () =>
  page.$$eval(
    '[data-testid^="chat-recent-"]:not([data-testid*="-menu-"])',
    (nodes) => nodes.map((n) => n.textContent?.trim() ?? ''),
  );

/** 菜单是否开着（HeroUI 的下拉菜单根节点带这个类） */
const menuOpen = () => page.$$eval('.dropdown__menu', (nodes) => nodes.length > 0);

/**
 * 关掉菜单并**等它真的从 DOM 走了**。
 *
 * ⚠️ 不能只 `keyboard.press('Escape')` 就接着做下一步：菜单有约 150ms 的退出动画，
 * 动画期间它还挡在那一行上，于是下一次右键打到的是正在退场的菜单而不是会话行 ——
 * `onContextMenu` 压根没触发，菜单就永远开着，后面每一条断言连锁失败
 * （实测症状：行首图标还在，点它报「body intercepts pointer events」）。
 */
const closeMenu = async () => {
  if (!(await menuOpen())) return;
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dropdown__menu', { state: 'detached', timeout: 5000 });
};

/** 第一行的「更多」触发器 */
const firstTrigger = () =>
  page.waitForSelector('[data-testid^="chat-recent-"][data-testid$="-menu-trigger"]');

/** 由触发器的 testid 推出行 id（触发器 = `<行 id>-menu-trigger`） */
const rowIdOf = async (trigger) => (await trigger.getAttribute('data-testid')).replace('-menu-trigger', '');

/**
 * 等某条会话出现在 Recent 里。
 *
 * ⚠️ **不能只等对话框消失就读列表**：重命名 / 恢复都要先落 IndexedDB 再 `setState`，
 * 对话框关掉的那一刻列表往往还是旧的。固定 sleep 更糟 —— 慢机器上不够、快机器上白等。
 * 这里轮询 DOM，等的是**用户真正看得见的那个结果**。
 */
const waitForRecentTitle = (needle) =>
  page.waitForFunction(
    (want) =>
      [...document.querySelectorAll('[data-testid^="chat-recent-"]:not([data-testid*="-menu-"])')]
        .some((n) => (n.textContent ?? '').includes(want)),
    needle,
    { timeout: 5000 },
  );

/**
 * 等焦点回到 `selector` 内部。
 *
 * 点完「恢复」，那一行的按钮就从 DOM 里没了，焦点随之落空 —— React Aria 的
 * FocusContainment 要等下一次 commit 才把焦点收回弹窗内（实测约 50ms）。
 * 在这之前按 Esc，事件根本没人接，设置面板纹丝不动。**焦点没回来之前别按 Esc。**
 */
const waitForFocusInside = (selector) =>
  page.waitForFunction(
    (sel) => {
      const root = document.querySelector(sel);
      const active = document.activeElement;
      return !!root && !!active && root.contains(active);
    },
    selector,
    { timeout: 5000 },
  );

await check('Recent 渲染出至少一条会话', async () => {
  const titles = await recentTitles();
  assert.ok(titles.length >= 1, `Recent 是空的：${JSON.stringify(titles)}`);
});

await check('每行只有一颗行尾图标（「更多」）', async () => {
  const counts = await page.$$eval(
    '[data-testid^="chat-recent-"]:not([data-testid*="-menu-"])',
    (rows) => rows.map((row) => row.querySelectorAll('[data-testid*="-menu-trigger"]').length),
  );
  assert.deepEqual(
    counts.filter((n) => n !== 0 && n !== 1),
    [],
    `有行挂了 0 或多于一颗行尾图标：${JSON.stringify(counts)}`,
  );
  assert.ok(counts.some((n) => n === 1), '一颗行尾图标都没找到');
});

/**
 * 宽屏下的显形规则：**只认悬停**。
 *
 * 这条断言是冲着两个曾经的例外来的 —— 「当前选中行」「键盘焦点行」都让按钮常驻。
 * 它们不是随手加的（设计文档 §3 沿用了删除按钮那套），但代价是宽屏上总有一两颗
 * 省略号一直亮着，而那颗按钮**键盘根本 Tab 不到**（ListBox 是复合控件，整组只占
 * 一个 tab 停靠点）—— 也就是焦点行上那颗是「看得见、点不到」的假象。
 * 去掉之后键盘用户的路径是 ContextMenu / Shift+F10 与 Delete，一条没少。
 *
 * ⚠️ 断言要挑**选中行**而不是随便一行：只测「鼠标移开 → 全 0」的话，
 * 把 `data-[selected=true]` 那条例外加回来照样能过。
 */
await check('宽屏：行尾「更多」只认悬停 —— 选中行 / 焦点行都不常驻', async () => {
  // 先把指针移出列表（上一条断言可能把它留在某一行上），等过渡落定
  await page.mouse.move(900, 700);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid^="chat-recent-"][data-testid$="-menu-trigger"]')].every(
        (n) => Number(getComputedStyle(n).opacity) === 0,
      ),
    null,
    { timeout: 5000 },
  );

  const selected = await page.$$eval(
    '[data-testid^="chat-recent-"][data-selected="true"] [data-testid$="-menu-trigger"]',
    (nodes) => nodes.map((n) => Number(getComputedStyle(n).opacity)),
  );
  assert.deepEqual(selected, [0], `选中行的「更多」还在常驻：${JSON.stringify(selected)}`);

  // 悬停这一行 → 它显形，其余仍是 0
  const row = await page.waitForSelector('[data-testid^="chat-recent-"]:not([data-testid*="-menu-"])');
  const rowId = await row.getAttribute('data-testid');
  await row.hover();
  await page.waitForFunction(
    (id) => {
      const btn = document.querySelector(`[data-testid="${id}-menu-trigger"]`);
      return !!btn && Number(getComputedStyle(btn).opacity) === 1;
    },
    rowId,
    { timeout: 5000 },
  );
  const others = await page.$$eval(
    '[data-testid^="chat-recent-"][data-testid$="-menu-trigger"]',
    (nodes, id) =>
      nodes.filter((n) => n.getAttribute('data-testid') !== `${id}-menu-trigger`).map((n) => Number(getComputedStyle(n).opacity)),
    rowId,
  );
  assert.ok(others.every((o) => o === 0), `悬停一行时别的行也亮了：${JSON.stringify(others)}`);
});

await check('点「更多」→ 菜单打开且四个动作都在', async () => {
  await (await firstTrigger()).click();
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  const labels = await page.$$eval('[role="menu"] [role="menuitem"]', (nodes) =>
    nodes.map((n) => n.textContent?.trim() ?? ''),
  );
  for (const want of ['重命名', '归档', '删除']) {
    assert.ok(labels.some((l) => l.includes(want)), `菜单里没有「${want}」：${JSON.stringify(labels)}`);
  }
  assert.ok(
    labels.some((l) => l.includes('置顶') || l.includes('取消置顶')),
    `菜单里没有置顶项：${JSON.stringify(labels)}`,
  );
  await closeMenu();
});

await check('右键整行 → 同一个菜单也打开，且焦点落在菜单里', async () => {
  const row = await page.waitForSelector('[data-testid^="chat-recent-"]');
  await row.click({ button: 'right' });
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  const labels = await page.$$eval('[role="menu"] [role="menuitem"]', (nodes) =>
    nodes.map((n) => n.textContent?.trim() ?? ''),
  );
  assert.ok(labels.some((l) => l.includes('删除')), `右键菜单内容不对：${JSON.stringify(labels)}`);
  // 焦点没进菜单的话，方向键与 Escape 都收不到 —— 右键开出来的菜单就成了只能看不能用的浮层
  const role = await page.evaluate(() => document.activeElement?.getAttribute('role'));
  assert.ok(
    role === 'menu' || role === 'menuitem',
    `右键后焦点不在菜单里（activeElement role=${role}）`,
  );
  await closeMenu();
});

await check('点菜单外面 → 菜单关掉', async () => {
  await (await firstTrigger()).click();
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  await page.mouse.click(900, 500);
  await page.waitForSelector('.dropdown__menu', { state: 'detached', timeout: 5000 });
});

/**
 * 菜单开着的那一行，锚点按钮不能跟着鼠标隐身。
 *
 * 菜单是锚在这颗按钮上弹出的（§1 方案 B）。按钮一隐身，菜单就浮在空气里 ——
 * 而这条规则**只在鼠标移开那一行时才看得出来**，鼠标停在按钮上去读 opacity 永远是 1。
 * 所以必须把指针挪到菜单上再读。
 */
await check('菜单开着的那一行：锚点按钮不隐身', async () => {
  await closeMenu();
  const trigger = await firstTrigger();
  const rowId = await rowIdOf(trigger);
  await trigger.click();
  const menu = await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  await menu.hover(); // 指针离开那一行，按钮失去 hover
  await page.waitForFunction(
    (id) => {
      const btn = document.querySelector(`[data-testid="${id}-menu-trigger"]`);
      return !!btn && Number(getComputedStyle(btn).opacity) === 1;
    },
    rowId,
    { timeout: 5000 },
  );
  await closeMenu();
});

await check('重命名 → 回车 → 侧栏标题变了', async () => {
  await closeMenu();
  const before = await recentTitles();
  const trigger = await firstTrigger();
  const rowId = await rowIdOf(trigger);
  await trigger.click();
  await page.click(`[data-testid="${rowId}-menu-rename"]`);
  await page.waitForSelector('[data-testid="prompt-dialog"]', { timeout: 5000 });
  await page.fill('[data-testid="prompt-dialog-input"]', '改过的标题');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="prompt-dialog"]', { state: 'detached', timeout: 5000 });
  await waitForRecentTitle('改过的标题');
  const after = await recentTitles();
  assert.ok(
    after.some((t) => t.includes('改过的标题')),
    `改名没落到侧栏：${JSON.stringify({ before, after })}`,
  );
});

await check('置顶 → 该行排到 Recent 最前', async () => {
  await closeMenu();
  const trigger = await firstTrigger();
  const rowId = await rowIdOf(trigger);
  await trigger.click();
  await page.click(`[data-testid="${rowId}-menu-pin"]`);
  await closeMenu();
  await waitForRecentTitle('改过的标题');
  const titles = await recentTitles();
  assert.ok(
    titles[0].includes('改过的标题'),
    `置顶的那条没排在最前：${JSON.stringify(titles)}`,
  );
});

await check('归档 → 该行从 Recent 消失', async () => {
  await closeMenu();
  const trigger = await firstTrigger();
  const rowId = await rowIdOf(trigger);
  await trigger.click();
  await page.click(`[data-testid="${rowId}-menu-archive"]`);
  await page.waitForSelector('[data-testid="confirm-dialog"]', { timeout: 5000 });
  await page.click('[data-testid="confirm-dialog-confirm"]');
  await page.waitForSelector('[data-testid="confirm-dialog"]', { state: 'detached', timeout: 5000 });
  // 归档掉的正是**唯一**那条：Recent 会整个消失（懒创建之后落到草稿态，不再补一条空会话），
  // 所以这里等的是「它不见了」，不能等「列表还有内容」。
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('[data-testid^="chat-recent-"]:not([data-testid*="-menu-"])')].some((n) =>
        (n.textContent ?? '').includes('改过的标题'),
      ),
    null,
    { timeout: 5000 },
  );
  const titles = await recentTitles();
  assert.ok(
    !titles.some((t) => t.includes('改过的标题')),
    `归档之后 Recent 里还有它：${JSON.stringify(titles)}`,
  );
});

await check('设置 → 数据 → 已归档会话：能看到并恢复', async () => {
  await closeMenu();
  await page.click('[data-testid="nav-rail-settings"]');
  await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 10000 });
  await page.click('[data-testid="settings-nav-data"]');
  await page.waitForSelector('[data-testid="card-archived-sessions"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid^="archived-restore-"]', { timeout: 10000 });
  await page.click('[data-testid^="archived-restore-"]');
  await page.waitForSelector('[data-testid^="archived-restore-"]', { state: 'detached', timeout: 5000 });
  await waitForFocusInside('[data-testid="settings-modal"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="settings-modal"]', { state: 'detached', timeout: 5000 });
  await waitForRecentTitle('改过的标题');
  const titles = await recentTitles();
  assert.ok(
    titles.some((t) => t.includes('改过的标题')),
    `恢复之后 Recent 里没有它：${JSON.stringify(titles)}`,
  );
});

await check('窄屏：行尾「更多」常驻显形（没有 hover 也点得到）', async () => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(400);
  const opacity = await page.$$eval('[data-testid^="chat-recent-"][data-testid$="-menu-trigger"]', (nodes) =>
    nodes.map((n) => Number(getComputedStyle(n).opacity)),
  );
  assert.ok(opacity.length > 0, '没找到行尾按钮');
  assert.ok(
    opacity.every((o) => o === 1),
    `窄屏下有按钮是透明的（触屏点不到）：${JSON.stringify(opacity)}`,
  );
});

await browser.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);