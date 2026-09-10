/**
 * NavigationRail + 标题栏对齐的页面级验证（生产构建，默认打 4173）。
 *
 * 断言（对应 docs/plans/2026-09-10-navigation-rail-design.md「六」）：
 *  1. 1280×800 首页：rail 可见、main padding-left=81、标题文字 x 与内容列左边界同线；
 *  2. 390×844 首页：rail 隐藏、底部导航可见、标题回落到 16px；
 *  3. 1280×800 播放页：rail 常驻且「课程库」高亮，视频区从 rail 右侧开始；
 *  4. 844×390（手机横屏）：rail 与底部导航都不显示。
 *
 * 用法：node scripts/probe-rail-pages.mjs [url]
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4174/';
const SAMPLE = '/tmp/wangke-test.mp4';

if (!existsSync(SAMPLE)) {
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=size=640x360:rate=25:duration=40 -f lavfi -i sine=frequency=440:duration=40 ` +
      `-c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest ${SAMPLE}`,
    { stdio: 'pipe' },
  );
}

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => {
  failed += 1;
  console.log(`  ❌ ${m}`);
};

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

console.log('1. 宽屏首页（1280×800）');
{
  const rail = page.locator('[data-testid="nav-rail"]');
  if (await rail.isVisible()) ok('rail 可见');
  else fail('rail 不可见');
  const mainPad = await page.evaluate(() => getComputedStyle(document.querySelector('mdui-layout-main')).paddingLeft);
  (mainPad === '81px' ? ok : fail)(`main padding-left=${mainPad}（期望 81px，divider 版 rail 宽 5.0625rem）`);
  const xs = await page.evaluate(() => {
    const title = document.querySelector('mdui-top-app-bar-title');
    const inner = document.querySelector('.page-inner');
    const bar = document.querySelector('mdui-top-app-bar');
    const main = document.querySelector('mdui-layout-main');
    return {
      title: Math.round(title.getBoundingClientRect().left),
      content: Math.round(inner.getBoundingClientRect().left) + 16,
      innerLeft: Math.round(inner.getBoundingClientRect().left),
      barLeft: Math.round(bar.getBoundingClientRect().left),
      barWidth: Math.round(bar.getBoundingClientRect().width),
      mainWidth: Math.round(main.getBoundingClientRect().width),
    };
  });
  (Math.abs(xs.title - xs.content) <= 2 ? ok : fail)(`标题 x=${xs.title} vs 内容列左边界 x=${xs.content}（bar ${xs.barLeft}+${xs.barWidth}, main ${xs.mainWidth}, inner.left=${xs.innerLeft}）`);
  if ((await page.locator('[data-testid="nav-settings"]').count()) === 0) ok('宽屏不再有标题栏设置齿轮（rail 承担）');
  else fail('标题栏设置齿轮还在');
  await page.screenshot({ path: 'e2e-shots/rail-home-desktop.png' });
}

console.log('2. 窄屏首页（390×844）');
{
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  if (!(await page.locator('[data-testid="nav-rail"]').isVisible())) ok('rail 隐藏');
  else fail('rail 在窄屏仍可见');
  if (await page.locator('[data-testid="bottom-nav"]').isVisible()) ok('底部导航可见');
  else fail('底部导航不可见');
  const xs = await page.evaluate(() => {
    const title = document.querySelector('mdui-top-app-bar-title');
    const inner = document.querySelector('.page-inner');
    return { title: Math.round(title.getBoundingClientRect().left), content: Math.round(inner.getBoundingClientRect().left) + 16 };
  });
  (Math.abs(xs.title - xs.content) <= 2 ? ok : fail)(`标题 x=${xs.title} vs 内容列 x=${xs.content}（窄屏两者都应≈16）`);
  await page.screenshot({ path: 'e2e-shots/rail-home-mobile.png' });
}

console.log('3. 导入样片 → 宽屏播放页');
await page.setViewportSize({ width: 1280, height: 800 });
await page.setInputFiles('input[type="file"]', SAMPLE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 60000 });
ok('样片已导入');
await page.locator('[data-testid="btn-play"]').first().click();
await page.waitForSelector('[data-media-player]', { timeout: 30000 });
await page.waitForTimeout(1200);
{
  const railVisible = await page.locator('[data-testid="nav-rail"]').isVisible();
  (railVisible ? ok : fail)('播放页 rail 可见');
  const homeActive = await page.evaluate(() => {
    const item = document.querySelector('[data-testid="nav-rail-home"]');
    return item?.hasAttribute('active');
  });
  (homeActive ? ok : fail)(`播放页 rail「课程库」高亮（active=${homeActive}）`);
  const videoX = await page.evaluate(() => Math.round(document.querySelector('.video-pane').getBoundingClientRect().left));
  (videoX >= 81 ? ok : fail)(`视频区左缘 x=${videoX}（应从 rail 右侧 81 起）`);
  await page.screenshot({ path: 'e2e-shots/rail-player-desktop.png' });
}

console.log('4. 手机横屏（844×390）');
{
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(500);
  const railVisible = await page.locator('[data-testid="nav-rail"]').isVisible();
  const bottomVisible = await page.locator('[data-testid="bottom-nav"]').count() > 0 &&
    (await page.locator('[data-testid="bottom-nav"]').isVisible());
  if (!railVisible && !bottomVisible) ok('rail 与底部导航都不显示');
  else fail(`rail=${railVisible}, bottom=${bottomVisible}，横屏那档应都不显示`);
  await page.screenshot({ path: 'e2e-shots/rail-player-landscape.png' });
}

await browser.close();
console.log(failed === 0 ? '\n✅ NavigationRail 验证全部通过' : `\n❌ ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
