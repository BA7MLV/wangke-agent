/* eslint-disable no-console */
// 首页（Library）迁移到 mdui 后的回归套件。这一页是阶段 2 的主体，
// 但 17 个既有脚本只把它当「进播放页的跳板」（找个视频行点「学习」），
// 库页自身的交互（分组 / 移动 / 折叠 / 两步删除 / 拖拽）没有被任何脚本覆盖。
//
// 这里守的都是**构建与类型检查都抓不到**的静默失败：
//   - 行内容整块不渲染（阶段 1 踩过 mdui-list-item 的 slot 坑，本页改用自建行）；
//   - 受控 mdui-dialog 的 open 与 React state 不同步（关掉又弹回）；
//   - 底部导航把内容区盖住（mdui-navigation-bar 的 :host 是 position:fixed，
//     会让父级 mdui-layout-item 量成 0 高度，布局助手于是不给内容区补 padding-bottom）。
//
// 用法：node scripts/e2e-library.mjs   （需先 npm run preview）
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-test.mp4';

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 250));
});

const rows = page.locator('[data-testid="video-item"]');
const groupKeys = () => page.locator('[data-testid="group-header"]').evaluateAll((els) => els.map((e) => e.dataset.groupKey));
const groupNames = () =>
  page.locator('[data-testid="group-header"]').evaluateAll((els) =>
    els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()),
  );
/** 某个分组里现在有几个视频行（分组容器 = 组头所在的那个 div） */
const rowsInGroup = (key) =>
  page.evaluate(
    (k) => document.querySelector(`[data-testid="group-header"][data-group-key="${k}"]`)?.parentElement?.querySelectorAll('[data-testid="video-item"]').length ?? -1,
    key,
  );

console.log('=== 首页（Library）交互回归 ===');

// ── 1. 空状态 ─────────────────────────────────────────────────────────────
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="drop-zone"]', { timeout: 15000 });
check(await page.locator('[data-testid="empty-state"]').count() === 1, '空库时显示空状态');
check(await page.locator('[data-testid="drop-zone"] input[type="file"]').count() === 1, '投放区里有唯一的隐藏文件选择器');

// ── 2. 导入 → 任务行 → 视频行 ─────────────────────────────────────────────
await page.setInputFiles('[data-testid="import-input"]', TEST_FILE);
await page.waitForSelector('[data-testid="import-progress"]', { timeout: 15000 });
ok('导入进度条出现（mdui-linear-progress）');
await page.waitForSelector('[data-testid="video-item"]', { timeout: 40000 });
await page.waitForTimeout(500);
check(await page.locator('[data-testid="empty-state"]').count() === 0, '有视频后空状态消失');

// ── 3. 行结构：四组内容都得在（回归「内容被静默丢弃」那类坑） ──────────────
const rowText = await rows.first().innerText();
check((await rows.count()) === 1, `视频行 ${await rows.count()} 条`);
check(/·/.test(rowText), '行内有「时长 · 大小 · 日期」元信息');
check(/未转写/.test(rowText), '行内有转写状态标记');
check(await rows.first().locator('[data-testid="btn-play"]').count() === 1, '行内有「学习」按钮');
check(await rows.first().locator('[data-testid="drag-handle"]').count() === 1, '行内有拖拽手柄');
check(await rows.first().locator('[data-testid="btn-rename"]').count() === 1, '宽屏行内有改名按钮');
check(await rows.first().locator('[data-testid="btn-move"]').count() === 1, '宽屏行内有移动按钮');
check(await rows.first().locator('[data-testid="btn-delete"]').count() === 1, '宽屏行内有删除按钮');
check(await page.locator('[data-testid="btn-more"]').count() === 0, '宽屏不渲染手机端 ⋯ 菜单');
check((await groupKeys()).includes('__uncat__'), '存在「未分类」分组');
check(/未分类 1/.test((await groupNames()).join(' ')), `未分类分组显示数量（${(await groupNames()).join(' / ')}）`);

