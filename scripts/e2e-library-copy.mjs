/* eslint-disable no-console */
// 库页「长说明收进问号」的回归。
//
// 守的是构建与类型检查都抓不到的几类静默失败：
//   1. 点问号的事件冒泡到投放区 —— 整块投放区是可点击的（点哪儿都开文件选择器），
//      问号忘了 stopPropagation 就会「点一下说明，系统选择器也弹出来」；
//   2. 气泡宽度塌成竖条 —— mdui 在算位置**之前**先量 popup 的 offsetWidth，那一刻
//      popup 还停在触发元素的静态位置上，可用宽度只有「视口 − 触发元素左边距」。
//      正文一旦没有确定宽度，手机上实测会变成 116×556 的竖条（读不了）；
//   3. 长说明重新铺回正文 —— 手机上投放区那条横排会被压成每行一两个字的竖排
//      （旧的 e2e-shots/mobile-library.png 就是这个样子）。
//
// 用法：node scripts/e2e-library-copy.mjs        （需先 npm run preview）
//       BASE_URL=http://127.0.0.1:5173 node scripts/e2e-library-copy.mjs   （打 dev）
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

// 收进问号里的那几段，正文里**不该**再出现这些片段
const LONG_FRAGMENTS = ['从相册选择', 'iCloud', '不会上传到任何服务器', '删除原视频'];
// 竖排挤压的判据：正常一行 40px 上下，被压成竖排时实测 556px
const HINT_MAX_HEIGHT = 80;
// 气泡被压成竖条时实测宽 116px
const POPUP_MIN_WIDTH = 200;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  // 只连本机地址，别继承环境里的 HTTP_PROXY（Playwright 会把它们套到浏览器上）
  args: ['--no-proxy-server'],
});

/** 量一次投放区文案行：可见文案 + 行盒子，顺便确认所有气泡都已关闭 */
async function readHintRow(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const row = document.querySelector('.drop-zone__hint');
    const r = row.getBoundingClientRect();
    return {
      text: document.querySelector('[data-testid="drop-zone"]').innerText.replace(/\s+/g, ' ').trim(),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
}

/** 点一个问号：气泡要出现、要有正常宽度、要完整落在视口内，且不能弹出文件选择器 */
async function probeHelp(page, name, testId, viewport) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  let chooser = false;
  const onChooser = () => {
    chooser = true;
  };
  page.on('filechooser', onChooser);

  const trigger = page.locator(`[data-testid="${testId}"]`);
  // ⚠️ 不能取页面上「第一个」rich 气泡：mdui 在打开一个 tooltip 时会关掉同变体的其他
  // tooltip（onOpenChange 里那句 $(`mdui-tooltip[variant=...]`)），所以横幅那个会先被关掉，
  // 取 first() 会量到一个 hidden 的 popup。按触发按钮反查所属 tooltip 才稳。
  const popup = page.locator('mdui-tooltip').filter({ has: trigger }).locator('.popup');

  await trigger.click();
  await page.waitForTimeout(600);

  const box = await popup.boundingBox();
  if (!box) fail(`${name}：点了没出现气泡`);
  else {
    if (box.width < POPUP_MIN_WIDTH) fail(`${name}：气泡宽只有 ${Math.round(box.width)}px，正文被压成竖条了`);
    else if (box.x < 0 || box.x + box.width > viewport.w) fail(`${name}：气泡横向出屏（${Math.round(box.x)} … ${Math.round(box.x + box.width)}）`);
    else if (box.y + box.height > viewport.h) fail(`${name}：气泡纵向出屏（底 ${Math.round(box.y + box.height)} > ${viewport.h}）`);
    else ok(`${name}：气泡 ${Math.round(box.width)}×${Math.round(box.height)} 完整落在视口内`);
  }

  check(!chooser, `${name}：点问号没有误开文件选择器`);
  page.off('filechooser', onChooser);
}

/* ── 宽屏：投放区是横排的一条 ─────────────────────────────────────────────── */
console.log('1. 宽屏 1100×900：投放区文案收在问号里');
const wide = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const wpage = await wide.newPage();
const errors = [];
wpage.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));
await wpage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await wpage.waitForSelector('[data-testid="drop-zone"]', { timeout: 20000 });

check(await wpage.locator('[data-testid="drop-zone"] input[type="file"]').count() === 1, '投放区里仍有唯一的隐藏文件选择器');
check(await wpage.locator('[data-testid="pwa-hint"]').count() === 0, '宽屏不出现「添加到主屏幕」横幅');

const wideRow = await readHintRow(wpage);
check(!LONG_FRAGMENTS.some((f) => wideRow.text.includes(f)), '正文里不再出现长说明片段');
check(wideRow.h < HINT_MAX_HEIGHT, `文案行高 ${wideRow.h}px（< ${HINT_MAX_HEIGHT}，没有竖排挤压）`);
await probeHelp(wpage, '宽屏投放区问号', 'import-help', { w: 1100, h: 900 });
await wpage.screenshot({ path: 'e2e-shots/import-hint-desktop-open.png' });
await wide.close();

/* ── 手机：投放区回落到纵向卡片，且「添加到主屏幕」横幅会出现 ──────────────── */
console.log('2. 手机 390×844：投放区纵向卡片 + iOS 横幅');
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  // 横幅的判据是 isIOS() && !isStandalone()，所以要装成 iPhone 才看得到
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await phone.newPage();
page.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="drop-zone"]', { timeout: 20000 });

const phoneRow = await readHintRow(page);
check(!LONG_FRAGMENTS.some((f) => phoneRow.text.includes(f)), '手机正文里不再出现长说明片段');
check(phoneRow.h < HINT_MAX_HEIGHT, `手机文案行高 ${phoneRow.h}px（竖排挤压时实测 556px）`);
await page.screenshot({ path: 'e2e-shots/import-hint-mobile.png' });
await probeHelp(page, '手机投放区问号', 'import-help', { w: 390, h: 844 });
await page.screenshot({ path: 'e2e-shots/import-hint-mobile-open.png' });

console.log('3. 手机：横幅只留结论，「为什么」收进问号');
const banner = page.locator('[data-testid="pwa-hint"]');
check((await banner.count()) === 1, 'iOS 非独立模式下出现「添加到主屏幕」横幅');
if (await banner.count()) {
  const bannerText = (await banner.innerText()).replace(/\s+/g, ' ').trim();
  check(!bannerText.includes('7 天'), '横幅正文不再铺「7 天未打开」那段解释');
  // 关掉气泡后那段解释必须不占版面：DOM 里留着但被 popup 的 hidden 藏住
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const visibleP = await page.evaluate(
    () => [...document.querySelectorAll('[data-testid="pwa-hint"] p')].filter((p) => p.getClientRects().length > 0).length,
  );
  check(visibleP === 0, '关闭态下横幅里那段解释不可见');
  await probeHelp(page, '横幅问号', 'pwa-hint-help', { w: 390, h: 844 });
  await page.screenshot({ path: 'e2e-shots/pwa-hint-mobile-open.png' });
}

console.log('4. 极窄 320×700：气泡仍不出屏');
await page.setViewportSize({ width: 320, height: 700 });
await page.waitForTimeout(400);
await probeHelp(page, '极窄投放区问号', 'import-help', { w: 320, h: 700 });
await page.screenshot({ path: 'e2e-shots/import-hint-narrow-open.png' });

await phone.close();
await browser.close();

console.log(errors.length ? `[console/page errors]\n${errors.join('\n')}` : '无 console/page 错误');
console.log(failed === 0 ? '\n✅ 库页长说明收纳回归通过' : `\n❌ 有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
