/* eslint-disable no-console */
/**
 * 回归探针：播放器的 YouTube 式细节（2026-09-16 之后的第二档改造）。
 *
 * 覆盖四件事，每一件都对应一处容易在后续改动里被无声打掉的契约：
 *   A. 中央大播放按钮：只在「本次打开还没播过」时出现，且**不随控制栏 hover 显隐**
 *      （它在 .vds-controls 之外）；点完要把键盘焦点交给播放器，否则按钮卸载时的
 *      focusout 会把快捷键一起关掉。
 *   B. 键盘步长：←/→ = ±5s、j/l = ±10s、Home/End 跳两端；连按同侧要累加（5→10→15）。
 *   C. 进度条 hover 预览：缩略图卡片出得来且已解码，时间胶囊叠在卡片内部底端。
 *   D. 控制栏：投屏按钮已摘除、时间字号 13px 且等宽数字。
 *   E. 影院模式：按钮在全屏按钮前，切换后隐藏侧栏、播放器铺满，切回恢复且面板不卸载。
 *
 * 用法：先起 preview（生产构建才有真实 CSS），再跑
 *   npm run build && npm run preview &
 *   TEST_FILE=/tmp/wangke-test.mp4 node scripts/probe-yt-player.mjs
 * 退出码：0 = 符合契约；3 = 有回归。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const TEST_FILE = process.env.TEST_FILE;
if (!TEST_FILE) {
  console.error('需要 TEST_FILE=/path/to/video.mp4');
  process.exit(1);
}
const OUT = 'e2e-shots/youtube-ui';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const bad = (msg) => {
  console.error(`   ✗ ${msg}`);
  failed++;
};

/** 播放位置与播放状态。用 [data-media-provider] 前缀圈定主视频 —— 进度条预览的
 *  第二个 <video> 也在页面里，裸 'video' 会选到两个（Playwright 严格模式直接报错）。 */
const state = () =>
  page.evaluate(() => {
    const v = document.querySelector('[data-media-provider] video');
    return { paused: v.paused, t: Number(v.currentTime.toFixed(2)) };
  });

console.log('0. 导入样片并进入播放页');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('[data-media-provider] video', { timeout: 15000 });
await page.waitForFunction(
  () => {
    const v = document.querySelector('[data-media-provider] video');
    return v && v.readyState >= 2 && v.duration > 0;
  },
  { timeout: 15000 },
);
ok('视频已就绪');

const playerBox = await page.locator('[data-media-player]').boundingBox();
const moveTo = async (x, y) => {
  await page.mouse.move(x, y, { steps: 6 });
  await page.waitForTimeout(320);
};

console.log('A. 中央大播放按钮');
// 鼠标停在播放器外：控制栏该收起，但大播放按钮要照常可见
await moveTo(playerBox.x - 60, playerBox.y - 60);
const bigPlay = page.locator('[data-testid="player-big-play"]');
if (await bigPlay.isVisible()) ok('未播放过 + 鼠标在播放器外 → 大播放按钮仍可见（不随控制栏显隐）');
else bad('大播放按钮应常驻（不随 hover 显隐）');
await page.screenshot({ path: `${OUT}/20-player-bigplay.png`, clip: playerBox });

await bigPlay.click();
await page.waitForTimeout(500);
let s = await state();
if (!s.paused) ok(`点击后开始播放（t=${s.t}）`);
else bad('点击大播放按钮后应开始播放');
if ((await bigPlay.count()) === 0) ok('播放后大按钮已移除');
else bad('播放后大按钮应移除');

// 焦点是否真的交给了播放器：vidstack 的快捷键默认只在播放器持有焦点时生效
await page.keyboard.press('k');
await page.waitForTimeout(300);
s = await state();
if (s.paused) ok('按 k 暂停（焦点已由大按钮转交播放器）');
else bad('按 k 未生效：大按钮点完没有把焦点交给播放器');

console.log('B. 键盘步长（YouTube：←/→ 5s、j/l 10s、Home/End 跳两端、连按累加）');
const expect = async (label, key, want, tol = 0.6) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(350);
  const now = (await state()).t;
  if (Math.abs(now - want) <= tol) ok(`${label} → ${now}s`);
  else bad(`${label} 应到 ${want}s，实际 ${now}s`);
};
await page.keyboard.press('Home');
await page.waitForTimeout(400);
await expect('→', 'ArrowRight', 5);
await expect('l', 'l', 15);
await expect('j', 'j', 5);
await expect('Home', 'Home', 0);

// 连按累加：3 次 → 约 15s（若只走 5s 说明累加窗口没生效）
await page.keyboard.press('Home');
await page.waitForTimeout(400);
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(120);
}
await page.waitForTimeout(450);
s = await state();
if (s.t > 12 && s.t < 20) ok(`连按 3 次 → ${s.t}s（累加生效）`);
else bad(`连按 3 次应约 15s，实际 ${s.t}s（累加窗口失效？）`);