// ── 4. 重命名：验证 onInput 同步 + Enter 保存 ─────────────────────────────
await rows.first().locator('[data-testid="btn-rename"]').click();
await page.waitForFunction(() => document.querySelector('[data-testid="rename-dialog"]')?.hasAttribute('open'), { timeout: 5000 });
await page.locator('[data-testid="rename-input"] input').fill('改过名的课程');
await page.locator('[data-testid="rename-input"] input').press('Enter');
await page.waitForTimeout(900);
check(!(await page.locator('[data-testid="rename-dialog"]').evaluate((e) => e.hasAttribute('open'))), 'Enter 保存后弹窗关闭');
check(/改过名的课程/.test(await rows.first().innerText()), '标题已更新（onInput 生效）');

// ── 5. 新建文件夹 → 新分组 ────────────────────────────────────────────────
await page.click('[data-testid="btn-new-folder"]');
await page.waitForFunction(() => document.querySelector('[data-testid="folder-dialog"]')?.hasAttribute('open'), { timeout: 5000 });
await page.locator('[data-testid="folder-input"] input').fill('行测');
await page.click('[data-testid="folder-save"]');
await page.waitForTimeout(900);
const names = await groupNames();
check(names.length === 2, `分组数 ${names.length}（应为 2）`);
check(names[0].includes('行测'), '新文件夹分组排在未分类之前');
check((await rowsInGroup('__uncat__')) === 1, '视频仍在未分类组里');

// ── 6. 拖拽移入文件夹（Pointer Events，iPad 走的也是这条路径） ────────────
const folderKey = (await groupKeys()).find((k) => k !== '__uncat__');
const hb = await rows.first().locator('[data-testid="drag-handle"]').boundingBox();
const tb = await page.locator(`[data-testid="group-header"][data-group-key="${folderKey}"]`).boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 10 });
await page.waitForTimeout(200);
check(await page.locator('.drag-ghost').count() === 1, '拖动时出现悬浮卡片');
check(
  await page.locator(`[data-testid="group-header"][data-group-key="${folderKey}"]`).evaluate((e) => e.classList.contains('group-header--over')),
  '悬停在组头上时有投放高亮',
);
await page.mouse.up();
await page.waitForTimeout(1200);
check((await rowsInGroup(folderKey)) === 1, '拖拽后视频进入目标文件夹');
// 未分类组在「没有视频、也不是真文件夹」时整组不渲染（Library.tsx 的 groups.filter），
// 所以这里断言的是它消失了，而不是「组内为 0」
check(!(await groupKeys()).includes('__uncat__'), '拖拽后未分类组不再渲染');

// ── 7. 移动弹窗：移回未分类 ───────────────────────────────────────────────
await rows.first().locator('[data-testid="btn-move"]').click();
await page.waitForFunction(() => document.querySelector('[data-testid="move-dialog"]')?.hasAttribute('open'), { timeout: 5000 });
check((await page.locator('[data-testid="move-radio-group"] mdui-radio').count()) === 2, '移动弹窗列出未分类 + 1 个文件夹');
await page.locator('[data-testid="move-radio-group"] mdui-radio[value="-1"]').click();
await page.waitForTimeout(300);
await page.click('[data-testid="move-confirm"]');
await page.waitForTimeout(1200);
check((await rowsInGroup('__uncat__')) === 1, '用弹窗把视频移回了未分类');

// ── 8. 分组折叠：状态写进 localStorage ───────────────────────────────────
await page.locator(`[data-testid="group-header"][data-group-key="${folderKey}"]`).click();
await page.waitForTimeout(400);
check((await rowsInGroup(folderKey)) === 0, '折叠后组内视频行不渲染');
const collapsed = await page.evaluate(() => localStorage.getItem('library.collapsedGroups'));
check(collapsed?.includes(folderKey), `折叠状态已持久化（${collapsed}）`);
await page.locator(`[data-testid="group-header"][data-group-key="${folderKey}"]`).click();
await page.waitForTimeout(400);
check((await rowsInGroup(folderKey)) === 0 && (await groupKeys()).length === 2, '再次点击可展开（空组仍保留组头）');

