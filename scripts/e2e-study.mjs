/* eslint-disable no-console */
// 学习时长（热力图）e2e：
//   1. 页面结构：统计卡 / 53 周 × 7 行网格 / 图例 / 最近 30 天
//   2. 数据渲染：播种 studyDays 后，档位、月份标签、今日标记、悬浮提示都对得上
//   3. 计时链路：真等两个心跳周期，看「今日」自己涨、并落到 IndexedDB（这条最要紧，
//      因为它把「可见 + 未空闲才计时 → 内存缓冲 → 落库」整条链都串起来了）
//
// 数据播种走**原生 IndexedDB**（先打开一次页面让 Dexie 把 v11 的 schema 建好，再写）。
// 不走 dev 的模块句柄，因此 preview / dev 两档都能跑。
//
// 运行：node scripts/e2e-study.mjs            （默认打 4173）
//      BASE_URL=http://localhost:5173 node scripts/e2e-study.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';

/** 播种用的一分钟 = 60 秒 */
const MIN = 60;

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

// ── 1. 页面能打开（顺带让 Dexie 把 studyDays 表建出来） ──────────────────────
await page.goto(`${BASE}/#/study`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="study-stats"]', { timeout: 20000 });
ok('学习页渲染 OK');

// 浏览器本地日期（与 Node 同机同时区，但日期键的定义在浏览器里算更保险）
const dates = await page.evaluate(() => {
  const key = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  return { today: key(0), yesterday: key(-1), d3: key(-3), d10: key(-10) };
});

// ── 2. 播种：今天 100 分 / 昨天 30 分 / 3 天前 10 分 / 10 天前 120 分 ────────
const seed = [
  { date: dates.today, seconds: 100 * MIN, updatedAt: Date.now() },
  { date: dates.yesterday, seconds: 30 * MIN, updatedAt: Date.now() },
  { date: dates.d3, seconds: 10 * MIN, updatedAt: Date.now() },
  { date: dates.d10, seconds: 120 * MIN, updatedAt: Date.now() },
];
const seeded = await page.evaluate(async (rows) => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('wangke');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!db.objectStoreNames.contains('studyDays')) return 'no-store';
  await new Promise((resolve, reject) => {
    const tx = db.transaction('studyDays', 'readwrite');
    for (const r of rows) tx.objectStore('studyDays').put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return 'ok';
}, seed);
if (seeded !== 'ok') fail(`studyDays 表不存在（${seeded}）—— Dexie v11 没生效？`);
else ok('已播种 4 天记录');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="heat-cells"]', { timeout: 20000 });

// ── 3. 网格几何：53 周 × 7 行 ──────────────────────────────────────────────
const grid = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('[data-testid="heat-cell"]')];
  return {
    total: cells.length,
    cols: document.querySelectorAll('.heat-col').length,
    perCol: cells.length / Math.max(1, document.querySelectorAll('.heat-col').length),
    months: [...document.querySelectorAll('.heat-month')].map((m) => m.textContent),
    weekdays: [...document.querySelectorAll('.heat-weekdays > span')].map((s) => s.textContent),
    todayCells: cells.filter((c) => c.classList.contains('heat-cell--today')).map((c) => c.dataset.date),
    futureCells: cells.filter((c) => c.dataset.future === '1').length,
  };
});
console.log(`2. 网格：${grid.cols} 列 × ${grid.perCol} 行 = ${grid.total} 格，月份标签 ${grid.months.join('/')}`);
if (grid.cols !== 53 || grid.perCol !== 7) fail(`近一年应是 53 列 × 7 行，实际 ${grid.cols} × ${grid.perCol}`);
else ok('53 周 × 7 行');
if (grid.months.length < 8) fail(`月份标签太少：${grid.months.join('/')}`);
else ok(`月份标签 ${grid.months.length} 个`);
if (grid.weekdays.filter(Boolean).join('') !== '一三五') fail(`星期标签应为 一/三/五，实际 ${grid.weekdays.join('|')}`);
else ok('星期标签只有 一 / 三 / 五');
if (grid.todayCells.length !== 1 || grid.todayCells[0] !== dates.today) {
  fail(`今日格子应恰好一个且是 ${dates.today}，实际 ${JSON.stringify(grid.todayCells)}`);
} else ok('今日格子唯一且有标记');
if (grid.futureCells < 0 || grid.futureCells > 6) fail(`本周未来的格子数异常：${grid.futureCells}`);
else ok(`本周未来占位 ${grid.futureCells} 格`);

