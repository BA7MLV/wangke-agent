/* eslint-disable no-console */
// 评论区链路（视频下方的讨论区）：折叠条 → 展开 → 渲染讨论串 → 点时间戳跳播放器 → 排序切换 →
// 收起；再单独验「矮视口下展开不吃掉视频」（高度预算真的生效）与移动端可达性。
//
// 用法：
//   TEST_FILE=/path/to/video.mp4 node scripts/e2e-comments.mjs
// 需先 npm run preview（默认 4173，被占用时用 BASE_URL 指到别处）。
//
// ⚠️ 刻意**不调真实 API**：讨论数据自播种。生成质量是模型的事，这一层守的是
// 「数据 → 渲染 → 跳转」这段我们自己的代码（见 docs/plans/2026-09-22-comments-design.md §5）。
//
// ⚠️ 两个选择器上的坑（都实测踩过）：
//   1. 播放器在 DOM 里是 `div[data-media-player]`，**不是** `media-player` 元素 ——
//      按后者的写法等 15s 都不会出现；
//   2. 读播放位置要读内部的原生 `video`，不要读 `[data-media-player].currentTime` ——
//      vidstack 那个属性在媒体就绪前是 undefined，直接赋值只会挂一个自有属性，
//      读回来数值是对的、播放器却根本没动（假阳性）。原生 video 的 currentTime 才是硬证据。
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const TEST_FILE = process.env.TEST_FILE;
const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
if (!TEST_FILE) {
  console.error('需要 TEST_FILE');
  process.exit(1);
}

const SHOTS = 'e2e-shots/comments';
mkdirSync(SHOTS, { recursive: true });

const PLAYER = '[data-media-player]';
const NATIVE_TIME = `${PLAYER} video`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`   ✓ ${msg}`);

/** 导入测试视频，返回 videoId */
async function importVideo(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[type="file"]', TEST_FILE);
  await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
  return page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const q = indexedDB.open('wangke');
      q.onsuccess = () => res(q.result);
      q.onerror = rej;
    });
    const all = await new Promise((res, rej) => {
      const q = db.transaction('videos', 'readonly').objectStore('videos').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = rej;
    });
    return all[all.length - 1].id;
  });
}

/** 播种字幕与两条讨论串（甲：12s / 1 回复；乙：30s / 2 回复） */
async function seedComments(page, videoId) {
  await page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('wangke');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const tx = db.transaction(['segments', 'comments'], 'readwrite');
    const segs = tx.objectStore('segments');
    segs.clear();
    for (let i = 0; i < 4; i++) {
      segs.add({ videoId: id, idx: i, start: i * 10, end: i * 10 + 8, text: `字幕内容 ${i}`, status: 1 });
    }
    const cmts = tx.objectStore('comments');
    cmts.clear();
    // id 显式给出：回复要挂到确定的主贴上（上面 clear 过，不会撞键）
    cmts.add({
      id: 1,
      videoId: id,
      time: 12,
      author: '小林',
      role: 'ask',
      text: '这里为什么不能直接取反？条件反过来的话结论就变了。',
      createdAt: 1,
    });
    cmts.add({
      id: 2,
      videoId: id,
      time: 12,
      author: '阿哲',
      role: 'answer',
      text: '因为条件是单向的，反过来不成立。',
      parentId: 1,
      createdAt: 2,
    });
    cmts.add({
      id: 3,
      videoId: id,
      time: 30,
      author: '老王',
      role: 'note',
      text: '老师这里跳了一步，中间那个代换没讲。',
      createdAt: 3,
    });
    cmts.add({
      id: 4,
      videoId: id,
      time: 30,
      author: 'Lily',
      role: 'answer',
      text: '前面第五节讲过同一个代换，可以回去看一下。',
      parentId: 3,
      createdAt: 4,
    });
    cmts.add({
      id: 5,
      videoId: id,
      time: 30,
      author: '助教',
      role: 'note',
      text: '这一步考试不考，但理解了会顺很多。',
      parentId: 3,
      createdAt: 5,
    });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, videoId);
}