console.log('C. 进度条 hover 预览卡片');
const slider = await page.locator('.vds-time-slider').boundingBox();
await moveTo(slider.x + slider.width * 0.75, slider.y + slider.height / 2);
await page.waitForTimeout(700);
const preview = await page.evaluate(() => {
  const wrap = document.querySelector('.vds-slider-preview');
  const frame = wrap?.querySelector('.player-preview-frame');
  const inner = wrap?.querySelector('.player-preview-video');
  const pill = wrap?.querySelector('.vds-slider-value');
  const rect = (el) => {
    const r = el?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) } : null;
  };
  return {
    frame: rect(frame),
    pill: rect(pill),
    readyState: inner?.readyState ?? null,
    hasFrame: (inner?.videoWidth ?? 0) > 0,
    time: inner ? Number(inner.currentTime.toFixed(1)) : null,
  };
});
if (preview.frame && preview.frame.w > 100 && preview.frame.h > 50) ok(`缩略图卡片 ${preview.frame.w}×${preview.frame.h}px`);
else bad(`缩略图卡片尺寸异常：${JSON.stringify(preview.frame)}`);
if (preview.hasFrame && preview.readyState >= 2) ok(`预览帧已解码（readyState=${preview.readyState}, t=${preview.time}s）`);
else bad(`预览帧未解码（readyState=${preview.readyState}）`);
if (preview.pill && preview.frame && preview.pill.top >= preview.frame.top && preview.pill.bottom <= preview.frame.bottom + 1)
  ok('时间胶囊叠在缩略图内部底端');
else bad('时间胶囊应叠在缩略图上');
await page.screenshot({ path: `${OUT}/21-player-preview.png`, clip: playerBox });

console.log('D. 控制栏细节');
if ((await page.locator('.vds-google-cast-button').count()) === 0) ok('Google Cast 按钮已摘除（未接入投屏，留着是噪音）');
else bad('仍存在不可用的投屏按钮');
const typo = await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector('.vds-time'));
  return { size: cs.fontSize, numeric: cs.fontVariantNumeric };
});
if (typo.size === '13px' && typo.numeric.includes('tabular-nums')) ok(`时间 ${typo.size} / ${typo.numeric}`);
else bad(`时间排版异常：${JSON.stringify(typo)}`);

console.log('E. 影院模式');
const theaterButton = page.locator('[data-testid="theater-mode-button"]');
const fullscreenButton = page.locator('.vds-fullscreen-button');
if (await theaterButton.isVisible()) ok('桌面控制栏显示影院模式按钮');
else bad('桌面控制栏应显示影院模式按钮');

const buttonOrder = await page.evaluate(() => {
  const theater = document.querySelector('[data-testid="theater-mode-button"]');
  const fullscreen = document.querySelector('.vds-fullscreen-button');
  if (!theater || !fullscreen || theater.parentElement !== fullscreen.parentElement) return null;
  return theater.compareDocumentPosition(fullscreen) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after';
});
if (buttonOrder === 'before') ok('影院按钮位于全屏按钮左侧');
else bad(`影院按钮顺序异常：${buttonOrder}`);

const panelCount = await page.locator('.side-pane').count();
const normalWidth = (await page.locator('[data-media-player]').boundingBox())?.width ?? 0;
await theaterButton.click();
await page.waitForTimeout(250);
const theaterLayout = page.locator('.player-layout--theater');
const theaterWidth = (await page.locator('[data-media-player]').boundingBox())?.width ?? 0;
if ((await theaterLayout.count()) === 1 && (await theaterButton.getAttribute('aria-pressed')) === 'true') {
  ok('点击后进入影院模式并更新可访问状态');
} else bad('点击后未进入影院模式');
if (!(await page.locator('.side-pane').isVisible()) && theaterWidth > normalWidth * 1.25) {
  ok(`侧栏隐藏，播放器 ${Math.round(normalWidth)}px → ${Math.round(theaterWidth)}px`);
} else bad(`影院几何异常（sideVisible=${await page.locator('.side-pane').isVisible()}, ${normalWidth} → ${theaterWidth}）`);

await theaterButton.click();
await page.waitForTimeout(250);
const restoredWidth = (await page.locator('[data-media-player]').boundingBox())?.width ?? 0;
if ((await page.locator('.player-layout--theater').count()) === 0 && (await page.locator('.side-pane').isVisible())) {
  ok('再次点击恢复视频 + 面板分栏');
} else bad('再次点击后未恢复分栏');
if ((await page.locator('.side-pane').count()) === panelCount && Math.abs(restoredWidth - normalWidth) < 3) {
  ok('侧栏保持挂载，播放器宽度恢复');
} else bad('切换影院模式不应卸载侧栏或改变恢复后的几何');

await page.setViewportSize({ width: 800, height: 900 });
await page.waitForTimeout(400);
if (!(await theaterButton.isVisible())) ok('窄屏隐藏影院按钮');
else bad('窄屏不应显示影院按钮');

await browser.close();
if (failed > 0) {
  console.error(`\n❌ 播放器 YouTube 化契约有 ${failed} 处回归`);
  process.exit(3);
}
console.log('\n✅ 播放器 YouTube 化契约符合预期：大播放按钮 / 键盘步长 / 进度条缩略图预览 / 控制栏细节 / 影院模式');
