/* eslint-disable no-console */
/**
 * 窄屏导航抽屉的收尾契约：关掉抽屉之后页面必须还能点。
 *
 * HeroUI Drawer → RAC `ModalOverlay` 的退场靠 Web Animations API 判定
 * （`getAnimations()` + `animation.finished`）。那条 promise 没兑现时，
 * `data-exiting="true"` 会一直挂着 —— 留下一块 `position: fixed; inset: 0`
 * 的透明遮罩，**整页点不动**。症状：关掉菜单后随便点什么都没反应，
 * 探针里表现为后续 `page.click` 一直超时。
 *
 * 现在 `layout.tsx` 在 `drawerOpen` 为 false 时直接卸载整棵 Drawer
 * （代价是关抽屉没有淡出动画），这个脚本守的就是那条「卸载后不留残骸」。
 *
 * 两种关闭路径都要测：Esc、以及点抽屉里的导航项 —— 后者还会顺带触发
 * `onNavigate` 收起抽屉，是真实的移动端用法。
 *
 * 用法：BASE_URL=http://localhost:5173 node scripts/probe-drawer-overlay.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
let failures = 0;
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.log(`❌ ${m}`);
  failures++;
};

/** 抽屉打开状态下点导航项：抽屉里的那份，不是宽屏常驻那份 */
const clickInDrawer = (page, testId) =>
  page.locator(`[data-slot="drawer-dialog"] [data-testid="${testId}"]`).click();

async function scenario(page, label, closeVia) {
  await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="nav-rail-open"]', { timeout: 15000 });
  await page.waitForTimeout(600);

  await page.click('[data-testid="nav-rail-open"]');
  await page.waitForTimeout(600);
  if ((await page.locator('[data-slot="drawer-backdrop"]').count()) === 0) {
    fail(`${label}：抽屉没打开`);
    return;
  }

  await closeVia(page);
  await page.waitForTimeout(1000);

  const leftovers = await page.locator('[data-slot="drawer-backdrop"]').count();
  if (leftovers === 0) ok(`${label}：关闭后没有残留遮罩`);
  else fail(`${label}：关闭后还剩 ${leftovers} 块遮罩，页面会被挡住`);

  // 真的点一下：遮罩还在的话这里会一直重试到超时。
  //
  // 点顶栏的汉堡（`nav-rail-open`），不是聊天输入框 —— 后者在 `sessionReady` 之前是
  // **disabled** 的，而 Playwright 的 click 会等元素可点，于是「页面明明点得动」也会
  // 因为这一条超时（实测：reduced-motion 档下首屏 bootstrap 慢半拍，两处误报）。
  // 汉堡是窄屏顶栏常驻的真实控件、任何时候都是 enabled，点中即打开抽屉，
  // 是「页面真的接收到了这次点击」最干净的证据。
  //
  // （原先点的是顶栏那颗「新建对话」，它 2026-10-15 随顶栏右侧三个控件一起删了。）
  let clickable = true;
  try {
    await page.click('[data-testid="nav-rail-open"]', { timeout: 3000 });
  } catch {
    clickable = false;
  }
  if (clickable) ok(`${label}：关闭后页面仍可点击`);
  else fail(`${label}：关闭后页面点不动（点顶栏汉堡 3s 超时）`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

// reduced-motion 开与关都跑一遍：开了它 HeroUI 会把 transition 关掉，
// 退出动画直接不播 —— 曾经以为那是触发条件，实测两种模式都复现，别漏掉任一边。
for (const reducedMotion of ['reduce', 'no-preference']) {
  console.log(`\n=== prefers-reduced-motion: ${reducedMotion} ===`);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion });
  await scenario(page, 'Esc 关闭', (p) => p.keyboard.press('Escape'));
  await scenario(page, '点导航项关闭', (p) => clickInDrawer(p, 'nav-rail-chat'));
  await page.close();
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
await browser.close();
process.exit(failures ? 1 : 0);