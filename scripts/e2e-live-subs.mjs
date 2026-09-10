/* eslint-disable no-console */
// 增量字幕（边转边显）链路：转写进行中逐段落库 → 字幕列表 / 画面字幕增量出现 → 下游面板门控
//
// 用法：TEST_FILE=/path/to/video.mp4 node scripts/e2e-live-subs.mjs
// 需先 npm run dev（5173）。不调真实 API：直接按「转写流水线每完成一段就写一次库」的节奏，
// 用应用同一份 Dexie 实例逐段写 segments，再断言 UI 的增量表现。
//
// 为什么走 dev 而非常规的 preview(4173)：Dexie liveQuery 只感知经由 Dexie 的写入，用原生
// IndexedDB 写入不会触发（已实测）。dev 下可以用模块 URL `/src/store/db.ts` 拿到应用正在用的
// 那个 db 实例；生产构建里该模块已被打包，拿不到句柄。
import { chromium } from 'playwright';

const TEST_FILE = process.env.TEST_FILE;
const BASE = process.env.BASE_URL || 'http://localhost:5173';
if (!TEST_FILE) { console.error('需要 TEST_FILE'); process.exit(1); }

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => { failed++; console.error(`   ❌ ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const wait = (ms) => page.waitForTimeout(ms);
const HINT = '请先在「字幕」页生成字幕';
const subItems = () => page.locator('[role="tabpanel"]:visible .sub-item').count();
const paused = () => page.evaluate(() => document.querySelector('video')?.paused ?? true);
const seek = (t) => page.evaluate((tt) => { const v = document.querySelector('video'); if (v) v.currentTime = tt; }, t);
/** 读取画面字幕：不可见容器（display:none 时 innerText 会回退到 textContent）一律视为空 */
const captionText = () =>
  page.evaluate(() => {
    const el = document.querySelector('.vds-captions');
    if (!el) return '';
    if (getComputedStyle(el).display === 'none' || el.getAttribute('aria-hidden') === 'true') return '';
    return (el.innerText || '').replace(/\s+/g, '');
  });

/** 画面字幕是否水平居中：cue 节点中心应与 .vds-captions 容器中心重合。
 *  回归自 2026-09-10：原生 VTTCue 没有 positionAlign，media-captions 会把 --cue-width 算成 50%，
 *  字幕框只占左半边 → 文字偏左。修复后应为整宽（见 Player.tsx syncTrack 注释）。 */
const captionCentered = () =>
  page.evaluate(() => {
    const overlay = document.querySelector('.vds-captions');
    const cue = overlay?.querySelector('[data-part="cue"]');
    if (!overlay || !cue) return null;
    const a = overlay.getBoundingClientRect(), b = cue.getBoundingClientRect();
    return { diff: Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)), layerWidth: a.width, cueWidth: b.width };
  });

/** 切到某个 Tab，返回该面板主按钮的 disabled 状态 + 是否显示「请先在字幕页生成字幕」提示 */
async function panelGate(tab, buttonText, buttonTestId) {
  await page.getByRole('tab', { name: tab, exact: true }).click();
  await wait(350);
  const disabled = await page.locator(`[data-testid="${buttonTestId}"]`).first().evaluate((el) => !!el.disabled).catch(() => null);
  const hint = (await page.locator(`text=${HINT}`).filter({ visible: true }).count()) > 0;
  return { disabled, hint };
}
const backToSubs = async () => {
  await page.getByRole('tab', { name: '字幕', exact: true }).click();
  await wait(300);
};

console.log('1. 打开首页并导入测试视频');
// 只填一个假 Key：本轮测试不需要真的调 API，但第 7 步要点「生成字幕」进入转写状态
await page.addInitScript(() => {
  localStorage.setItem(
    'wangke-settings',
    JSON.stringify({ state: { apiKey: 'sk-fake-for-e2e', baseUrl: 'https://api.siliconflow.cn/v1', asrConcurrency: 2 }, version: 0 }),
  );
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });

// 拿到应用正在用的 db 实例（dev 下模块 URL 与 app 的 import 图一致 → 同一实例）
const videoId = await page.evaluate(async () => {
  window.__live = {
    db: async () => (await import('/src/store/db.ts')).db,
    addSegs: async (rows) => { const db = await window.__live.db(); await db.segments.bulkAdd(rows); },
    clearSegs: async (vid) => { const db = await window.__live.db(); await db.segments.where('videoId').equals(vid).delete(); },
  };
  const db = await window.__live.db();
  const vids = await db.videos.toArray();
  return vids[vids.length - 1].id;
});
ok(`videoId = ${videoId}`);

const seg = (idx, start, text) => ({ videoId, idx, start, end: start + 6, text, status: 1 });

console.log('\n2. 初始态：无字幕 → 三个下游面板都应禁用');
await wait(500);
check((await subItems()) === 0, '字幕列表为空');
for (const [tab, btn, tid] of [['讲义', '生成讲义', 'handout-generate'], ['弹幕', '生成弹幕', 'dm-generate'], ['卡片', '生成卡片', 'cards-generate']]) {
  const g = await panelGate(tab, btn, tid);
  check(g.disabled === true && g.hint, `${tab}面板：按钮禁用 + 显示「${HINT}」`);
}
await backToSubs();

console.log('\n3. 模拟转写进行中：逐段落库，列表应增量出现且不打断播放');
await page.evaluate(() => { void document.querySelector('video')?.play(); });
await wait(600);
check((await paused()) === false, '视频已在播放');

const TEXTS = ['第一段已转写', '第二段已转写', '第三段已转写'];
for (let i = 0; i < TEXTS.length; i++) {
  await page.evaluate((rows) => window.__live.addSegs(rows), [seg(i, i * 6, TEXTS[i])]);
  await wait(900);
  const n = await subItems();
  check(n === i + 1, `写完第 ${i + 1} 段 → 列表 ${n} 条（期望 ${i + 1}）`);
  check((await paused()) === false, `写完第 ${i + 1} 段 → 播放未中断`);
}
const rowsText = await page.locator('[role="tabpanel"]:visible .sub-item').allInnerTexts();
check(rowsText[0]?.includes(TEXTS[0]) && rowsText[2]?.includes(TEXTS[2]), '列表按时间有序（按 idx 排）');

console.log('\n4. 画面字幕（常驻轨）应能读到已完成的段');
for (let i = 0; i < TEXTS.length; i++) {
  await seek(i * 6 + 2);
  await wait(700);
  const txt = await captionText();
  check(txt.includes(TEXTS[i]), `seek 到 ${i * 6 + 2}s → 画面字幕含「${TEXTS[i]}」（实际 ${JSON.stringify(txt)}）`);
}

const centered = await captionCentered();
check(
  !!centered && centered.diff < 1 && centered.cueWidth <= centered.layerWidth + 1,
  `画面字幕水平居中（cue 中心与字幕层中心差 ${centered ? centered.diff.toFixed(1) : 'N/A'}px，宽 ${centered?.cueWidth.toFixed(0)}/${centered?.layerWidth.toFixed(0)}）`,
);

console.log('\n5. 本轮转写结束 → 三个下游面板应解锁');
for (const [tab, btn, tid] of [['讲义', '生成讲义', 'handout-generate'], ['弹幕', '生成弹幕', 'dm-generate'], ['卡片', '生成卡片', 'cards-generate']]) {
  const g = await panelGate(tab, btn, tid);
  check(g.disabled === false && !g.hint, `${tab}面板：按钮可用且无「先…」提示`);
}
await backToSubs();

console.log('\n6. 「重新生成」清表重来：同 idx / 同时间但内容变了 → 不应残留旧字幕');
await page.evaluate((vid) => window.__live.clearSegs(vid), videoId);
await wait(900);
check((await subItems()) === 0, '清表后列表归零');
await seek(2);
await wait(700);
check(!(await captionText()).includes(TEXTS[0]), '清表后画面不再显示旧字幕');

const NEW_TEXTS = ['重转后的第一段', '重转后的第二段'];
for (let i = 0; i < NEW_TEXTS.length; i++) {
  await page.evaluate((rows) => window.__live.addSegs(rows), [seg(i, i * 6, NEW_TEXTS[i])]);
  await wait(800);
}
await seek(2);
await wait(700);
const afterReset = await captionText();
check(afterReset.includes(NEW_TEXTS[0]), `画面显示新内容「${NEW_TEXTS[0]}」（实际 ${JSON.stringify(afterReset)}）`);
check(!afterReset.includes(TEXTS[0]), '旧内容已被替换，没有重复残留');
check((await subItems()) === NEW_TEXTS.length, `列表为 ${NEW_TEXTS.length} 条`);

console.log('\n7. 本轮转写「进行中」时，已有字幕也不解锁下游面板');
// 第 6 步结束在「字幕」Tab，三个下游面板已挂载过 → 直接读按钮的 disabled 属性即可（不用切 Tab，
// 也就能容忍转写失败弹出的 modal 挡住交互）。
// dev 下 VAD 起不来会一直停在「语音端点检测中…」；若某环境能跑完/立刻失败，则跳过本条，不算失败。
await page.click('[data-testid="subs-generate"]');
let sawRunning = false;
for (let i = 0; i < 12 && !sawRunning; i++) {
  await wait(400);
  const txt = await page.locator('.side-pane').innerText().catch(() => '');
  if (txt.includes('转写中…') || txt.includes('端点检测') || txt.includes('抽取音频')) sawRunning = true;
}
if (!sawRunning) {
  console.log('   ⚠ 未进入「转写中」状态（该环境转写立即结束），跳过本条断言');
} else {
  ok('已进入「转写中」状态');
  for (const [tab, btn, tid] of [['讲义', '生成讲义', 'handout-generate'], ['弹幕', '生成弹幕', 'dm-generate'], ['卡片', '生成卡片', 'cards-generate']]) {
    const disabled = await page.locator(`[data-testid="${tid}"]`).first().evaluate((el) => !!el.disabled).catch(() => null);
    check(disabled === true, `${tab}面板：转写进行中按钮仍禁用（即使已有字幕）`);
  }
}

await page.screenshot({ path: 'e2e-shots/live-subs.png', fullPage: true });
await browser.close();

if (failed === 0) {
  console.log('\n✅ E2E 通过：增量字幕（列表 + 画面轨）与下游门控均符合预期');
  process.exit(0);
}
console.error(`\n⚠️ 有 ${failed} 项断言失败`);
process.exit(3);