// ── 场景 1：桌面 full flow ────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

  console.log('1. 导入测试视频并播种评论');
  const videoId = await importVideo(page);
  await seedComments(page, videoId);
  ok(`videoId = ${videoId}，已播种 2 串 5 条发言`);

  console.log('2. 进入播放页：折叠条在、列表不在（默认折叠）');
  await page.goto(`${BASE}/#/player/${videoId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="comments-toggle"]', { timeout: 15000 });
  const count = (await page.locator('[data-testid="comments-count"]').textContent())?.trim();
  if (count === '2 条讨论 · 5 条发言') ok(`折叠条计数 = ${count}`);
  else fail(`折叠条计数不符：${count}`);
  if ((await page.locator('[data-testid="comments-list"]').count()) === 0) ok('折叠态不渲染列表');
  else fail('折叠态下列表竟然存在');
  await page.screenshot({ path: `${SHOTS}/desktop-collapsed.png` });

  console.log('3. 展开 → 渲染讨论串与回复层');
  await page.click('[data-testid="comments-toggle"]');
  await page.waitForSelector('[data-testid="comments-list"]', { timeout: 8000 });
  const threads = await page.locator('[data-testid="cmt-thread"]').count();
  const items = await page.locator('[data-testid="cmt-item"]').count();
  if (threads === 2 && items === 5) ok(`渲染 ${threads} 串 / ${items} 条发言`);
  else fail(`渲染数量不符：串 ${threads} / 发言 ${items}`);
  const replies = await page.locator('.cmt-replies [data-testid="cmt-item"]').count();
  if (replies === 3) ok('回复层挂了 3 条（1 + 2）');
  else fail(`回复层数量不符：${replies}`);
  const roles = await page.locator('.cmt-role').allTextContents();
  if (roles.includes('提问') && roles.includes('回答') && roles.includes('补充')) ok('三类角色标签齐全');
  else fail(`角色标签不齐：${roles.join('/')}`);
  await page.screenshot({ path: `${SHOTS}/desktop-expanded.png` });

  console.log('4. 热门排序：回复多的在前');
  const hotFirst = await page.locator('[data-testid="cmt-thread"] .cmt-author').first().textContent();
  if (hotFirst === '老王') ok('「热门」首串 = 老王（2 条回复）');
  else fail(`「热门」首串不符：${hotFirst}`);

  console.log('5. 点时间戳 → 原生 video 真的跳到 12s');
  await page.waitForSelector(PLAYER, { timeout: 15000 });
  await page.locator('[data-testid="cmt-time"]', { hasText: '0:12' }).first().click();
  await page.waitForFunction(
    (sel) => {
      const v = document.querySelector(sel);
      return !!v && Math.abs(v.currentTime - 12) < 1.5;
    },
    NATIVE_TIME,
    { timeout: 10000 },
  );
  const t = await page.evaluate((sel) => document.querySelector(sel)?.currentTime, NATIVE_TIME);
  ok(`点 0:12 后 video.currentTime = ${Number(t).toFixed(2)}`);

  console.log('6. 切「按进度」→ 顺序变回时间轴顺序');
  await page.click('[data-testid="comments-sort-progress"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="cmt-thread"] .cmt-author')?.textContent === '小林',
    { timeout: 8000 },
  );
  ok('「按进度」首串 = 小林（12s）');

  console.log('7. 收起 → 列表消失、折叠条计数仍在');
  await page.click('[data-testid="comments-toggle"]');
  await page.waitForSelector('[data-testid="comments-list"]', { state: 'detached', timeout: 8000 });
  const count2 = (await page.locator('[data-testid="comments-count"]').textContent())?.trim();
  if (count2 === '2 条讨论 · 5 条发言') ok('收起后计数保持');
  else fail(`收起后计数不符：${count2}`);

  console.log('8. 矮视口（1280×560）：展开时播放器让出高度、讨论区完整可见、页面不滚动');
  // 这个高度是刻意挑的：视频栏不再有富余高度，`44vh` 的上限必须真的生效 ——
  // 否则固定 16:9 的视频会把讨论区顶出可视区，被 .player-layout 的 overflow:hidden 裁掉。
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.waitForTimeout(300);
  const playerH = async () => (await page.locator(PLAYER).boundingBox())?.height ?? 0;
  const hClosed = await playerH();
  await page.click('[data-testid="comments-toggle"]');
  await page.waitForSelector('[data-testid="comments-list"]', { timeout: 8000 });
  const openCls = await page.locator('.video-pane').getAttribute('class');
  if (openCls?.includes('video-pane--comments-open')) ok('展开态给视频栏加上了 video-pane--comments-open');
  else fail(`视频栏类名没带上展开态：${openCls}`);
  const hOpen = await playerH();
  if (hOpen > 0 && hOpen < hClosed) ok(`播放器高度 ${Math.round(hClosed)} → ${Math.round(hOpen)}（让出了高度）`);
  else fail(`矮视口下播放器没有让出高度：闭合 ${hClosed} / 展开 ${hOpen}`);
  const blockBox = await page.locator('[data-testid="comments"]').boundingBox();
  if (blockBox && blockBox.y + blockBox.height <= 561) {
    ok(`讨论区完整落在可视区内（底边 ${Math.round(blockBox.y + blockBox.height)} ≤ 560）`);
  } else fail(`讨论区被裁掉了：${JSON.stringify(blockBox)}`);
  await page.screenshot({ path: `${SHOTS}/desktop-short-expanded.png` });
  const noPageScroll = await page.evaluate(
    () => document.scrollingElement.scrollHeight <= window.innerHeight + 2,
  );
  if (noPageScroll) ok('整页没有出现滚动条');
  else fail('整页被撑出了滚动条');

  console.log('9. 深色模式：讨论区跟随主题（全部走 MD3 令牌，没有写死颜色）');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('wangke-settings') ?? '{"state":{},"version":1}');
    raw.state = { ...raw.state, theme: 'dark' };
    localStorage.setItem('wangke-settings', JSON.stringify(raw));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('[data-testid="comments-toggle"]');
  await page.waitForSelector('[data-testid="comments-list"]', { timeout: 8000 });
  await page.waitForTimeout(300);
  const theme = await page.evaluate(() => {
    // 注意取哪个属性：底色读 backgroundColor，文字读 color。
    // 给文字元素读 backgroundColor 会拿到透明（亮度和 0），看起来像「写死了黑字」——踩过。
    const lum = (el, prop) => {
      const m = getComputedStyle(el)[prop].match(/\d+/g);
      return m ? Math.round(0.2126 * +m[0] + 0.7152 * +m[1] + 0.0722 * +m[2]) : null;
    };
    return {
      html: [...document.documentElement.classList].join(' '),
      root: lum(document.querySelector('.page-player'), 'backgroundColor'),
      panel: lum(document.querySelector('.comments-panel'), 'backgroundColor'),
      text: lum(document.querySelector('.cmt-text'), 'color'),
    };
  });
  // 面板底色亮、或正文色暗，都说明有人写了写死颜色（而不是用 --mdui-color-*）
  if (theme.html.includes('mdui-theme-dark') && theme.panel < 80 && theme.text > 150) {
    ok(`深色：面板底亮度 ${theme.panel}、正文亮度 ${theme.text}（令牌跟随）`);
  } else fail(`深色下讨论区没跟随主题：${JSON.stringify(theme)}`);
  await page.screenshot({ path: `${SHOTS}/desktop-dark-expanded.png` });
  await ctx.close();
}

// ── 场景 2：移动端（折叠条可达 + 展开可用） ──────────────────────────────────
{
  console.log('10. 移动端 390×844：折叠条可达、展开可用、页面不滚动');
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  const videoId = await importVideo(page);
  await seedComments(page, videoId);
  await page.goto(`${BASE}/#/player/${videoId}`, { waitUntil: 'networkidle' });

  const toggle = page.locator('[data-testid="comments-toggle"]');
  await toggle.waitFor({ state: 'visible', timeout: 15000 });
  const box = await toggle.boundingBox();
  if (box && box.y >= 0 && box.y + box.height <= 844 && box.height >= 40) {
    ok(`折叠条在可视区内，高 ${Math.round(box.height)}px（≥40 触控下限）`);
  } else fail(`折叠条位置/高度不合适：${JSON.stringify(box)}`);

  await toggle.tap();
  await page.waitForSelector('[data-testid="comments-list"]', { timeout: 8000 });
  const selfScroll = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="comments-list"]');
    return !!el && getComputedStyle(el).overflowY === 'auto';
  });
  if (selfScroll) ok('移动端展开后内容区自身滚动（不是整页滚动）');
  else fail('移动端内容区不是自身滚动');

  const noPageScroll = await page.evaluate(
    () => document.scrollingElement.scrollHeight <= window.innerHeight + 2,
  );
  if (noPageScroll) ok('整页仍然不滚动');
  else fail('整页被撑出了滚动条');

  // 窄屏的高度预算最紧：视频被压到看不见的话，这个功能就是净损失
  const ph = (await page.locator(PLAYER).boundingBox())?.height ?? 0;
  if (ph > 100) ok(`移动端展开后视频仍有 ${Math.round(ph)}px 高`);
  else fail(`移动端展开后视频被压到 ${Math.round(ph)}px`);
  await page.screenshot({ path: `${SHOTS}/mobile-expanded.png` });
  await ctx.close();
}

await browser.close();
if (process.exitCode) process.exit(process.exitCode);
console.log('\n全部通过');
