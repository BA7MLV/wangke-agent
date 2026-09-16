/* eslint-disable no-console */
/**
 * 回归探针：播放器控制栏的 hover 显隐（YouTube 行为）。
 *
 * 实现分两处，探针按这两处的契约量：
 *   1. `Player.tsx` 的 `<MediaPlayer hideControlsOnMouseLeave controlsDelay=24h>` —— vds 内部
 *      状态机（鼠标进入 show(0) / 离开 hide(0)；静止自动隐藏被关掉，状态与悬停视觉同步）；
 *   2. `player-enhance.css` 的 `@media (hover: hover) and (pointer: fine)` —— 视觉显隐，
 *      并兜住 ① 不覆盖的边界：vds 只在 `pointer: fine` 且 **已 started**（播放过）时才注册
 *      mouseenter/mouseleave，所以「刚进页面还没播过」这段只有 CSS 管得住。
 *
 * 断言：
 *   A. 未播放过：鼠标在播放器外 → 控制栏收起；悬停 → 出现；再移出 → 立刻收起（≤400ms）
 *   B. 播放中：悬停 → 出现；移出 → 立刻收起
 *   C. 暂停中：悬停 → 出现；移出 → 立刻收起（旧行为是暂停时常驻）
 *   D. 悬停且鼠标静止 3s → 仍可见（本项目定为「悬停即显示」，不做静止自动隐藏）
 *   E. 触摸语境：实测 `(hover:hover) and (pointer:fine)` 不匹配（hasTouch + isMobile 会让
 *      Chromium 报 pointer:coarse），确认 hover 规则不会误伤触摸端
 *
 * 用法：先起 preview（生产构建才有真实 CSS），再跑
 *   npm run build && npm run preview &
 *   TEST_FILE=/tmp/wangke-test.mp4 node scripts/probe-controls-hover.mjs
 * 退出码：0 = 符合契约；3 = 有回归。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const TEST_FILE = process.env.TEST_FILE;
if (!TEST_FILE) {
  console.error('需要 TEST_FILE=/path/to/video.mp4');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const bad = (msg) => {
  console.error(`   ✗ ${msg}`);
  failed++;
};

/** 读控制栏的「看起来是否可见」：opacity 过渡中会拿到中间值，所以判定要等过渡跑完再读 */
const readControls = () =>
  page.evaluate(() => {
    const el = document.querySelector('.vds-controls');
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return {
      opacity: Number(cs.opacity),
      visibility: cs.visibility,
      // vds 内部的可见状态，用来判断「视觉」与「状态」是否一致
      dataVisible: el.hasAttribute('data-visible'),
    };
  });

const shown = (s) => !s.missing && s.visibility === 'visible' && s.opacity > 0.9;

const controlsVisible = async () => shown(await readControls());

const playerBox = () => page.locator('[data-media-player]').boundingBox();

/** 把鼠标移出播放器（页面左上角，落在左侧导航轨上，不属于播放器） */
const hoverAway = async (settle = 400) => {
  await page.mouse.move(8, 8, { steps: 5 });
  await page.waitForTimeout(settle);
};

/** 把鼠标移到播放器正中（悬停播放器 = 显示控制栏） */
const hoverPlayer = async (settle = 400) => {
  const b = await playerBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await page.waitForTimeout(settle);
};

const expect = async (want, label) => {
  const s = await readControls();
  const got = shown(s);
  if (got === want) {
    ok(`${label} → ${want ? '显示' : '收起'}（opacity=${s.opacity} visibility=${s.visibility} data-visible=${s.dataVisible}）`);
  } else {
    bad(`${label} → 期望${want ? '显示' : '收起'}，实际 ${JSON.stringify(s)}`);
  }
};
const expectVisible = (label) => expect(true, label);
const expectHidden = (label) => expect(false, label);

console.log('0. 导入样片并进入播放页');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });
await page.waitForFunction(
  () => {
    const v = document.querySelector('video');
    return v && v.readyState >= 2 && v.duration > 0;
  },
  { timeout: 15000 },
);
ok('视频已就绪（此时还没播放过：vds 的 mouseenter 监听尚未注册）');

console.log('A. 未播放过：显隐完全由悬停决定');
await hoverAway();
await expectHidden('未播放 + 鼠标在播放器外');
await hoverPlayer();
await expectVisible('未播放 + 悬停播放器');
await page.screenshot({ path: 'e2e-shots/controls-hover-on.png' });
await hoverAway();
await expectHidden('未播放 + 移出播放器');
await page.screenshot({ path: 'e2e-shots/controls-hover-off.png' });

console.log('B. 播放中：悬停出现 / 移出立刻收起');
await page.locator('video').evaluate((v) => v.play());
await page.waitForTimeout(600);
await hoverAway();
await expectHidden('播放中 + 鼠标在播放器外');
await hoverPlayer();
await expectVisible('播放中 + 悬停播放器');

console.log('C. 悬停且鼠标静止 3s：保持显示，且 vds 内部状态同步为可见（静止自动隐藏已关掉）');
await page.waitForTimeout(3000);
await expectVisible('播放中 + 悬停静止 3s');
const idle = await readControls();
if (!idle.dataVisible) {
  bad(`悬停静止后 data-visible 应为 true（否则 [data-visible] 才有的底部渐变背景会掉），实际 ${idle.dataVisible}`);
} else ok('data-visible 与悬停视觉一致');

console.log('D. 暂停中：悬停出现 / 移出收起（旧行为是暂停时常驻）');
await page.locator('video').evaluate((v) => v.pause());
await page.waitForTimeout(300);
await hoverPlayer();
await expectVisible('暂停中 + 悬停播放器');
await hoverAway();
await expectHidden('暂停中 + 移出播放器');

console.log('E. 触摸语境：hover 规则不该生效（hasTouch + isMobile 会让 pointer:coarse 成立）');
const touchCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const touchPage = await touchCtx.newPage();
await touchPage.goto(BASE, { waitUntil: 'networkidle' });
const media = await touchPage.evaluate(() => ({
  hoverFine: matchMedia('(hover: hover) and (pointer: fine)').matches,
  coarse: matchMedia('(pointer: coarse)').matches,
}));
console.log(`   · matchMedia: hover:hover & pointer:fine = ${media.hoverFine} / pointer:coarse = ${media.coarse}`);
if (media.hoverFine) {
  console.log('   · 本机没能模拟出触摸端（仍是 fine pointer），触摸端行为以真机为准');
} else {
  ok('媒体查询不匹配 ⇒ 触摸端不受 hover 规则影响，仍由点击 / idle 逻辑管控制栏');
}
await touchCtx.close();

await browser.close();
if (failed) {
  console.error(`\n❌ 控制栏 hover 显隐回归：${failed} 条断言不通过`);
  process.exit(3);
}
console.log('\n✅ 控制栏 hover 显隐符合契约：悬停出现 / 移出立刻收起（含未播放过、播放中、暂停中）');
