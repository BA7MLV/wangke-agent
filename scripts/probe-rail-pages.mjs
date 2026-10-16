/**
 * 侧栏常驻 + 标题栏对齐的页面级验证（生产构建，默认打 4174）。
 *
 * 侧栏改为**常驻不可折叠**之后，这里守的是三件事：
 *  1. 宽屏（1280×800）侧栏常驻、宽度固定，标题与内容列左边界同线，
 *     且顶栏没有汉堡按钮、侧栏里没有「收起侧边栏」——折叠入口已经不存在；
 *  2. 窄屏（390×844）侧栏消失、顶栏出现汉堡按钮，点开抽屉能看到同一份导航，
 *     点一项后抽屉自动收起；
 *  3. 播放页侧栏常驻且「课程库」高亮，视频区从侧栏右侧开始。
 *
 * 为什么盯这三条：侧栏的显隐现在只有「视口宽度」一个判据。判据一旦被改坏，
 * 症状是**宽屏或窄屏有一侧完全没有导航**，而页面本身照样能打开 —— 属于
 * 「看起来正常、实际走不通」的那类错，必须由脚本盯住。
 *
 * 用法：BASE_URL=http://127.0.0.1:4173 node scripts/probe-rail-pages.mjs
 *      （也可直接 node scripts/probe-rail-pages.mjs http://localhost:4173/）
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// 优先读 BASE_URL，这样能挂进 e2e-all 的一键跑分（编排器按服务注入地址）；
// argv 保留给手动调试。
const BASE = process.env.BASE_URL || process.argv[2] || 'http://localhost:4174/';
// 编排器会注入 TEST_FILE；单跑时用固定路径，缺失才现造一个 40 秒样片。
const SAMPLE = process.env.TEST_FILE || '/tmp/wangke-test.mp4';
/** 16.5rem，与 layout.tsx 侧栏的 `w-[16.5rem]` 同一个数 */
const RAIL_WIDTH = 264;

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
const check = (cond, m) => (cond ? ok(m) : fail(m));

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const rail = page.locator('[data-testid="nav-rail"]');

