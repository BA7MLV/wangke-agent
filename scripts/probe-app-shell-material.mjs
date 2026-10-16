/* eslint-disable no-console */
// 应用外壳（PageShell）的结构与适配验证。跑在本地 dev/preview 上：
//   BASE_URL=http://127.0.0.1:5180 node scripts/probe-app-shell-material.mjs
//
// 外壳版式已经全部并进 HeroUI 组件 + Tailwind 工具类，没有自写类名可以选择了，
// 所以这里一律用 data-testid 与语义角色定位。守三件事：
//   1. 宽屏侧栏常驻、每个路由都高亮当前项，且顶栏没有折叠入口；
//   2. 窄屏侧栏隐藏、抽屉承载**同一份**导航，键盘 Enter 能跳转且跳完自动收起；
//   3. 三路由 × 三视口 × 明暗：标题层级、导航可达、不溢出、skip-link 保路由。
//
// 第 3 组为什么值得逐格跑：外壳是**所有页面共用**的一层，一处溢出会同时
// 出现在 9 个组合里，而单看某一个页面截图很难发现「只有横屏那档坏了」。
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = (process.env.BASE_URL || 'http://127.0.0.1:5180').replace(/\/$/, '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Use a local test server');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
// 路由 → [路径, 侧栏项 key, 期望标题, 期望高亮的那一项]。
// ⚠️ 首页是**「新会话」入口**（`/` → CourseChat），课程库在 `/library`；`/settings` 已改成
// 重定向（设置是全局弹窗，不是页面），所以它不进这张表。
//
// 第 4 列与第 2 列**故意不同**：侧栏首项是个**动作**（`NavItem.isAction`，新会话），
// 它从不进 `selectedKeys` —— 高亮表示「你在哪」，而动作不是一个地方。所以首页那一格
// 的期望高亮是 `null`（谁都别亮）。断言它「不选中」而不是干脆不看它，是因为
// 「点了新会话之后侧栏亮了一格」正是这一轮要排除的假象。
const routes = [
  ['/', 'chat', null, null],
  ['/library', 'home', '资料', 'home'],
  ['/study', 'study', '学习', 'study'],
];
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const titleHeading = page.locator('[data-testid="top-app-bar"] h1');
const rail = page.locator('[data-testid="nav-rail"]');
const railOpen = page.locator('[data-testid="nav-rail-open"]');
const main = page.locator('[data-testid="page-main"]');
const go = async (path) => {
  await page.goto(`${base}/#${path}`, { waitUntil: 'networkidle' });
  await titleHeading.waitFor();
  await settle();
};
/** 轮询等元素从可见集里消失 —— 抽屉的关闭动画时长不固定，固定 sleep 会假红 */
const waitGone = async (selector, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await page.locator(selector).count()) === 0) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

