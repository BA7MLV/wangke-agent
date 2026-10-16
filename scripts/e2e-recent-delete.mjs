/* eslint-disable no-console */
/**
 * Recent 侧栏删除的行为验证。
 *
 * 守三件事：
 *   1. 点行尾的删除**不会**顺手切会话（按钮挡冒泡，ListBox 的选中不该被触发）
 *   2. 删掉**非当前**会话时，当前会话不被换掉
 *   3. 删掉**当前**会话时，自动切到剩下的最后一个；**删到不剩时落到草稿态**
 *      （Recent 整组消失、库里 0 行）—— 这是懒创建改掉的那条不变量，
 *      见 docs/plans/2026-10-15-懒创建会话-design.md §二
 *
 * ⚠️ 会话全部由 `seedSessions` 自己种。懒创建之后「挂载即现开一条新会话」那个副作用
 * 没有了，所以不能再等 Recent 出现再种 —— 空库进去 Recent 压根不渲染。
 *
 * 用法：BASE_URL=http://localhost:5173 node scripts/e2e-recent-delete.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.log(`❌ ${m}`);
  failures++;
};
let failures = 0;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => fail(`pageerror: ${String(e).slice(0, 200)}`));

/**
 * 当前选中的会话 id（读 aria-selected，那才是 ListBox 的真状态）。返回裸 id，不带前缀
 *
 * ⚠️ 过滤条件必须是 `-menu-`，不是 `delete`：行尾那颗**垃圾桶**已经没有了
 * （四个动作 2026-10-15 收进一颗「更多」菜单，见
 * docs/plans/2026-10-15-recent-会话操作菜单-design.md），但 `RecentItem.deleteTestId`
 * 还留在接口里 —— 照它过滤的话，「更多」那颗触发器（`chat-recent-<id>-menu-trigger`）
 * 会被当成一行读进来，于是每个 id 都出现两次、长度断言全部错位。
 */
const ROW_FILTER = ':not([data-testid*="-menu-"])';

const activeId = () =>
  page.evaluate((filter) => {
    const rows = [...document.querySelectorAll(`[data-testid^="chat-recent-"]${filter}`)];
    return rows.find((n) => n.getAttribute('aria-selected') === 'true')?.getAttribute('data-testid').replace('chat-recent-', '') ?? null;
  }, ROW_FILTER);

const recentIds = () =>
  page.evaluate(
    (filter) =>
      [...document.querySelectorAll(`[data-testid^="chat-recent-"]${filter}`)].map((n) =>
        n.getAttribute('data-testid').replace('chat-recent-', ''),
      ),
    ROW_FILTER,
  );

/**
 * 打开某条会话的删除确认框（行尾「更多」→ 删除）。
 *
 * 走菜单而不是行尾图标：那颗垃圾桶已经不渲染了，点 `chat-recent-delete-*`
 * 会一直等一个不存在的元素 —— 而失败信息只会说「超时」，看不出是入口搬了家。
 * 菜单的退出动画约 150ms，**等它真的从 DOM 走了**再点确认，否则会点到正在退场的浮层
 * （`body intercepts pointer events`，同 e2e-recent-menu 的教训）。
 */
const openDeleteConfirm = async (id) => {
  await page.hover(`[data-testid="chat-recent-${id}"]`);
  await page.click(`[data-testid="chat-recent-${id}-menu-trigger"]`);
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  await page.click(`[data-testid="chat-recent-${id}-menu-delete"]`);
  await page.waitForSelector('[role="menu"]', { state: 'detached', timeout: 5000 });
  await page.waitForSelector('[data-testid="confirm-dialog-danger"]', { timeout: 5000 });
};

/**
 * 直接往库里插 `count` 条课程助手会话。
 *
 * 为什么不再点顶栏那颗「新建对话」：它 2026-10-15 被删了（顶栏右侧的
 * 「设置 / 搜索 / 新建对话」被整组否掉，见 docs/plans/2026-10-14-对话页改版-design.md
 * 的修订段）。这里用写库替代 —— 代价是**绕过了 UI 的建会话路径**，可以接受：
 * 本脚本守的是 Recent 的删除行为，建会话只是准备动作。
 *
 * 行的形状必须跟 store 的 `newSessionRow()` 对齐（`videoId` 用课程助手的保留 id
 * `__library_assistant__`）—— 差一个字段 Recent 就过滤不出来，脚本会以
 * 「起始会话数不足」失败，那种失败信息不会告诉你是形状写错了。
 * `createdAt` 递增是刻意的：Recent 按它升序排，「当前」要落在最后一条。
 */