console.log('1. 宽屏首页（1280×800）');
{
  check(await rail.isVisible(), '侧栏常驻可见');

  const box = await rail.boundingBox();
  check(box !== null && Math.abs(box.width - RAIL_WIDTH) <= 1, `侧栏宽度 ${box?.width}px（期望 ${RAIL_WIDTH}px）`);

  /**
   * 顶栏标题与内容列左边界同线。
   *
   * 分两档量，因为「内容列」只在**有内边距的档位**存在：
   *
   * - 首页是 `fill`（铺满）：`--page-content-max` 未设、列上也没有 px-5，
   *   盒子左缘紧贴侧栏。这时候拿盒子左缘当对齐基准是量错了对象 ——
   *   铺满页**没有**内容列，只有页面自己的消息列（居中 + 自带 padding），
   *   标题对它左对齐没有意义。对铺满档断言的是「标题保持 px-5 的固定内缩」。
   * - 库页是默认档：有 px-5 的内容列，标题必须与它同线。
   *
   * 之前这条断言只跑首页且一律按盒子左缘比，于是恒定失败：
   * 实测 280 vs 264（差 16px = 标题的 px-5），量的是「铺满页没列」而不是对齐缺陷。
   * 真正对不齐的是**横屏那条 `landscape:pl-…` 用 16px、内容列用 20px**（差 4px），
   * 那个已在 layout.tsx 修正，本探针下面用库页守住。
   *
   * ⚠️ 顶栏最左边那颗**侧栏折叠开关**让「标题左缘 == 内容列左缘」这条不再成立 ——
   * 按钮 34px + 6px gap 天然把标题往右推 40px。所以基准改成
   * 「**按钮的左缘**对齐内容列左缘」，标题则断言「标题 = 内容列 + 按钮宽度 + gap」。
   * 这样守的仍然是同一件事（顶栏左内边距与内容列同源），只是把新增的那一格算进去；
   * 真要是对齐算错了（横屏 16 vs 20 那种），差值仍然会飘出来。
   */
  const railRight = RAIL_WIDTH;
  /** 折叠按钮那一格的宽度（含与标题之间的 gap），与 layout.tsx 的 size-[34px] + gap-1.5 同源 */
  const TOGGLE_GUTTER = 34 + 6;
  {
    const title = await page.evaluate(() =>
      Math.round(document.querySelector('[data-testid="top-app-bar"] h1').getBoundingClientRect().left),
    );
    const inset = title - railRight;
    check(
      inset >= TOGGLE_GUTTER + 16 && inset <= TOGGLE_GUTTER + 24,
      `铺满页（首页）标题距侧栏 ${inset}px（= 折叠开关 ${TOGGLE_GUTTER} + px-5≈20）`,
    );
  }
  {
    await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const xs = await page.evaluate(() => {
      const toggle = document.querySelector('[data-testid="nav-rail-toggle"]');
      const title = document.querySelector('[data-testid="top-app-bar"] h1');
      const inner = document.querySelector('[data-testid="page-main"] > div');
      const pad = parseFloat(getComputedStyle(inner).paddingLeft);
      return {
        toggle: Math.round(toggle.getBoundingClientRect().left),
        title: Math.round(title.getBoundingClientRect().left),
        content: Math.round(inner.getBoundingClientRect().left + pad),
      };
    });
    check(
      Math.abs(xs.toggle - xs.content) <= 2,
      `有列档（库页）折叠开关 x=${xs.toggle} vs 内容列左边界 x=${xs.content}`,
    );
    check(
      Math.abs(xs.title - xs.content - TOGGLE_GUTTER) <= 2,
      `有列档（库页）标题 x=${xs.title} = 内容列 ${xs.content} + 开关 ${TOGGLE_GUTTER}`,
    );
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
  }

  // 宽屏：折叠开关在（侧栏可收起），汉堡不在这档（它只管窄屏抽屉）
  check((await page.locator('[data-testid="nav-rail-open"]').count()) === 0, '宽屏顶栏没有汉堡按钮（那是窄屏抽屉的）');
  check(await page.locator('[data-testid="nav-rail-toggle"]').isVisible(), '宽屏顶栏出现侧栏折叠开关');

  const railText = await rail.innerText();
  check(!railText.includes('收起侧边栏'), '侧栏里没有「收起侧边栏」入口');
  check(!railText.includes('随时可问'), '侧栏里没有身份块文案');

  // 收起 → 侧栏整块消失、内容列铺到左缘；再点回来
  const toggle = page.locator('[data-testid="nav-rail-toggle"]');
  await toggle.click();
  await page.waitForTimeout(400);
  check((await page.locator('[data-testid="nav-rail"]').count()) === 0, '收起后侧栏从 DOM 里消失（Tab 顺序不留几十站会话）');
  check((await toggle.getAttribute('aria-pressed')) === 'true', '收起后按钮 aria-pressed=true');
  await page.screenshot({ path: 'e2e-shots/rail-home-desktop-collapsed.png' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  check((await page.locator('[data-testid="nav-rail"]').count()) === 0, '刷新后仍保持收起（记本机）');
  await page.locator('[data-testid="nav-rail-toggle"]').click();
  await page.waitForTimeout(400);
  check(await page.locator('[data-testid="nav-rail"]').isVisible(), '再点一次展开侧栏');

  await page.screenshot({ path: 'e2e-shots/rail-home-desktop.png' });
}

console.log('2. 窄屏首页（390×844）');
{
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);

  check(!(await rail.isVisible()), '侧栏隐藏');

  const open = page.locator('[data-testid="nav-rail-open"]');
  check(await open.isVisible(), '顶栏出现汉堡按钮');
  await open.click();
  await page.waitForTimeout(400);

  // 窄屏时宽屏侧栏仍在 DOM 里（display:none），所以按可见性筛
  const visibleItems = page.locator('[data-testid^="nav-rail-"]:visible');
  const labels = await visibleItems.allInnerTexts();
  check(labels.length >= 3, `抽屉里能看到 ${labels.length} 个导航项`);

  // 点「学习」而不是当前页那一项：跳转 + 抽屉收起两件事一起验
  await page.locator('[data-testid="nav-rail-study"]:visible').click();
  await page.waitForURL(`${BASE}#/study`);
  await page.waitForTimeout(400);
  check((await page.locator('[data-testid="nav-rail-study"]:visible').count()) === 0, '点导航项后抽屉自动收起');

  await page.screenshot({ path: 'e2e-shots/rail-home-mobile.png' });
}

console.log('3. 导入样片 → 宽屏播放页');
await page.setViewportSize({ width: 1280, height: 800 });
// 课程库在 /library（`/` 是 AI 助手），导入入口在课程库页
await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.setInputFiles('input[type="file"]', SAMPLE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 60000 });
ok('样片已导入');
await page.locator('[data-testid="btn-play"]').first().click();
await page.waitForSelector('[data-media-player]', { timeout: 30000 });
await page.waitForTimeout(1200);
{
  check(await rail.isVisible(), '播放页侧栏常驻可见');
  // 「当前在哪一项」读 ListBox 的 aria-selected（React Aria 会滤掉自挂的 aria-current）
  const homeActive = await page.evaluate(
    () => document.querySelector('[data-testid="nav-rail-home"]')?.getAttribute('aria-selected') === 'true',
  );
  check(homeActive, '播放页侧栏「课程库」高亮');
  const videoX = await page.evaluate(() => Math.round(document.querySelector('.video-pane').getBoundingClientRect().left));
  check(videoX >= RAIL_WIDTH + 1, `视频区左缘 x=${videoX}（应从侧栏右侧 ${RAIL_WIDTH} 之后开始）`);
  await page.screenshot({ path: 'e2e-shots/rail-player-desktop.png' });
}

console.log('4. 手机横屏（844×390）');
{
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(500);
  check(!(await rail.isVisible()), '横屏那档（≤900px）侧栏不显示');
  check(await page.locator('[data-testid="nav-rail-open"]').isVisible(), '横屏那档走汉堡按钮开抽屉');
  await page.screenshot({ path: 'e2e-shots/rail-player-landscape.png' });
}

await browser.close();
console.log(failed === 0 ? '\n✅ 侧栏常驻 / 抽屉降级验证全部通过' : `\n❌ ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
