/* eslint-disable no-console */
// 主页卡片进度条 e2e：
//   1. 该画的画、不该画的不画（没看过 / 比例不足 1% / 阅读材料）
//   2. 画出来的宽度**真的**等于比例 —— 只断言 data-ratio 抓不到「CSS 没生效」
//   3. 位置对：在缩略图内部、贴着底边（别跑到主区或飘在半空）
//
// 数据播种走**原生 IndexedDB**（先打开一次页面让 Dexie 把 schema 建好，再写），
// 所以不需要 TEST_FILE，preview / dev 两档都能跑。
//
// 运行：node scripts/e2e-library-progress.mjs
//      BASE_URL=http://localhost:5173 node scripts/e2e-library-progress.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const SHOTS = fileURLToPath(new URL('../e2e-shots/', import.meta.url));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});

const fail = (msg) => {
  console.log(`   ✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`   ✓ ${msg}`);

// ── 1. 打开首页（顺带让 Dexie 把 videos 表建出来） ──────────────────────────
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type="file"]', { timeout: 20000 });
ok('首页渲染 OK');

// ── 2. 播种 5 条：2 条该有进度条、3 条不该有 ────────────────────────────────
const now = Date.now();
const seed = [
  // 744 / 1200 = 62%
  {
    id: 'pg-half', name: '看到一半的课', size: 1024, mimeType: 'video/mp4',
    duration: 1200, lastPosition: 744, createdAt: now - 5000, status: 'transcribed',
  },
  // 播完：位置停在结尾 + 标记（新语义）
  {
    id: 'pg-done', name: '已看完的课', size: 1024, mimeType: 'video/mp4',
    duration: 1200, lastPosition: 1200, finished: 1, createdAt: now - 4000, status: 'transcribed',
  },
  // 没看过
  {
    id: 'pg-new', name: '没看过的课', size: 1024, mimeType: 'video/mp4',
    duration: 1200, lastPosition: 0, createdAt: now - 3000, status: 'transcribed',
  },
  // 只看了 5 秒 = 0.42%，低于 1% 阈值 —— 画出来不到 1px，宁可不画
  {
    id: 'pg-tiny', name: '刚点开就退出的课', size: 1024, mimeType: 'video/mp4',
    duration: 1200, lastPosition: 5, createdAt: now - 2000, status: 'transcribed',
  },
  // 阅读材料：有 lastUnit 也不走视频那套口径（本次不做）
  {
    id: 'pg-material', name: '阅读材料', size: 1024, mimeType: 'application/pdf',
    duration: 0, kind: 'material', materialFormat: 'pdf', unitCount: 48, lastUnit: 12,
    createdAt: now - 1000, status: 'transcribed',
  },
];

const seeded = await page.evaluate(async (rows) => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('wangke');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!db.objectStoreNames.contains('videos')) return 'no-store';
  await new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readwrite');
    for (const r of rows) tx.objectStore('videos').put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return 'ok';
}, seed);
if (seeded !== 'ok') fail(`videos 表不存在（${seeded}）—— Dexie 没建表？`);
else ok('已播种 5 条');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-video-id="pg-half"]', { timeout: 20000 });
await page.waitForSelector('[data-video-id="pg-material"]', { timeout: 20000 });

// ── 3. 逐条读取几何 ────────────────────────────────────────────────────────
const bars = await page.evaluate(() => {
  const ids = ['pg-half', 'pg-done', 'pg-new', 'pg-tiny', 'pg-material'];
  const out = {};
  for (const id of ids) {
    const card = document.querySelector(`[data-video-id="${id}"]`);
    if (!card) {
      out[id] = { card: false };
      continue;
    }
    const bar = card.querySelector('[data-testid="video-progress"]');
    if (!bar) {
      out[id] = { card: true, bar: false };
      continue;
    }
    const fill = bar.querySelector('[data-testid="video-progress-fill"]');
    const thumb = card.querySelector('[data-testid="video-thumb"]');
    const br = bar.getBoundingClientRect();
    const fr = fill.getBoundingClientRect();
    const tr = thumb.getBoundingClientRect();
    out[id] = {
      card: true,
      bar: true,
      ratio: bar.dataset.ratio,
      finished: bar.dataset.finished ?? null,
      inThumb: !!bar.closest('[data-testid="video-thumb"]'),
      // 条底边与缩略图底边的间距（0 = 贴住）
      bottomGap: +(tr.bottom - br.bottom).toFixed(2),
      // 填充层实测宽度占条宽的比例 —— 这条才抓得住 CSS 没生效
      measured: +(fr.width / Math.max(1, br.width)).toFixed(4),
      // 条本身有没有高度（display:none / height:0 会露馅）
      barHeight: +br.height.toFixed(2),
    };
  }
  return out;
});
console.log('   实测:', JSON.stringify(bars));

// ── 4. 该有的：看到一半 ────────────────────────────────────────────────────
const half = bars['pg-half'];
if (!half?.bar) fail('pg-half 应该有进度条');
else {
  if (half.ratio !== '0.620') fail(`pg-half 的 data-ratio 应为 0.620，实际 ${half.ratio}`);
  else ok('pg-half data-ratio = 0.620');
  if (Math.abs(half.measured - 0.62) > 0.01) {
    fail(`pg-half 填充层实测占比 ${half.measured}，与 0.62 不符（CSS 没生效？）`);
  } else ok(`pg-half 填充层实测占比 ${half.measured}`);
  if (half.barHeight < 2) fail(`pg-half 进度条高度只有 ${half.barHeight}px，没渲染出来？`);
  else ok(`pg-half 进度条高度 ${half.barHeight}px`);
}

// ── 5. 该有的：已看完（满条 + 标记） ───────────────────────────────────────
const done = bars['pg-done'];
if (!done?.bar) fail('pg-done 应该有进度条');
else {
  if (done.ratio !== '1.000') fail(`pg-done 的 data-ratio 应为 1.000，实际 ${done.ratio}`);
  else ok('pg-done data-ratio = 1.000（满条）');
  if (done.finished !== '1') fail(`pg-done 应带 data-finished="1"，实际 ${done.finished}`);
  else ok('pg-done 带 data-finished="1"');
  if (Math.abs(done.measured - 1) > 0.01) fail(`pg-done 填充层没占满整条（实测 ${done.measured}）`);
  else ok(`pg-done 填充层实测占比 ${done.measured}`);
}

// ── 6. 位置：在缩略图内、贴底边 ────────────────────────────────────────────
for (const id of ['pg-half', 'pg-done']) {
  const b = bars[id];
  if (!b.inThumb) fail(`${id} 的进度条不在缩略图内部`);
  if (Math.abs(b.bottomGap) > 1.5) fail(`${id} 的进度条没贴缩略图底边（差 ${b.bottomGap}px）`);
}
if (bars['pg-half'].inThumb && bars['pg-done'].inThumb && Math.abs(bars['pg-half'].bottomGap) <= 1.5) {
  ok('两条进度条都在缩略图内且贴底边');
}

// ── 7. 不该有的：没看过 / 不足 1% / 阅读材料 ───────────────────────────────
const notExpected = [
  ['pg-new', '没看过'],
  ['pg-tiny', '只看了 5 秒（0.42%，低于 1% 阈值）'],
  ['pg-material', '阅读材料（另一套口径）'],
];
for (const [id, why] of notExpected) {
  const b = bars[id];
  if (!b?.card) fail(`${id} 卡片没渲染出来（${why}）`);
  else if (b.bar) fail(`${id} 不该有进度条（${why}），却拿到了 data-ratio=${b.ratio}`);
  else ok(`${id} 无进度条：${why}`);
}

// ── 8. 留一张图供人工复核（统计口径这种事，截图最抓得住） ──────────────────
await page.screenshot({ path: `${SHOTS}library-progress.png`, fullPage: true });
ok(`截图：e2e-shots/library-progress.png`);

console.log(errors.length ? `\n[console errors]\n${errors.join('\n')}` : '\n无 console/page 错误');
if (errors.length) process.exitCode = 1;
await browser.close();
console.log(process.exitCode ? '\n❌ 有用例失败' : '\n✅ 全部通过');