// ── 4. 档位与统计 ─────────────────────────────────────────────────────────
const levelOf = (date) =>
  page.evaluate(
    (d) => document.querySelector(`[data-testid="heat-cell"][data-date="${d}"]`)?.dataset.level ?? null,
    date,
  );
const levels = {
  today: await levelOf(dates.today),
  yesterday: await levelOf(dates.yesterday),
  d3: await levelOf(dates.d3),
  d10: await levelOf(dates.d10),
};
console.log(`3. 档位：今天=${levels.today} 昨天=${levels.yesterday} 3天前=${levels.d3} 10天前=${levels.d10}`);
// 100 分 → 4 档；30 分 → 2 档；10 分 → 1 档；120 分 → 4 档
const expectLevels = { today: '4', yesterday: '2', d3: '1', d10: '4' };
const badLevels = Object.entries(expectLevels).filter(([k, v]) => levels[k] !== v);
if (badLevels.length) fail(`档位不符：${badLevels.map(([k, v]) => `${k} 应 ${v} 实 ${levels[k]}`).join('、')}`);
else ok('四个档位都对（100 分=4 / 30 分=2 / 10 分=1 / 120 分=4）');

const tiles = await page.evaluate(() => {
  const t = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? '';
  return { total: t('tile-total'), today: t('tile-today'), week: t('tile-week'), streak: t('tile-streak') };
});
console.log('4. 统计卡:', JSON.stringify(tiles, null, 2));
// 累计 15600s = 4 小时 20 分（计时器可能再补几十秒，分钟的取整让它仍落在这个区间）
// 日均是**全期**口径（15600s ÷ 4 个活跃日 = 65 分），所以它挂在「累计」这张卡上
if (!/4 小时 2\d 分/.test(tiles.total) || !/活跃 4 天/.test(tiles.total) || !/日均 1 小时 0\d 分/.test(tiles.total)) {
  fail(`累计卡不符（应含 4 小时 2x 分 / 活跃 4 天 / 日均 1 小时 0x 分）：${tiles.total}`);
} else ok('累计 4 小时 2x 分 · 活跃 4 天 · 日均 1 小时 0x 分');
if (!/1 小时 4\d 分/.test(tiles.today) || !/记录中/.test(tiles.today)) {
  fail(`今日卡不符（应含 1 小时 4x 分 + 记录中）：${tiles.today}`);
} else ok('今日卡显示 1 小时 4x 分 · 记录中');
// 近 7 天 = 今天 100 分 + 昨天 30 分 + 3 天前 10 分 = 140 分 = 2 小时 20 分（10 天前那笔不算），
// 窗口内有 3 天记录。
// ⚠️ 这张卡上**不能**出现「日均」：日均是全期口径，挂这里就变成「标题说 7 天、数字是全期」。
//    下面这两条断言就是那次口径错位文案的守门员，别删。
if (!/2 小时 2\d 分/.test(tiles.week)) fail(`近 7 天不符：${tiles.week}`);
else if (!/活跃 3 天/.test(tiles.week)) fail(`近 7 天应显示窗口内活跃天数（3 天）：${tiles.week}`);
else if (/日均/.test(tiles.week)) fail(`近 7 天卡混进了全期口径的「日均」：${tiles.week}`);
else ok('近 7 天 2 小时 2x 分 · 活跃 3 天（未混入全期日均）');
if (!/2 天/.test(tiles.streak) || !/最长 2 天/.test(tiles.streak)) fail(`连续天数不符：${tiles.streak}`);
else ok('连续 2 天 / 最长 2 天');

// ── 5. 悬浮提示 ───────────────────────────────────────────────────────────
await page.hover(`[data-testid="heat-cell"][data-date="${dates.d3}"]`);
await page.waitForSelector('[data-testid="heat-tip"]', { timeout: 5000 });
const tip = await page.textContent('[data-testid="heat-tip"]');
console.log(`5. 提示条：${tip}`);
if (!tip.includes('10 分') || !tip.includes(dates.d3)) fail(`提示条内容不符：${tip}`);
else ok('悬浮提示显示时长与日期');

// ── 6. 图例与区间切换 ─────────────────────────────────────────────────────
const legend = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="heat-legend"] .heat-cell--legend')].map((c) => c.dataset.level),
);
if (legend.length !== 5) fail(`图例应有 5 档，实际 ${legend.length}`);
else ok(`图例 5 档（${legend.join('')}）`);

await page.click('[data-testid="study-range-3m"]');
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="heat-cell"]').length === 14 * 7,
  undefined,
  { timeout: 5000 },
);
ok('切到近 3 个月 → 14 列 × 7 行');
await page.click('[data-testid="study-range-1y"]');
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="heat-cell"]').length === 53 * 7,
  undefined,
  { timeout: 5000 },
);
ok('切回近一年 → 53 列 × 7 行');

