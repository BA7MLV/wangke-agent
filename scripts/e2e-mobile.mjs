/* eslint-disable no-console */
// 移动端 UI 链路（无需 API key）：手机视口下库页操作列、播放页底部导航布局、面板切换与保活、
// 以及横屏（852×393）的「左视频 / 右侧栏」左右分栏。
// 阶段 3 起：底部 Tab 栏换成 mdui-navigation-bar（同一批 panel-tab-* testid 两档通用），
// 横屏与桌面共用「侧栏 + mdui-tabs」，且旋转不再强制切换面板（保持用户所在的面板）。
// 用法：TEST_FILE=/path/to/video.mp4 node scripts/e2e-mobile.mjs（需先 npm run preview）
import { chromium } from 'playwright';

const TEST_FILE = process.env.TEST_FILE;
if (!TEST_FILE) { console.error('需要 TEST_FILE'); process.exit(1); }

// iPhone 14 竖屏视口
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

const fail = (msg) => { console.error(`❌ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`   ✓ ${msg}`);

console.log('1. 手机视口打开首页并导入测试视频');
await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
await page.screenshot({ path: 'e2e-shots/mobile-library.png' });

console.log('2. 库页手机操作列：改名/删除收进 ⋯ 菜单');
const moreBtn = page.locator('[data-testid="video-item"] [data-testid="btn-more"]');
if ((await moreBtn.count()) !== 1) fail('列表项应有 1 个 ⋯ 菜单按钮');
else ok('⋯ 菜单按钮存在');
const standaloneRename = await page.locator('[data-testid="video-item"] [data-testid="btn-rename"]').count();
if (standaloneRename !== 0) fail('手机端不应有外显的改名按钮');
else ok('改名已收进菜单');
await moreBtn.click();
const renameMenu = page.locator('[data-testid="menu-rename"]');
await renameMenu.waitFor({ timeout: 3000 });
const renameText = await renameMenu.innerText();
if (!renameText.includes('重命名')) fail('菜单项应含「重命名」文案');
else ok('菜单展开且含「重命名」');
await page.keyboard.press('Escape');

console.log('3. 进入播放页：竖屏应为 视频 + 面板区 + 底部导航（无桌面 Tabs）');
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });
await page.waitForFunction(
  () => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.duration > 0; },
  { timeout: 15000 },
);
ok('视频已加载');
if ((await page.locator('[data-testid="bottom-nav"]').count()) !== 1) fail('应存在底部导航（mdui-navigation-bar）');
else ok('底部导航存在');
if ((await page.locator('[data-testid="panel-tabs"]').count()) !== 0) fail('竖屏不应渲染桌面 mdui-tabs');
else ok('桌面 Tabs 未渲染');

console.log('4. 视频宽度撑满面板（≤390px），导航栏贴底可见');
const vBox = await page.locator('[data-media-player]').boundingBox();
const navBox = await page.locator('[data-testid="bottom-nav"]').boundingBox();
if (!vBox || vBox.width > 390) fail(`视频宽 ${vBox?.width} 超出视口`);
else ok(`视频宽 ${Math.round(vBox.width)}px`);
if (!navBox) fail('底部导航不可见');
else ok(`底部导航位于底部 y=${Math.round(navBox.y)}`);

console.log('5. 默认字幕面板可见，其余面板隐藏但保活（DOM 仍在）');
const slots = page.locator('.panel-slot');
if ((await slots.count()) !== 5) fail(`应有 5 个 panel-slot，实际 ${await slots.count()}`);
const visibility = await page.evaluate(() =>
  [...document.querySelectorAll('.panel-slot')].map((s) => ({
    hidden: s.hasAttribute('hidden'),
    childAlive: s.childElementCount > 0,
  })),
);
if (!visibility.every((v) => v.childAlive)) fail('隐藏面板的 DOM 应保留（保活）');
else ok('五面板 DOM 均保活');
if (visibility[0].hidden || visibility.slice(1).some((v) => !v.hidden)) fail('默认应只显示字幕面板');
else ok('默认显示字幕面板');
if (!(await page.locator('.panel-slot:not([hidden]) [data-testid="subs-generate"]').count())) fail('字幕面板应有「生成字幕」按钮');
else ok('字幕面板就绪');

console.log('6. 切换到「讲义」：讲义面板显示，字幕面板隐藏');
await page.click('[data-testid="panel-tab-handout"]');
await page.waitForTimeout(300);
const handoutVisible = await page.locator('.panel-slot:not([hidden]) [data-testid="handout-generate"]').count();
if (!handoutVisible) fail('讲义面板应显示「生成讲义」按钮（无字幕时禁用但可见）');
else ok('讲义面板显示');
const subsNowHidden = await page.evaluate(() => document.querySelectorAll('.panel-slot')[0].hasAttribute('hidden'));
if (!subsNowHidden) fail('切走后字幕面板应隐藏');
else ok('字幕面板已隐藏（display:none 保活）');

console.log('7. 切换到「问答」：无字幕时显示引导文案');
await page.click('[data-testid="panel-tab-chat"]');
await page.waitForTimeout(300);
const chatGuide = await page.locator('.panel-slot:not([hidden])', { hasText: '请先在「字幕」页生成字幕' }).count();
if (!chatGuide) fail('问答面板应显示字幕引导文案');
else ok('问答引导文案显示');

console.log('8. 切回「字幕」：状态保留（按钮仍在）');
await page.click('[data-testid="panel-tab-subs"]');
await page.waitForTimeout(300);
if (!(await page.locator('.panel-slot:not([hidden]) [data-testid="subs-generate"]').count())) fail('切回字幕后内容丢失');
else ok('字幕面板状态保留');
await page.screenshot({ path: 'e2e-shots/mobile-player.png' });

console.log('9. 触控尺寸：标题栏返回按钮 ≥40px');
const backBox = await page.locator('[data-testid="nav-back"]').first().boundingBox();
if (!backBox || backBox.height < 40) fail(`返回按钮高 ${backBox?.height}px，应 ≥40`);
else ok(`返回按钮 ${Math.round(backBox.height)}px`);

console.log('10. 拉到平板宽度（800px）应回退为侧栏 + mdui-tabs 布局');
await page.setViewportSize({ width: 800, height: 1000 });
await page.waitForTimeout(300);
if ((await page.locator('[data-testid="panel-tabs"]').count()) !== 1) fail('800px 应渲染 mdui-tabs');
else ok('mdui-tabs 已渲染');
if ((await page.locator('[data-testid="bottom-nav"]').count()) !== 0) fail('800px 不应有底部导航');
else ok('底部导航已移除');

/** 一次性量出布局的关键盒子（避免多次 round-trip 读到不同帧）。
 *  竖屏读 .panel-slot 的 hidden；横屏/桌面读 mdui-tab-panel 的 active —— 两套容器都量，各取所需。 */
const measure = () =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return {
      layoutDir: getComputedStyle(document.querySelector('.player-layout')).flexDirection,
      video: box('[data-media-player]'),
      pane: box('.video-pane'),
      host: box('.panel-host'),
      side: box('.side-pane'),
      tabs: box('[data-testid="panel-tabs"]'),
      nav: box('[data-testid="bottom-nav"]'),
      tabActive: document.querySelector('mdui-tab-panel[active]')?.getAttribute('value') ?? '',
      slotStates: [...document.querySelectorAll('.panel-slot')].map((s) => !s.hasAttribute('hidden')),
    };
  });

console.log('11. 转到横屏（852×393）：左视频 / 右侧栏，mdui-tabs 落在右栏顶部');
await page.setViewportSize({ width: 852, height: 393 });
await page.waitForTimeout(400);
const land = await measure();
if (land.layoutDir !== 'row') fail(`横屏 .player-layout 应为 row，实际 ${land.layoutDir}`);
else ok('.player-layout 左右分栏（row）');
if (!land.video || !land.side || !land.tabs) fail('横屏下 video / side-pane / mdui-tabs 应都存在');
else {
  if (land.pane.x + land.pane.w > land.side.x + 1) fail('视频应在侧栏左侧');
  else ok(`视频在左（x=${Math.round(land.pane.x)}，宽 ${Math.round(land.video.w)}）`);
  // 切换条（mdui-tabs）在侧栏顶部：它自身应当就从侧栏顶部开始
  if (land.tabs.y > land.side.y + 2) fail(`切换条应贴侧栏顶部（tabs y=${Math.round(land.tabs.y)}，side y=${Math.round(land.side.y)}）`);
  else ok(`切换条在右栏顶部（y=${Math.round(land.tabs.y)}）`);
  if (land.video.w < land.side.w) fail(`视频宽 ${Math.round(land.video.w)} 应大于右栏宽 ${Math.round(land.side.w)}（黄金比例）`);
  else ok(`左视频 ${Math.round(land.video.w)}px > 右栏 ${Math.round(land.side.w)}px`);
  // 黄金比例 φ≈1.618:1：左视频占大头。比的是两栏容器宽（视频元素本身会因高度约束缩窄）
  const ratio = land.pane.w / land.side.w;
  if (ratio < 1.55 || ratio > 1.7) fail(`左/右栏宽比 ${ratio.toFixed(2)} 应接近黄金比例 1.618`);
  else ok(`黄金比例分栏（左:右 ≈ ${ratio.toFixed(2)}:1）`);
  // 视频不能被裁到视口外（宽度受可用高度 × 16:9 约束）
  if (land.video.h > 393 - 36) fail(`视频高 ${Math.round(land.video.h)} 超出可用高度`);
  else ok(`视频 ${Math.round(land.video.w)}×${Math.round(land.video.h)} 完整可见`);
  if (land.side.w < 240) fail(`右栏宽 ${Math.round(land.side.w)} 太窄，会话不可用`);
  else ok(`右栏宽 ${Math.round(land.side.w)}px`);
}

console.log('12. 转进横屏保持当前面板（不强制跳转）');
if (land.tabActive !== 'subs') fail(`横屏应保持「字幕」，实际「${land.tabActive}」`);
else ok('保持当前面板（字幕）');

console.log('13. 横屏下切到「讲义」：面板换内容、视频仍在左侧');
await page.click('[data-testid="panel-tab-handout"]');
await page.waitForTimeout(400);
const land2 = await measure();
if (land2.tabActive !== 'handout') fail(`切讲义后激活面板应为 handout，实际「${land2.tabActive}」`);
else ok('讲义面板激活');
if (!(await page.locator('mdui-tab-panel[active] [data-testid="handout-generate"]').count())) fail('讲义面板内容丢失');
else ok('讲义面板内容就绪');
if (land2.layoutDir !== 'row') fail('切面板后仍应保持左右分栏');
else ok('左右分栏保持');
await page.screenshot({ path: 'e2e-shots/mobile-landscape.png' });

console.log('14. 转回竖屏（390×844）：回到底部导航布局，且保留当前面板（不强制回字幕）');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const back = await measure();
if (back.layoutDir !== 'column') fail(`竖屏 .player-layout 应为 column，实际 ${back.layoutDir}`);
else ok('竖屏上下堆叠');
if (!back.nav || !back.host) fail('竖屏应有底部导航与面板区');
else if (back.nav.y < back.host.y) fail('竖屏导航栏应回到面板下方');
else ok('导航栏回到贴底');
if (back.slotStates[1] !== true || back.slotStates.filter((v) => v).length !== 1) fail('竖屏应保留「讲义」面板');
else ok('保留当前面板（讲义）');

console.log('15. 直接在横屏刷新：默认落在字幕（不走「旋转」这条路）');
await page.setViewportSize({ width: 852, height: 393 });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-media-player]', { timeout: 15000 });
await page.waitForTimeout(400);
const fresh = await measure();
if (fresh.layoutDir !== 'row') fail('横屏刷新后应为左右分栏');
else if (fresh.tabActive !== 'subs') fail(`横屏刷新默认应为字幕，实际「${fresh.tabActive}」`);
else ok('横屏直接打开 → 左视频 / 右字幕');

console.log('16. 多尺寸横屏 + 矮视口（模拟键盘弹出）→ 视频不裁、右栏不被压死');
// 667×375 = 最小的常见横屏手机；932×430 = 最大的；852×220 = 键盘弹出后的可视高度
// （矮视口下视频宽度由「可用高度 × 16:9」接手而变窄，所以这里比的是左右两栏的宽度，不是视频元素）
for (const [w, h] of [
  [667, 375],
  [932, 430],
  [852, 220],
]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(300);
  const m = await measure();
  if (m.layoutDir !== 'row') fail(`${w}×${h} 应为左右分栏`);
  else if (m.pane.w <= m.side.w) fail(`${w}×${h} 左栏 ${Math.round(m.pane.w)} 应宽于右栏 ${Math.round(m.side.w)}`);
  else if (m.video.h > h - 36) fail(`${w}×${h} 视频高 ${Math.round(m.video.h)} 超出可用高度`);
  else if (m.side.w < 200) fail(`${w}×${h} 右栏宽 ${Math.round(m.side.w)} 过窄`);
  else ok(`${w}×${h}：视频 ${Math.round(m.video.w)}×${Math.round(m.video.h)}，右栏宽 ${Math.round(m.side.w)}`);
}

await browser.close();
if (process.exitCode) process.exit(process.exitCode);
console.log('✅ 移动端链路通过：库页 ⋯ 菜单 / 竖屏底部导航 / 横屏左视频右侧栏 / 面板切换保活 / 断点回退 / 多尺寸横屏全部正常');