try {
  // ── 1. 宽屏：侧栏常驻，每个路由都高亮当前项 ─────────────────────────────
  await go('/');
  assert.equal(await rail.isVisible(), true, '宽屏侧栏常驻可见');
  assert.equal(await railOpen.count(), 0, '宽屏顶栏没有汉堡按钮（没有可开合的侧栏）');
  for (const [path, key, , selected] of routes) {
    await go(path);
    const actual = await page.locator(`[data-testid="nav-rail-${key}"]`).getAttribute('aria-selected');
    if (selected == null) assert.notEqual(actual, 'true', `${path}: 动作项（新会话）不该有选中态`);
    else assert.equal(actual, 'true', `${path}: 侧栏当前项高亮`);
  }
  console.log('✓ 宽屏侧栏常驻，每个路由的高亮与「无折叠入口」都成立');

  // ── 2. 窄屏：侧栏消失，抽屉承载同一份导航 ───────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  assert.equal(await rail.isVisible(), false, '窄屏侧栏隐藏');
  assert.equal(await railOpen.isVisible(), true, '窄屏顶栏汉堡按钮可见');
  for (const [path, key] of routes) {
    await go('/');
    // `go()` 只改 hash，页面不会重载 —— 上一次关闭抽屉的退出动画可能还在跑，
    // 那时 backdrop 仍然盖在上面并拦截指针事件，直接点汉堡会一直重试到超时。
    await waitGone('[data-slot="drawer-backdrop"]');
    await railOpen.click();
    await page.waitForTimeout(300);
    const item = page.locator(`[data-testid="nav-rail-${key}"]:visible`);
    assert.equal(await item.count(), 1, `${path}: 抽屉里只有一份导航项`);
    await item.focus();
    await item.press('Enter');
    await page.waitForURL(`${base}/#${path}`);
    await settle();
    assert.equal(
      await waitGone(`[data-testid="nav-rail-${key}"]:visible`),
      true,
      `${path}: 跳转后抽屉自动收起`,
    );
  }
  console.log('✓ 窄屏抽屉承载同一份导航，键盘跳转后自动收起');

  // ── 3. 三路由 × 三视口 × 明暗：外壳不溢出、导航可达、skip-link 保路由 ──
  for (const theme of ['light', 'dark']) {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      for (const [path, key, title, selected] of routes) {
        await go(path);
        await page.evaluate((value) => {
          document.documentElement.classList.toggle('dark', value === 'dark');
        }, theme);
        await settle();
        const scope = `${theme} ${viewport.width}×${viewport.height} ${path}`;

        assert.equal(await titleHeading.count(), 1, `${scope}: 恰好一个原生 H1 标题`);
        // 首页的标题是当前会话名（无会话时回落「AI 助手」），不是固定文案，
        // 所以只对有确定标题的页面比对文案。
        const heading = await titleHeading.innerText();
        assert(heading.trim().length > 0, `${scope}: 标题非空`);
        if (title) assert.equal(heading, title, `${scope}: 标题文案`);
        assert(
          await page
            .locator('.section-card__title')
            .evaluateAll((headings) => headings.every((heading) => heading.tagName === 'H2')),
          `${scope}: 内容分区的标题是原生 H2`,
        );

        // 导航可达：宽屏靠侧栏，窄屏靠顶栏汉堡按钮，两者至少有一个在
        const railVisible = await rail.isVisible();
        const openVisible = await railOpen.isVisible();
        assert(railVisible || openVisible, `${scope}: 至少有一条导航入口可见`);
        if (railVisible) {
          const actual = await page.locator(`[data-testid="nav-rail-${key}"]`).getAttribute('aria-selected');
          if (selected == null) assert.notEqual(actual, 'true', `${scope}: 动作项（新会话）不该有选中态`);
          else assert.equal(actual, 'true', `${scope}: 侧栏当前项高亮`);
        }

        // 外壳三块都不能越出视口左右边界
        const geometry = await page.evaluate(() =>
          ['nav-rail', 'top-app-bar', 'page-main'].map((id) => {
            const element = document.querySelector(`[data-testid="${id}"]`);
            const box = element.getBoundingClientRect();
            return { name: id, left: box.left, right: box.right, visible: element.getClientRects().length > 0 };
          }),
        );
        for (const box of geometry) {
          if (!box.visible) continue;
          assert(box.left >= -1 && box.right <= viewport.width + 1, `${scope}: ${box.name} 越出视口`);
        }
        assert(
          await page
            .locator('[data-testid="page-main"] > div')
            .evaluate((inner) => inner.scrollWidth <= inner.clientWidth + 1),
          `${scope}: 内容列没有横向溢出`,
        );

        // skip-link：只移动焦点，不能把 HashRouter 的路由改掉
        const hash = new URL(page.url()).hash;
        const skip = page.locator('[data-testid="skip-link"]');
        await skip.focus();
        await skip.press('Enter');
        assert.equal(new URL(page.url()).hash, hash, `${scope}: skip-link 保持路由不变`);
        assert.equal(
          await main.evaluate((element) => document.activeElement === element),
          true,
          `${scope}: 焦点落到内容区`,
        );
      }
    }
  }

  assert.deepEqual(errors, [], '没有未捕获的页面错误');
  console.log('✓ 三路由 × 三视口 × 明暗：标题层级、导航可达、不溢出、skip-link 全部成立');
} finally {
  await context.close();
  await browser.close();
}