// ── 7. 最近 30 天明细 ─────────────────────────────────────────────────────
const recent = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="study-recent-row"]')];
  return { count: rows.length, first: rows[0]?.textContent?.trim() ?? '' };
});
console.log(`6. 最近 30 天：${recent.count} 行，首行「${recent.first}」`);
if (recent.count !== 30) fail(`明细应有 30 行，实际 ${recent.count}`);
else ok('明细 30 行');
if (!recent.first.includes('今天') || !/1 小时 4\d 分/.test(recent.first)) fail(`首行不符：${recent.first}`);
else ok('首行是今天');

// ── 8. 截图（桌面 / 手机各一张，存 e2e-shots/，该目录已 gitignore） ──────────
await page.setViewportSize({ width: 1280, height: 900 });
await page.screenshot({ path: 'e2e-shots/study-desktop.png' });
// 手机这张要**在窄屏下重新加载**再拍：热力图挂载时才会滚到最右（本周），
// 只在宽屏渲染完再缩窗口的话，拍到的会是半年前那一段 —— 那是截图假象，不是真实首屏。
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="heat-cells"]', { timeout: 20000 });
await page.screenshot({ path: 'e2e-shots/study-mobile.png' });
await page.setViewportSize({ width: 1280, height: 900 });
ok('已截图 e2e-shots/study-desktop.png 与 study-mobile.png');

// ── 9. 计时链路：等两个心跳周期，看「今日」自己涨并落库 ─────────────────────
// 4 次心跳（60s）落一次库；这里等 80s 保证「攒 → 落」都发生过。
// 这是本脚本最有价值的一条：它证明页面在前台时确实在累计，且写进了 IndexedDB。
console.log('7. 等待计时（80s，含 4 次心跳与一次落库）…');
await page.waitForTimeout(80_000);

const after = await page.evaluate(() => {
  const t = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? '';
  return { today: t('tile-today') };
});
const stored = await page.evaluate(async (date) => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('wangke');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return await new Promise((resolve, reject) => {
    const tx = db.transaction('studyDays', 'readonly');
    const req = tx.objectStore('studyDays').get(date);
    req.onsuccess = () => resolve(req.result?.seconds ?? 0);
    req.onerror = () => reject(req.error);
  });
}, dates.today);
console.log(`8. 今日卡：${after.today} · 库里今日 ${stored}s（播种 6000s）`);
if (!/1 小时 4[1-9] 分|1 小时 5\d 分/.test(after.today)) fail(`今日卡没涨（应 ≥ 1 小时 41 分）：${after.today}`);
else ok('今日时长随时间上涨');
if (stored <= 6000) fail(`今日秒数没有落库（仍为 ${stored}）`);
else ok(`已落库：${stored}s（+${stored - 6000}s）`);

// 刷新后仍在（说明不是内存里的假象）
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="heat-cells"]', { timeout: 20000 });
const reloaded = await page.textContent('[data-testid="tile-today"]');
if (!/1 小时 4[1-9] 分|1 小时 5\d 分/.test(reloaded ?? '')) fail(`刷新后今日时长丢失：${reloaded}`);
else ok('刷新后今日时长仍在');

// ── 9. 设置页卡片 ─────────────────────────────────────────────────────────
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="card-study-time"]', { timeout: 20000 });
const card = await page.evaluate(() => ({
  tracking: document.querySelector('[data-testid="study-tracking"]')?.checked ?? null,
  idle: document.querySelector('[data-testid="study-idle"]')?.value ?? null,
  summary: document.querySelector('[data-testid="study-summary"]')?.textContent?.trim() ?? '',
}));
console.log('9. 设置页:', JSON.stringify(card));
if (card.tracking !== true) fail('自动记录开关默认应为开');
else ok('自动记录开关默认开');
if (card.idle !== '5') fail(`空闲判定默认应为 5 分钟，实际 ${card.idle}`);
else ok('空闲判定默认 5 分钟');
if (!/活跃 4 天/.test(card.summary) || !/累计 4 小时/.test(card.summary)) fail(`已有记录摘要不符：${card.summary}`);
else ok(`已有记录摘要：${card.summary}`);

console.log(errors.length ? `\n[console errors]\n${errors.join('\n')}` : '\n无 console/page 错误');
if (errors.length) process.exitCode = 1;
await browser.close();
console.log(process.exitCode ? '\n❌ 有用例失败' : '\n✅ 全部通过');