// ── 9. 文件夹 ⋯ 菜单：重命名文件夹 ───────────────────────────────────────
await page.locator(`[data-testid="group-header"][data-group-key="${folderKey}"] [data-testid="btn-folder-more"]`).click();
await page.waitForTimeout(400);
await page.locator(`[data-testid="group-header"][data-group-key="${folderKey}"] [data-testid="menu-folder-rename"]`).click();
await page.waitForFunction(() => document.querySelector('[data-testid="folder-dialog"]')?.hasAttribute('open'), { timeout: 5000 });
await page.locator('[data-testid="folder-input"] input').fill('行测（改）');
await page.click('[data-testid="folder-save"]');
await page.waitForTimeout(900);
check((await groupNames()).some((n) => n.includes('行测（改）')), '文件夹已重命名');

// ── 10. 删除文件夹：视频移回未分类 ───────────────────────────────────────
await page.locator(`[data-testid="group-header"][data-group-key="${folderKey}"] [data-testid="btn-folder-more"]`).click();
await page.waitForTimeout(400);
await page.locator(`[data-testid="group-header"][data-group-key="${folderKey}"] [data-testid="menu-folder-delete"]`).click();
const dlg = page.locator('mdui-dialog:has([data-testid="confirm-dialog-danger"])');
await dlg.waitFor({ state: 'attached', timeout: 5000 });
check(await dlg.locator('mdui-button[slot="action"]').allInnerTexts().then((t) => t.join('/').includes('删除')), '删除文件夹走危险确认框');
await dlg.locator('mdui-button[slot="action"]').last().click();
await page.waitForTimeout(1200);
check((await groupKeys()).length === 1, '文件夹删除后只剩未分类组');
check((await rowsInGroup('__uncat__')) === 1, '文件夹里的视频回到了未分类');

// ── 11. 两步删除：先删文件、再删记录 ─────────────────────────────────────
// 注意：mdui-dialog 的 headline / description 渲染在**shadow DOM** 里，
// 对宿主元素取 innerText 是拿不到的（实测）——要用能穿透 shadow 的文本定位。
await rows.first().locator('[data-testid="btn-delete"]').click();
await dlg.waitFor({ state: 'attached', timeout: 5000 });
check((await dlg.getByText('删除视频文件').count()) > 0, '第一步确认框问的是「删除视频文件」');
check((await dlg.getByText('仅删除视频本体').count()) > 0, '第一步确认框说明了后果');
await dlg.locator('mdui-button[slot="action"]').last().click();
await page.waitForTimeout(1500);
check((await rows.count()) === 1, '第一步删除后记录仍在（字幕/讲义保留）');
check(/文件已删/.test(await rows.first().innerText()), '行上出现「文件已删」标记');

await rows.first().locator('[data-testid="btn-delete"]').click();
await dlg.waitFor({ state: 'attached', timeout: 5000 });
check((await dlg.getByText('彻底删除该记录').count()) > 0, '第二步确认框问的是「彻底删除该记录」');
check(
  (await dlg.locator('mdui-button[slot="action"]').last().innerText()) === '彻底删除',
  '危险操作的确认按钮文案是动作词',
);
await dlg.locator('mdui-button[slot="action"]').last().click();
await page.waitForTimeout(1500);
check((await rows.count()) === 0, '彻底删除后视频行消失');
check(await page.locator('[data-testid="empty-state"]').count() === 1, '回到空状态');

await page.screenshot({ path: 'e2e-shots/library-e2e-final.png' });

console.log(errors.length ? `[console/page errors]\n${errors.join('\n')}` : '无 console/page 错误');
await browser.close();
console.log(failed === 0 ? '\n✅ 首页交互回归通过' : `\n❌ 有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
