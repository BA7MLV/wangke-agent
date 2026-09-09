/* eslint-disable no-console */
// 移动端 UI 链路（无需 API key）：手机视口下库页操作列、播放页底部 Tab 布局、面板切换与保活
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
await page.waitForSelector('.ant-list-item', { timeout: 30000 });
await page.screenshot({ path: 'e2e-shots/mobile-library.png' });

console.log('2. 库页手机操作列：改名/删除收进 ⋯ 菜单');
const moreBtn = page.locator('.ant-list-item button:has(.anticon-more)');
if ((await moreBtn.count()) !== 1) fail('列表项应有 1 个 ⋯ 菜单按钮');
else ok('⋯ 菜单按钮存在');
const standaloneRename = await page.locator('.ant-list-item > .ant-list-item-action button:has(.anticon-edit)').count();
if (standaloneRename !== 0) fail('手机端不应有外显的改名按钮');
else ok('改名已收进菜单');
await moreBtn.click();
await page.locator('.ant-dropdown-menu-item:has-text("重命名")').waitFor({ timeout: 3000 });
ok('菜单展开且含「重命名」');
await page.keyboard.press('Escape');

console.log('3. 进入播放页：手机端应为 视频 + 面板 + 底部 Tab 栏（无桌面 Tabs）');
await page.click('button:has-text("学习")');
await page.waitForSelector('video', { timeout: 15000 });
await page.waitForFunction(
  () => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.duration > 0; },
  { timeout: 15000 },
);
ok('视频已加载');
if ((await page.locator('.mobile-tabbar').count()) !== 1) fail('应存在 .mobile-tabbar');
else ok('底部 Tab 栏存在');
if ((await page.locator('.ant-tabs').count()) !== 0) fail('手机端不应渲染桌面 antd Tabs');
else ok('桌面 Tabs 未渲染');

console.log('4. 视频宽度撑满面板（≤390px），Tab 栏贴底可见');
const vBox = await page.locator('[data-media-player]').boundingBox();
const tabBox = await page.locator('.mobile-tabbar').boundingBox();
if (!vBox || vBox.width > 390) fail(`视频宽 ${vBox?.width} 超出视口`);
else ok(`视频宽 ${Math.round(vBox.width)}px`);
if (!tabBox) fail('Tab 栏不可见');
else ok(`Tab 栏位于底部 y=${Math.round(tabBox.y)}`);

console.log('5. 默认字幕面板可见，其余面板隐藏但保活（DOM 仍在）');
const slots = page.locator('.panel-slot');
if ((await slots.count()) !== 3) fail(`应有 3 个 panel-slot，实际 ${await slots.count()}`);
const visibility = await page.evaluate(() =>
  [...document.querySelectorAll('.panel-slot')].map((s) => ({
    hidden: s.hasAttribute('hidden'),
    childAlive: s.childElementCount > 0,
  })),
);
if (!visibility.every((v) => v.childAlive)) fail('隐藏面板的 DOM 应保留（保活）');
else ok('三面板 DOM 均保活');
if (visibility[0].hidden || !visibility[1].hidden || !visibility[2].hidden) fail('默认应只显示字幕面板');
else ok('默认显示字幕面板');
if (!(await page.locator('.panel-slot:not([hidden]) button:has-text("生成字幕")').count())) fail('字幕面板应有「生成字幕」按钮');
else ok('字幕面板就绪');

console.log('6. 切换到「讲义」：讲义面板显示，字幕面板隐藏');
await page.locator('.mobile-tabbar button', { hasText: '讲义' }).click();
await page.waitForTimeout(200);
const handoutVisible = await page.locator('.panel-slot:not([hidden]) button:has-text("生成讲义")').count();
if (!handoutVisible) fail('讲义面板应显示「生成讲义」按钮（无字幕时禁用但可见）');
else ok('讲义面板显示');
const subsNowHidden = await page.evaluate(() => document.querySelectorAll('.panel-slot')[0].hasAttribute('hidden'));
if (!subsNowHidden) fail('切走后字幕面板应隐藏');
else ok('字幕面板已隐藏（display:none 保活）');

console.log('7. 切换到「问答」：无字幕时显示引导文案');
await page.locator('.mobile-tabbar button', { hasText: '问答' }).click();
await page.waitForTimeout(200);
const chatGuide = await page.locator('.panel-slot:not([hidden])', { hasText: '请先在「字幕」页生成字幕' }).count();
if (!chatGuide) fail('问答面板应显示字幕引导文案');
else ok('问答引导文案显示');

console.log('8. 切回「字幕」：状态保留（按钮仍在）');
await page.locator('.mobile-tabbar button', { hasText: '字幕' }).click();
await page.waitForTimeout(200);
if (!(await page.locator('.panel-slot:not([hidden]) button:has-text("生成字幕")').count())) fail('切回字幕后内容丢失');
else ok('字幕面板状态保留');
await page.screenshot({ path: 'e2e-shots/mobile-player.png' });

console.log('9. 触控尺寸：页头返回按钮 ≥40px');
const backBox = await page.locator('.page-header button').first().boundingBox();
if (!backBox || backBox.height < 40) fail(`返回按钮高 ${backBox?.height}px，应 ≥40`);
else ok(`返回按钮 ${Math.round(backBox.height)}px`);

console.log('10. 拉到平板宽度（900px 档）应回退为桌面 Tabs 布局');
await page.setViewportSize({ width: 800, height: 1000 });
await page.waitForTimeout(300);
if ((await page.locator('.ant-tabs').count()) !== 1) fail('800px 应渲染 antd Tabs');
else ok('antd Tabs 已渲染');
if ((await page.locator('.mobile-tabbar').count()) !== 0) fail('800px 不应有 mobile-tabbar');
else ok('mobile-tabbar 已移除');

await browser.close();
if (process.exitCode) process.exit(process.exitCode);
console.log('✅ 移动端链路通过：库页 ⋯ 菜单 / 底部 Tab 布局 / 面板切换保活 / 触控尺寸 / 断点回退全部正常');