const seedSessions = (count) =>
  page.evaluate(async (n) => {
    const req = indexedDB.open('wangke');
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const base = Date.now();
    // 等事务 complete 再 close：事务还挂着时 close 会把它 abort 掉
    await new Promise((res, rej) => {
      const tx = db.transaction('chatSessions', 'readwrite');
      const store = tx.objectStore('chatSessions');
      for (let i = 0; i < n; i++) {
        store.add({ videoId: '__library_assistant__', title: '新会话', createdAt: base + i });
      }
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, count);

await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
// 先把夹具种进去，**再**等 Recent 出现。顺序不能反：懒创建之后空库进去是草稿态，
// Recent 整组都不渲染，先等它必然超时（见文件头）。
//
// 种 4 条而不是 3 条：下面四个场景要依次删掉 1（非当前）+1（当前）+1（键盘）+1（删到不剩），
// 而场景 4 断言「键盘删完当前会话不变」，所以它删的那条必须**不是**当前那条 ——
// 3 条时删完场景 3 只剩一条，场景 4 就会把自己的当前会话删掉。
await seedSessions(4);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid^="chat-recent-"]', { timeout: 15000 });
await page.waitForTimeout(800);

const before = await recentIds();
console.log(`起点 Recent：${before.join(', ')}`);
if (before.length < 3) fail(`起始会话数不足 3：${before.length}`);

// ── 场景 1：点删除不切会话 ────────────────────────────────────────────────
{
  const active = await activeId();
  const victim = before.find((id) => id !== active);
  await openDeleteConfirm(victim);
  await page.waitForTimeout(300);

  const afterClick = await activeId();
  if (afterClick === active) ok(`点删除按钮没有触发切换（仍是 ${active}）`);
  else fail(`点删除按钮把会话切走了：${active} → ${afterClick}`);

  const dialogVisible = await page.locator('[data-testid="confirm-dialog-danger"]').count();
  if (dialogVisible === 1) ok('弹出删除确认框');
  else fail('点删除没有弹确认框');

  await page.click('[data-testid="confirm-dialog-cancel"]');
  await page.waitForTimeout(400);
  const afterCancel = await recentIds();
  if (afterCancel.length === before.length) ok('取消后会话一条没少');
  else fail(`取消后仍然删了东西：${before.length} → ${afterCancel.length}`);
}

// ── 场景 2：删非当前会话，当前会话不动 ───────────────────────────────────
{
  const active = await activeId();
  const victim = before.find((id) => id !== active);
  await openDeleteConfirm(victim);
  await page.waitForTimeout(300);
  await page.click('[data-testid="confirm-dialog-confirm"]');
  await page.waitForTimeout(800);

  const now = await recentIds();
  if (!now.includes(victim)) ok(`非当前会话 ${victim} 已删除`);
  else fail(`会话 ${victim} 还在列表里`);

  const activeAfter = await activeId();
  if (activeAfter === active) ok(`当前会话没有被换掉（仍是 ${active}）`);
  else fail(`删非当前会话却把当前会话换了：${active} → ${activeAfter}`);
}

// ── 场景 3：删当前会话，自动切到剩下的最后一个 ────────────────────────────
{
  const active = await activeId();
  await openDeleteConfirm(active);
  await page.waitForTimeout(300);
  await page.click('[data-testid="confirm-dialog-confirm"]');
  await page.waitForTimeout(1000);

  const now = await recentIds();
  if (!now.includes(active)) ok(`当前会话 ${active} 已删除`);
  else fail(`当前会话 ${active} 还在`);

  const activeAfter = await activeId();
  if (activeAfter && activeAfter !== active) ok(`自动切到剩下的会话 ${activeAfter}`);
  else fail(`删掉当前会话后没有切换（还是 ${activeAfter}）`);
}

// ── 场景 4：键盘 Delete 删掉「焦点所在」那一行（不必是当前会话）───────────
{
  const rows = page.locator(`[data-testid^="chat-recent-"]${ROW_FILTER}`);
  const before = await recentIds();
  const active = await activeId();
  // 走到第一行（非当前），按 Delete
  await rows.first().evaluate((e) => e.focus());
  await page.waitForTimeout(250);
  const victim = before[0];
  await page.keyboard.press('Delete');
  await page.waitForTimeout(350);
  if ((await page.locator('[data-testid="confirm-dialog-danger"]').count()) === 1) {
    ok('键盘 Delete 弹出确认框');
    await page.click('[data-testid="confirm-dialog-confirm"]');
    await page.waitForTimeout(800);
    const after = await recentIds();
    if (!after.includes(victim)) ok(`键盘 Delete 删掉了焦点所在的 ${victim}`);
    else fail(`键盘 Delete 没有删掉 ${victim}`);
    const activeAfter = await activeId();
    if (activeAfter === active) ok(`键盘删除也没有换掉当前会话（${active}）`);
    else fail(`键盘删除把当前会话换了：${active} → ${activeAfter}`);
  } else {
    fail('键盘 Delete 没有弹出确认框');
  }
}

// ── 场景 5：删到一条不剩 → **草稿态**（不再补一条空会话）────────────────────
{
  for (let guard = 0; guard < 10; guard++) {
    const active = await activeId();
    if (!active) break;
    await openDeleteConfirm(active);
    await page.waitForTimeout(250);
    await page.click('[data-testid="confirm-dialog-confirm"]');
    await page.waitForTimeout(700);
  }
  const left = await recentIds();
  if (left.length === 0) ok('删到不剩时 Recent 里一条都不剩');
  else fail(`删到不剩时还剩 ${left.length} 条：${left.join(',')}`);

  // 直接读库：这才是「有没有偷偷补一条空会话」的判据。DOM 上看不见不等于库里没有
  // —— 上一版就是靠 DOM 断言，而那时的 store 会在删完之后**立刻**补一条，
  // 界面上看着「留了 1 条」还挺正常。
  const rowsInDb = await page.evaluate(async () => {
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
  if (rowsInDb === 0) ok('库里一条会话行都不剩（没有补空会话）');
  else fail(`库里还留着 ${rowsInDb} 条会话行`);

  // 草稿态没有对应的会话行，所以 Recent 里不该有任何选中项
  const stillActive = await activeId();
  if (stillActive === null) ok('没有选中项（草稿态）');
  else fail(`删到不剩后还有选中项：${stillActive}`);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
await browser.close();
process.exit(failures ? 1 : 0);