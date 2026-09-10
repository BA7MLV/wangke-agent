/* eslint-disable no-console */
// 播放器增强链路：倍速快捷按钮（内置 5 档含 4x + 设置页配置的自定义倍速）/ 双击左右 ±10s（涟漪反馈）/
// 字幕字号循环按钮（持久化）
// 用法：TEST_FILE=/path/to/video.mp4 node scripts/e2e-player-enhance.mjs（需先 npm run preview）
import { chromium } from 'playwright';

const TEST_FILE = process.env.TEST_FILE;
if (!TEST_FILE) { console.error('需要 TEST_FILE'); process.exit(1); }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

const fail = (msg) => { console.error(`❌ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`   ✓ ${msg}`);

console.log('1. 打开首页并导入测试视频');
await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });

console.log('2. 进入播放页，等待视频就绪');
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });
await page.waitForFunction(
  () => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.duration > 0; },
  { timeout: 15000 },
);
ok('视频已加载');

console.log('3. 倍速快捷按钮：5 档平铺（含 4x），点击 4x 生效且高亮');
const rateBtns = page.locator('.rate-btn-full');
if ((await rateBtns.count()) !== 5) fail(`应有 5 个倍速按钮，实际 ${await rateBtns.count()}`);
await page.locator('.rate-btn-full', { hasText: '4x' }).click();
await page.waitForTimeout(200);
const rate = await page.evaluate(() => document.querySelector('video')?.playbackRate);
if (rate !== 4) fail(`点击 4x 后 playbackRate 应为 4，实际 ${rate}`);
else ok('playbackRate = 4');
const activeText = await page.locator('.rate-btn-full[data-active]').innerText();
if (activeText !== '4x') fail(`高亮按钮应为 4x，实际 ${activeText}`);
else ok('4x 按钮已高亮');

// 自定义倍速的配置入口在「设置 → 播放」，用例见文末第 8 步（控制栏只展示档位、不放配置面板）

console.log('4. 双击画面右侧 → +10s 且出现涟漪；双击左侧 → 回到原位');
const t0 = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
const box = await page.locator('[data-media-player]').boundingBox();
const cy = box.y + box.height * 0.4;
await page.mouse.dblclick(box.x + box.width * 0.9, cy);
// 涟漪动画 500ms，等 React 渲染出来后立即检查
const pulseEl = page.locator('.seek-pulse-right');
const pulseShown = await pulseEl.waitFor({ state: 'visible', timeout: 1000 }).then(() => true).catch(() => false);
if (!pulseShown) fail('双击右侧后应出现右侧涟漪');
else ok(`右侧涟漪已出现（文本：${await pulseEl.innerText()}）`);
await page.waitForTimeout(400);
const t1 = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
if (Math.abs(t1 - t0 - 10) > 1) fail(`双击右侧应 +10s（${t0.toFixed(1)} → ${t1.toFixed(1)}）`);
else ok(`currentTime ${t0.toFixed(1)} → ${t1.toFixed(1)}`);
// 涟漪应在动画结束后被清理
await page.waitForTimeout(400);
if ((await page.locator('.seek-pulse').count()) !== 0) fail('涟漪应在动画结束后移除');
else ok('涟漪已自动清理');
await page.mouse.dblclick(box.x + box.width * 0.1, cy);
await page.waitForTimeout(400);
const t2 = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
if (Math.abs(t2 - t0) > 1) fail(`双击左侧应回到原位（${t2.toFixed(1)} ≈ ${t0.toFixed(1)}）`);
else ok(`双击左侧回退：${t2.toFixed(1)} ≈ ${t0.toFixed(1)}`);

console.log('5. 同侧连续双击：秒数累加（YouTube 风格）');
await page.mouse.dblclick(box.x + box.width * 0.9, cy);
await page.waitForTimeout(150);
await page.mouse.dblclick(box.x + box.width * 0.9, cy);
await page.waitForTimeout(150);
const accText = await page.locator('.seek-pulse-right').innerText().catch(() => '');
if (accText !== '+20s') fail(`连续双击应累加为 +20s，实际 ${accText || '(已消失)'}`);
else ok('累加显示 +20s');
await page.screenshot({ path: 'e2e-shots/player-enhance-pulse.png' });

console.log('6. 字幕字号按钮：点击循环 中→大，CSS 变量与 localStorage 同步');
// 变量设在 .video-pane 容器上（media-player host upgrade 会重写内联样式），继承给字幕渲染器
const getVar = () => page.evaluate(() =>
  document.querySelector('.video-pane')?.style.getPropertyValue('--media-user-font-size'));
const v0 = await getVar();
if (v0 !== '1') fail(`初始 --media-user-font-size 应为 1，实际 "${v0}"`);
await page.locator('.caption-size-btn').click();
await page.waitForTimeout(200);
const v1 = await getVar();
if (v1 !== '1.35') fail(`点击后应为 1.35（大），实际 "${v1}"`);
else ok(`--media-user-font-size: ${v0} → ${v1}`);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings') ?? '{}'));
if (stored?.state?.captionScale !== 1.35) fail('localStorage 应持久化 captionScale=1.35');
else ok('localStorage 已持久化');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('video', { timeout: 15000 });
const v2 = await getVar();
if (v2 !== '1.35') fail(`刷新后应保持 1.35，实际 "${v2}"`);
else ok('刷新后字号设置保持');

console.log('7. 窄屏折叠：倍速平铺收起为循环按钮');
// Vidstack 规则：未播放过（无 data-started）的 small layout 会隐藏顶部控制组（rate 按钮所在）。
// 先播放再暂停置位 data-started，再把鼠标移进播放器唤醒控制栏（idle 会自动隐藏）
await page.locator('video').evaluate((v) => v.play());
await page.waitForTimeout(400);
await page.locator('video').evaluate((v) => v.pause());
await page.setViewportSize({ width: 500, height: 900 });
await page.waitForTimeout(600); // 等 ResizeObserver 切换 data-sm
// 视口变窄后鼠标原坐标已不在播放器上，控制栏会 idle 隐藏；移入播放器唤醒（真实用户同理）
const boxSm = await page.locator('[data-media-player]').boundingBox();
await page.mouse.move(boxSm.x + boxSm.width / 2, boxSm.y + boxSm.height / 2, { steps: 5 });
await page.waitForTimeout(300);
const cycleVisible = await page.locator('.rate-btn-cycle').isVisible();
const fullVisible = await page.locator('.rate-btn-full').first().isVisible();
if (!cycleVisible || fullVisible) fail(`窄屏应只显示循环按钮（cycle=${cycleVisible}, full=${fullVisible}）`);
else ok('已折叠为循环按钮');
const rateBefore = await page.evaluate(() => document.querySelector('video')?.playbackRate);
await page.locator('.rate-btn-cycle').click();
await page.waitForTimeout(200);
const rateAfter = await page.evaluate(() => document.querySelector('video')?.playbackRate);
if (rateBefore === rateAfter) fail('循环按钮点击后倍速应变化');
else ok(`循环切换：${rateBefore}x → ${rateAfter}x`);
await page.screenshot({ path: 'e2e-shots/player-enhance-small.png' });

console.log('8. 自定义倍速在「设置 → 播放」里维护，回到播放器并入档位栏');
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(400);
// 播放页 → 首页 → 设置页。
// 返回按钮统一用 data-testid="nav-back"：播放页还是 antd Button，设置页已经换成 mdui 的
// mdui-button-icon —— 标签与类名都不同了，只有 testid 是跨页面稳定的（这也是迁移期的既定做法）。
// 宽屏走左侧导航轨（rail 1280 宽可见；窄屏才显示底部导航的同名项 nav-bottom-settings）。
const backBtn = () => page.locator('[data-testid="nav-back"]');
const openSettings = async () => {
  await backBtn().click();
  await page.waitForSelector('[data-testid="video-item"]', { timeout: 15000 });
  await page.locator('[data-testid="nav-rail-settings"]').click();
  await page.waitForSelector('[data-testid="card-rates"]', { timeout: 15000 });
};
const rateCard = () => page.locator('[data-testid="card-rates"]');

await openSettings();
if ((await rateCard().count()) !== 1) fail('设置页应有「播放 → 自定义倍速」卡片');
else ok('设置页已提供自定义倍速入口');
if (!(await rateCard().innerText()).includes('暂未添加')) fail('初始应显示「暂未添加」');

// mdui-text-field 的真实 input 在 shadow DOM 里，Playwright 的 CSS 会穿透 open shadow root
const rateInput = page.locator('[data-testid="rate-input"] input');
const addBtn = page.locator('[data-testid="rate-add"]');
// mdui-button 的 disabled 是反射到 attribute 的 JS property，isDisabled() 对自定义元素不可靠，直接读属性
const addDisabled = () => addBtn.evaluate((el) => !!el.disabled);
if (!(await addDisabled())) fail('未输入时「添加」应置灰');
else ok('未输入时「添加」已置灰');

for (const r of ['1.25', '2.5']) {
  await rateInput.fill(r);
  await addBtn.click();
  await page.waitForTimeout(250);
}
const tags = await page.locator('[data-testid="rate-chips"] mdui-chip').allInnerTexts();
if (tags.join(',') !== '1.25x,2.5x') fail(`档位标签应为 1.25x,2.5x，实际 ${JSON.stringify(tags)}`);
else ok('已添加 1.25x / 2.5x');
const readRates = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings') ?? '{}')?.state?.customRates);
if (JSON.stringify(await readRates()) !== '[1.25,2.5]') {
  fail(`localStorage 应为 [1.25,2.5]，实际 ${JSON.stringify(await readRates())}`);
} else ok('已持久化到 localStorage');

// 与内置档位重复（2x）不入列
await rateInput.fill('2');
await addBtn.click();
await page.waitForTimeout(250);
if (JSON.stringify(await readRates()) !== '[1.25,2.5]') fail('重复档位不应入列');
else ok('重复档位未入列');
await page.screenshot({ path: 'e2e-shots/rate-settings.png' });

// 回播放器：档位栏应含 5 内置 + 2 自定义
await backBtn().click();
await page.waitForSelector('[data-testid="video-item"]', { timeout: 15000 });
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });
await page.waitForFunction(
  () => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.duration > 0; },
  { timeout: 15000 },
);
const withCustom = await page.locator('.rate-btn-full').count();
if (withCustom !== 7) fail(`内置 5 档 + 自定义 2 档应 7 个按钮，实际 ${withCustom}`);
else ok('自定义档位已并入档位栏');
await page.locator('.rate-btn-full', { hasText: '1.25x' }).click();
await page.waitForTimeout(200);
const r125 = await page.evaluate(() => document.querySelector('video')?.playbackRate);
if (r125 !== 1.25) fail(`点击 1.25x 后 playbackRate 应为 1.25，实际 ${r125}`);
else ok('playbackRate = 1.25');
await page.screenshot({ path: 'e2e-shots/player-enhance-rate-custom.png' });

// 回设置删掉 1.25x。mdui-chip 是**单个 button** 把「文字 + 删除图标」都包在里面
// （没有独立的删除按钮元素），所以点它 shadow DOM 里的 mdui-icon-clear。
await openSettings();
await rateCard().locator('[data-testid="rate-chip-1.25x"] mdui-icon-clear').click();
await page.waitForTimeout(250);
if (JSON.stringify(await readRates()) !== '[2.5]') {
  fail(`删除后应为 [2.5]，实际 ${JSON.stringify(await readRates())}`);
} else ok('已删除自定义档位');

await browser.close();
if (process.exitCode) process.exit(process.exitCode);
console.log('✅ 播放器增强链路通过：倍速按钮（内置 4x + 设置页自定义倍速）/ 双击 ±10s 涟漪 / 字幕字号（含持久化 + 窄屏折叠）全部正常');
