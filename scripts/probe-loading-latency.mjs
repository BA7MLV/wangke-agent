/* eslint-disable no-console */
// 量测「数据加载」在各场景的真实等待时长 —— 骨架屏延迟阈值的依据。
//
// 为什么先量再上骨架：本项目的数据几乎全部来自本机 IndexedDB，读回是亚毫秒级的
// （见下面 [C] 组：复用连接 p50 = 0.3ms）。对毫秒级场景无脑套骨架屏，等于把
// 「闪一下空态」换成「闪一下骨架」，是负收益。业界的做法是先定延迟阈值
// （等待超过阈值才显示骨架），而阈值必须来自实测 —— 所以这个脚本先产出数字。
//
// 量六件事：
//   A 资料库空库冷启动 —— 首帧到最终态
//   B 资料库有数据冷启动 —— 重点指标：`empty-state` 的出现→消失窗口。
//                        Library.tsx:1284 用 `videos.length === 0 && folders.length === 0`
//                        判空，而首帧数组必然为空（reload 是异步 IndexedDB 读），
//                        于是「未加载」和「确实为空」被混成了同一个状态。
//                        对照：store/courseChat.ts 已经把这两件事分开了（`loaded` / `error`），
//                        注释里明确禁止用 `activeId === null` 兼表「正在加载」。
//   C IndexedDB 直读 —— 基线：本地读到底多快，决定阈值能按哪个量级定。
//                        分「冷连接」与「复用连接」：Dexie 在 app 里是常驻连接，
//                        冷连接的数偏悲观，两组都留着才能解释 B 的量级。
//   D 课程助手页冷启动 —— 默认路由（`/`）现在的落地页
//   E 设置弹窗
//   F 热导航（课程助手 → 资料库）—— 用户日常最常走的那条路，与冷启动分开量
//   G 骨架屏闸门（CPU 降速）—— 见下方「G 组为什么必须量」
//   H 骨架与真内容同形（几何回归）—— 见下方「H 组为什么必须量」
//
// ⚠️ 两个必须守住的量测前提，否则数字全是假的：
//   1. 路由是 HashRouter：资料库在 `/#/library`。而且 `goto()` 到**只有 hash 不同**的
//      同一 URL，浏览器不会重新加载文档 —— 时间线会连着上一次继续累加，
//      多轮量出来的会是同一份数据（表现得像「极其稳定」，其实是没重新加载）。
//      所以冷启动一律走 `freshGoto()`：先 about:blank 再进目标地址。
//   2. `/` 在「对话页改版」后已经是课程助手页，不是资料库。
//
// 用法：node scripts/probe-loading-latency.mjs   （需先 npm run preview）
// 输出：控制台表格 + scripts/.cache/loading-latency.json
// 退出码：断言不过则非 0（与其它 probe-* 同一口径：探针坏掉要显式看见）
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '.cache');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const LIBRARY_URL = `${BASE}/#/library`;
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-test.mp4';
const FIRST_PAINT_ROUNDS = 3;
/**
 * G 组的降速倍数：模拟慢设备 / 主线程被长任务占住的首屏。
 *
 * ⚠️ 这个数**校准过**，不能随便调小。闸门是 200ms，所以要断言「慢速路径必须出骨架」，
 * 就必须让真正喂给闸门的那个忙窗口（`video-list` 首现 → `video-item` 首现，
 * 也就是 Library 首次渲染到列表就位）**明显**越过 200ms。实测：
 *
 * | 降速 | 忙窗口 | 骨架出现在内容之前？ |
 * |---|---|---|
 * | 5×  | 189ms | 否（本来就短于闸门，不出骨架是对的） |
 * | 10× | 343ms | **不稳**：只比闸门高 143ms，且这 343ms 里含最后一次 commit，真正喂给闸门的不到 250ms |
 * | 15× | 560–654ms | 不稳（两轮里有一轮没出） |
 * | 20× | 743–881ms | 出，但骨架与内容落在同一个采样点 |
 * | 25× | 1121–1194ms | 稳定早 186–335ms |
 * | 30× | 1380–1408ms | 稳定早 309–311ms |
 *
 * 原来取 10× —— 那时量到 2507ms 首现（机器更慢），看着是过的；同一份代码换一轮就掉到
 * 343ms，断言随之翻来翻去。**断言必须在任何负载下都确定**，所以按实测顶到 30×。
 */
const SLOW_CPU_RATE = 30;
/**
 * 闸门的两条阈值。**与 `src/ui/skeleton.tsx` 里的常量同源**，那边改了这边要跟着改。
 * 断言用下限留了量测容差：firstSeen 从导航开始算，含整包 JS 的解析执行，
 * 不是「从 React 挂载算」的精确值。
 */
const SKELETON_DELAY_FLOOR_MS = 150;
const SKELETON_MIN_VISIBLE_FLOOR_MS = 350;

const TARGETS = [
  'drop-zone',
  'empty-state',
  'video-item',
  'group-header',
  'course-chat-page',
  'course-chat-messages',
  // 列表容器：它在 Library **首帧**就渲染，与 `loadState` 无关，
  // 所以它的首现时刻就是「忙窗口」的起点（终点用 video-item）。G 组的阈值校准靠它。
  'video-list',
  // 骨架屏闸门：这一项**绝大多数场景下都该是「从未出现」**——
  // 它的出现本身就是结论（等待超过了 200ms 阈值）。见 G 组。
  'library-skeleton',
];

/**
 * 注入到页面的探针：关键节点时间线 + 长任务记录。
 *
 * 为什么用 MutationObserver 而不是 rAF 轮询：空态可能只存在一两帧，16ms 的轮询会漏采；
 * MutationObserver 的回调紧跟 DOM 变更，时间戳更接近真实出现/消失时刻。
 *
 * 为什么要一起收 longtask：如果「读回」很慢而 IndexedDB 本身很快，那时间就花在
 * 主线程被占上，而不是存储上 —— 这两者的修法完全不同（前者要拆 chunk / 让出主线程，
 * 后者才是加载态该管的事）。没有 longtask 数据就只能猜。
 *
 * 时间基准是 performance.now()（相对导航开始），firstSeen 直接就是「导航后多少毫秒」。
 *
 * ⚠️ 时间戳会被「钳制」：MutationObserver 的回调是微任务，主线程被长任务占住时会被推迟，
 * 回调里读到的 performance.now() 是**推迟后**的时刻。极端情况下两个节点的插入落在两次
 * 回调之间，就会拿到**同一个时间戳**（实测 CPU 20× 降速下骨架与 video-item 都是 2884ms，
 * 看着像「同时出现」，其实中间隔着几百毫秒没落点）。
 * 所以凡是「A 是否早于 B」这类判断，一律不能拿时间戳相减。
 *
 * 第一版用的是个布尔闩：「某次扫描时骨架在场、内容还不在」。**它不够** —— 回调被推迟到
 * 内容也挂上之后才跑，那次扫描看到的就是两层都在，闩永远是 false（实测 30× 降速下翻车：
 * 骨架与内容同为 6033ms，闩 false，但实现是对的）。DOM 快照类判据都逃不过这个。
 *
 * 最终用的是 **mutation 记录序号**：回调会把多次变更合并，但 `records` 数组保持真实的
 * 插入顺序，且不受回调何时执行影响。记下每个 testid「第一次被加进 DOM」时排在第几条，
 * 比大小即可。
 */
const PROBE_SCRIPT = `
(() => {
  const TARGETS = ${JSON.stringify(TARGETS)};
  const state = {};
  const mountOrder = {};   // testid -> 第一次被加进 DOM 时的记录序号
  let skeletonAloneSeen = false;
  let seq = 0;
  const scan = () => {
    const now = performance.now();
    for (const id of TARGETS) {
      const present = !!document.querySelector('[data-testid="' + id + '"]');
      let s = state[id];
      if (!s) s = state[id] = { firstSeen: null, firstGone: null, present: false, transitions: 0 };
      if (present !== s.present) {
        s.transitions += 1;
        if (present && s.firstSeen === null) s.firstSeen = now;
        if (!present && s.firstSeen !== null && s.firstGone === null) s.firstGone = now;
        s.present = present;
      }
    }
    // 仅供参考的闩：某次扫描时骨架在台上、内容还没来。会被回调推迟骗到（见文件头说明）
    if (state['library-skeleton']?.present && !state['video-item']?.present) skeletonAloneSeen = true;
  };
  // 「谁先挂上 DOM」只能从这里拿：records 数组保持真实插入顺序，与回调何时执行无关
  const noteAdds = (records) => {
    for (const rec of records) {
      seq += 1;
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1 || !node.querySelectorAll) continue;
        const hits = node.matches('[data-testid]') ? [node] : [];
        for (const el of node.querySelectorAll('[data-testid]')) hits.push(el);
        for (const el of hits) {
          const id = el.getAttribute('data-testid');
          if (TARGETS.indexOf(id) !== -1 && mountOrder[id] === undefined) mountOrder[id] = seq;
        }
      }
    }
  };
  const onMutations = (records) => { noteAdds(records); scan(); };
  const attach = () => new MutationObserver(onMutations).observe(document.documentElement, {
    childList: true, subtree: true,
  });
  // addInitScript 跑在文档创建早期，documentElement 可能还不存在 —— 等它出现再接。
  if (document.documentElement) {
    attach();
  } else {
    const boot = new MutationObserver(() => {
      if (document.documentElement) { boot.disconnect(); attach(); }
    });
    boot.observe(document, { childList: true, subtree: true });
  }
  scan();

  const longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (err) { /* 老浏览器没有 longtask，忽略 */ }

  window.__probe = () => ({
    now: performance.now(),
    state: JSON.parse(JSON.stringify(state)),
    mountOrder: JSON.parse(JSON.stringify(mountOrder)),
    skeletonAloneSeen,
    longTasks: longTasks.slice(),
    nav: (() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null;
    })(),
  });
})();
`;

const readProbe = (page) => page.evaluate(() => (window.__probe ? window.__probe() : null));

/**
 * 把「加载中」这个状态**钉住**的脚本 —— H 组量骨架几何时用。
 *
 * 做法是让 IndexedDB 请求的 success / error 永不派发：库读一直悬着，
 * `loadState` 就停在 `loading`，骨架稳定留在台上，想什么时候量就什么时候量。
 *
 * 为什么非要钉住、不能像 G 组那样降速赛跑：骨架**独占**的窗口只有几百毫秒，
 * 而降速下光是截一帧就要好几秒 —— 等得回来，内容早就顶上去了。
 * 这个坑在 probe-skeleton-visual.mjs 上已经踩过一次（截出来的图是内容，文件名却叫骨架）。
 *
 * 捕获阶段注册监听器 + `stopImmediatePropagation` 能同时挡住 Dexie 用的
 * `addEventListener` 与 `onsuccess` 属性两条路 —— 这是实测确认过的，不是推测。
 */
const PIN_LOADING_SCRIPT = `
(() => {
  const realOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = function (...args) {
    const req = realOpen(...args);
    for (const type of ['success', 'error']) {
      req.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
    }
    return req;
  };
})();
`;

/** 同形比对用的锚点：真内容与骨架两侧选择器一致（骨架复用了真类）。 */
const GEOMETRY_SELECTORS = [
  '.video-grid',
  '.video-row',
  '.video-row__thumb',
  '.video-row__name',
  '.video-row__meta',
  '.video-row__tags',
  '.video-row__actions',
];

/** 几何容差。±4px：真值里带小数行高（h2 30.8px、name 23px），骨架给的是整数，
 *  要求逐像素相等只会逼出一堆没有意义的尾数。这个量级肉眼不可见，也不会引起可见跳动。 */
const GEOMETRY_TOLERANCE_PX = 4;

const measureGeometry = (page) =>
  page.evaluate(
    (selectors) =>
      selectors.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, missing: true };
        const r = el.getBoundingClientRect();
        return { sel, y: Math.round(r.y), h: Math.round(r.height) };
      }),
    GEOMETRY_SELECTORS,
  );


/**
 * 断言。与其它 probe-* 同一口径：探针坏掉要显式看见，不能「仅供参考」地静默通过。
 * 不过的项先记下来，跑完统一非 0 退出。
 */
const failures = [];
function check(ok, label, extra = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` —— ${extra}` : ''}`);
  if (!ok) failures.push(label);
}

/** 冷启动：先 about:blank 再进目标地址，强制文档重新加载（hash 相同也会重载） */
async function freshGoto(page, url) {
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'load' });
}

/** 把原始时间线压成「首次出现 / 首次消失 / 可见窗口」三列 */
function summarize(tl) {
  const out = {};
  for (const [id, s] of Object.entries(tl?.state ?? {})) {
    const seen = s.firstSeen === null ? null : Math.round(s.firstSeen);
    const gone = s.firstGone === null ? null : Math.round(s.firstGone);
    out[id] = {
      firstSeenMs: seen,
      firstGoneMs: gone,
      visibleWindowMs: seen !== null && gone !== null ? Math.round(gone - seen) : null,
      transitions: s.transitions,
    };
  }
  return out;
}

/** longtask 汇总：总阻塞时长 + 最长的一段 */
function summarizeLongTasks(tasks) {
  if (!tasks?.length) return { count: 0, totalMs: 0, longestMs: 0, top: [] };
  const sorted = [...tasks].sort((a, b) => b.dur - a.dur);
  return {
    count: tasks.length,
    totalMs: tasks.reduce((s, t) => s + t.dur, 0),
    longestMs: sorted[0].dur,
    top: sorted.slice(0, 5),
  };
}

/** IndexedDB 直读耗时：冷连接（每次重新 open）与复用连接各量一组 */
async function measureIdb(page, rounds) {
  return page.evaluate(async (n) => {
    const openDb = () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('wangke');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
      });
    const getAll = (db, table) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(table, 'readonly');
        const all = tx.objectStore(table).getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = () => resolve(all.result);
      });
    const stat = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      return {
        min: +s[0].toFixed(1),
        p50: +s[Math.floor(s.length / 2)].toFixed(1),
        max: +s[s.length - 1].toFixed(1),
      };
    };

    const probe = await openDb();
    const rowCount = (await getAll(probe, 'videos')).length;
    probe.close();

    const cold = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const db = await openDb();
      await getAll(db, 'videos');
      cold.push(performance.now() - t0);
      db.close();
    }

    const warm = [];
    const db = await openDb();
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await getAll(db, 'videos');
      warm.push(performance.now() - t0);
    }
    db.close();

    return { rowCount, cold: stat(cold), warm: stat(warm), rounds: n };
  }, rounds);
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
console.log('=== 数据加载耗时量测（骨架屏阈值依据）===');
console.log(`   BASE = ${BASE}`);
mkdirSync(CACHE_DIR, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
// 独立 context：不碰用户正在用的浏览器 profile 与 IndexedDB
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await context.addInitScript({ content: PROBE_SCRIPT });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));

const report = { base: BASE, measuredAt: new Date().toISOString(), scenarios: {} };

/** 冷启动一次并采样 */
async function coldStart(url, waitFor, label) {
  await freshGoto(page, url);
  await page.waitForSelector(`[data-testid="${waitFor}"]`, { timeout: 20000 });
  await page.waitForTimeout(1200); // 留足余量，确保「出现→消失」的窗口已经闭合
  const raw = await readProbe(page);
  return {
    timeline: summarize(raw),
    longTasks: summarizeLongTasks(raw.longTasks),
    nav: raw.nav,
    skeletonAloneSeen: raw.skeletonAloneSeen,
    mountOrder: raw.mountOrder,
    label,
  };
}

// ── D. 课程助手页冷启动（默认路由）────────────────────────────────────────────
const d = await coldStart(BASE, 'course-chat-page', 'chat-cold');
report.scenarios.chatColdStart = d;
console.log('\n[D] 课程助手页冷启动：');
console.log(`    首帧 ${d.timeline['course-chat-page']?.firstSeenMs}ms · DCL ${d.nav?.domContentLoaded}ms · load ${d.nav?.load}ms`);
console.log(`    长任务 ${d.longTasks.count} 段 / 合计阻塞 ${d.longTasks.totalMs}ms / 最长 ${d.longTasks.longestMs}ms`);

// ── A. 资料库空库冷启动 ──────────────────────────────────────────────────────
const a = await coldStart(LIBRARY_URL, 'drop-zone', 'library-empty-cold');
report.scenarios.emptyLibraryColdStart = a;
console.log('\n[A] 资料库空库冷启动：');
console.log(`    首帧 ${a.timeline['drop-zone']?.firstSeenMs}ms · DCL ${a.nav?.domContentLoaded}ms · load ${a.nav?.load}ms`);
console.log(`    长任务 ${a.longTasks.count} 段 / 合计阻塞 ${a.longTasks.totalMs}ms / 最长 ${a.longTasks.longestMs}ms`);

// ── C1. IndexedDB 直读（空库）─────────────────────────────────────────────────
report.scenarios.idbEmpty = await measureIdb(page, 20);
console.log('[C1] IndexedDB 直读（空库）：', JSON.stringify(report.scenarios.idbEmpty));

// ── 造数据：导入测试视频 ─────────────────────────────────────────────────────
console.log('\n导入测试视频（造数据）…');
await page.setInputFiles('[data-testid="import-input"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 120000 });
console.log('   导入完成');

// ── C2. IndexedDB 直读（有数据）─────────────────────────────────────────────
report.scenarios.idbWithData = await measureIdb(page, 20);
console.log('[C2] IndexedDB 直读（有数据）：', JSON.stringify(report.scenarios.idbWithData));

// ── B. 资料库有数据冷启动（多轮）────────────────────────────────────────────
const rounds = [];
for (let i = 0; i < FIRST_PAINT_ROUNDS; i++) {
  const b = await coldStart(LIBRARY_URL, 'video-item', `library-data-cold-${i + 1}`);
  rounds.push(b);
  const empty = b.timeline['empty-state'];
  console.log(
    `[B${i + 1}] 资料库有数据冷启动：empty-state 首现 ${empty?.firstSeenMs ?? '未出现'}ms / ` +
      `消失 ${empty?.firstGoneMs ?? '—'}ms / 可见窗口 ${empty?.visibleWindowMs ?? '—'}ms / ` +
      `video-item 首现 ${b.timeline['video-item']?.firstSeenMs ?? '—'}ms / ` +
      `最长长任务 ${b.longTasks.longestMs}ms`,
  );
}
const windows = rounds
  .map((r) => r.timeline['empty-state']?.visibleWindowMs)
  .filter((v) => typeof v === 'number')
  .sort((a2, b2) => a2 - b2);
report.scenarios.libraryDataColdStartRounds = rounds;
report.scenarios.emptyFlashMedianMs = windows.length ? windows[Math.floor(windows.length / 2)] : null;
report.scenarios.emptyFlashAllMs = windows;

// ── B/A 组的断言 ────────────────────────────────────────────────────────────
// B：有数据的库冷启动 —— 「未加载」与「确实为空」分开之后，空态**一次都不该出现**。
//    改之前这三个数字是 64 / 65 / 94ms，就是那一闪。
const bEmptySeen = rounds.map((r) => r.timeline['empty-state']?.firstSeenMs ?? null);
check(bEmptySeen.every((v) => v === null), 'B 有数据的库冷启动不再闪空态', `firstSeen=${JSON.stringify(bEmptySeen)}`);
const bSkelSeen = rounds.map((r) => r.timeline['library-skeleton']?.firstSeenMs ?? null);
check(bSkelSeen.every((v) => v === null), 'B 快速路径不出骨架', `firstSeen=${JSON.stringify(bSkelSeen)}`);

// A：空库**仍然要**显示空态。这条是三态改动的回归守卫 ——
//    把「加载中」和「空」分开时最容易顺手把空态本身也吞掉。
const aEmpty = a.timeline['empty-state'];
check(aEmpty?.firstSeenMs != null, 'A 空库仍然显示空态（三态没有把空态一起吞掉）', `firstSeen=${aEmpty?.firstSeenMs ?? 'null'}`);

// ── F. 热导航：课程助手 → 资料库 ─────────────────────────────────────────────
// 用户日常最常走的路：app 已经开着，从导航栏切到资料库。
// 与冷启动分开量 —— 冷启动包含整包 JS 的解析执行，热导航不会。
await freshGoto(page, BASE);
await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: 20000 });
await page.waitForTimeout(600);
const navT0 = await page.evaluate(() => performance.now());
await page.click('[data-testid="nav-rail-home"]');
await page.waitForSelector('[data-testid="video-item"]', { timeout: 20000 });
const navT1 = await page.evaluate(() => performance.now());
const hotRaw = await readProbe(page);
report.scenarios.hotNavChatToLibrary = {
  clickToVideoItemMs: Math.round(navT1 - navT0),
  emptyState: summarize(hotRaw)['empty-state'],
  longTasks: summarizeLongTasks(hotRaw.longTasks),
};
console.log('\n[F] 热导航（课程助手 → 资料库）：', JSON.stringify(report.scenarios.hotNavChatToLibrary));

// ── E. 设置弹窗 ──────────────────────────────────────────────────────────────
await page.click('[data-testid="nav-rail-settings"]');
await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 10000 });
const hasBuildInfo = (await page.locator('[data-testid="build-info"]').count()) > 0;
report.scenarios.settingsModal = { hasBuildInfo };
console.log('[E] 设置弹窗：', JSON.stringify(report.scenarios.settingsModal));

// ── G. 骨架屏闸门 ────────────────────────────────────────────────────────────
//
// ## G 组为什么必须量
//
// 骨架屏的阈值（200ms 延迟 / 400ms 最短停留）是**规则**，不是**结果**。
// 规则要能验证，否则「加了骨架屏」和「骨架屏在该出现时出现了」是两回事 ——
// 前者只要写了 JSX 就算，后者才决定用户到底有没有看见它。
//
// 这一组就跑两条相反的断言，缺一条都等于没测：
//   G1 快速路径（正常速度）**一个骨架都不许出** —— 本机 IndexedDB 是亚毫秒级，
//      这里出骨架就是「把闪一下空态换成闪一下骨架」，纯负收益；
//   G2 慢速路径（CPU 降速 `SLOW_CPU_RATE` 倍）**必须出骨架** —— 出不来说明闸门
//      只会永远静默，那还不如不做。倍数必须校准，理由见 SLOW_CPU_RATE 上方那张实测表。
//
// 用 CDP 的 CPU 降速而不是伪造一个延时：这才是闸门真正要挡的那种慢
// （慢设备、主线程被整包 JS 的解析执行占住），测出来的东西才有意义。
const cdp = await context.newCDPSession(page);
const setCpu = (rate) => cdp.send('Emulation.setCPUThrottlingRate', { rate });

// G1：正常速度，有数据的库冷启动 —— 空态与骨架都该「从未出现」
const g1 = await coldStart(LIBRARY_URL, 'video-item', 'g1-fast');
const g1Empty = g1.timeline['empty-state'];
const g1Skel = g1.timeline['library-skeleton'];
console.log('\n[G1] 快速路径（无降速）：');
console.log(`    empty-state 首现 ${g1Empty?.firstSeenMs ?? '未出现'} · library-skeleton 首现 ${g1Skel?.firstSeenMs ?? '未出现'}`);
check(g1Empty?.firstSeenMs == null, 'G1 有数据的库冷启动不再闪空态', `empty-state firstSeen=${g1Empty?.firstSeenMs ?? 'null'}`);
check(g1Skel?.firstSeenMs == null, 'G1 快速路径不出骨架（延迟门控生效）', `skeleton firstSeen=${g1Skel?.firstSeenMs ?? 'null'}`);
report.scenarios.gateFast = { emptyState: g1Empty, skeleton: g1Skel };

// G2：CPU 30 倍降速 —— 骨架必须出现，并在内容就位后收走
await setCpu(SLOW_CPU_RATE);
const g2 = await coldStart(LIBRARY_URL, 'video-item', 'g2-slow');
await setCpu(1);
const g2Skel = g2.timeline['library-skeleton'];
const g2Empty = g2.timeline['empty-state'];
const g2List = g2.timeline['video-list'];
const g2Item = g2.timeline['video-item'];
const g2Mount = g2.mountOrder ?? {};
const g2BusyWindowMs =
  g2List?.firstSeenMs != null && g2Item?.firstSeenMs != null ? g2Item.firstSeenMs - g2List.firstSeenMs : null;
console.log(`\n[G2] 慢速路径（CPU ${SLOW_CPU_RATE}× 降速）：`);
console.log(`    忙窗口（video-list → video-item）${g2BusyWindowMs ?? '—'}ms`);
console.log(`    library-skeleton 首现 ${g2Skel?.firstSeenMs ?? '未出现'} · 收走 ${g2Skel?.firstGoneMs ?? '—'} · 可见 ${g2Skel?.visibleWindowMs ?? '—'}ms`);
console.log(`    骨架独占过（在场时内容还不在）：${g2.skeletonAloneSeen === true ? '是' : '否'}（仅供参考，会被回调推迟骗到）`);
console.log(`    video-item 首现 ${g2Item?.firstSeenMs ?? '—'}ms · 挂载序号 骨架=${g2Mount['library-skeleton'] ?? '—'} 内容=${g2Mount['video-item'] ?? '—'}`);
check(g2Skel?.firstSeenMs != null, 'G2 慢速路径出骨架', `skeleton firstSeen=${g2Skel?.firstSeenMs ?? 'null'}`);
// 「骨架早于内容」看挂载序号，不看时间戳、也不看 DOM 快照 —— 理由见 PROBE_SCRIPT 上方的说明
check(
  g2Mount['library-skeleton'] != null && g2Mount['video-item'] != null && g2Mount['library-skeleton'] < g2Mount['video-item'],
  'G2 骨架出现在内容之前（是真的加载态，不是内容到位后补一帧）',
  `挂载序号 骨架=${g2Mount['library-skeleton'] ?? '未挂载'} 内容=${g2Mount['video-item'] ?? '未挂载'}`,
);
check((g2Skel?.visibleWindowMs ?? 0) >= SKELETON_MIN_VISIBLE_FLOOR_MS, 'G2 骨架停留满足最短时长', `可见 ${g2Skel?.visibleWindowMs}ms`);
check(g2Skel?.firstGoneMs != null, 'G2 内容就位后骨架收走', `firstGone=${g2Skel?.firstGoneMs ?? 'null'}`);
// 骨架存在期间空态不许一起冒出来（那才是我们要消灭的那一闪）
check(
  g2Empty?.firstSeenMs == null || (g2Skel?.firstGoneMs != null && g2Empty.firstSeenMs > g2Skel.firstGoneMs),
  'G2 骨架期间没有同时闪空态',
  `empty firstSeen=${g2Empty?.firstSeenMs ?? 'null'}`,
);
report.scenarios.gateSlow = {
  skeleton: g2Skel,
  skeletonAloneSeen: g2.skeletonAloneSeen,
  mountOrder: g2Mount,
  emptyState: g2Empty,
  videoList: g2List,
  videoItem: g2Item,
  busyWindowMs: g2BusyWindowMs,
  cpuRate: SLOW_CPU_RATE,
};

// ── H. 骨架与真内容「同形」（几何回归）──────────────────────────────────────
//
// 骨架屏最容易「看着对、其实错」的地方就是几何：卡片矮一截、列表起点偏一截，
// 内容到位时都会把页面顶一下 —— 而「跳一下」比「多等一会儿」更让人烦躁。
//
// ⚠️ 这条断言不是补着好看的，它抓过一次真错：上一版骨架是手写高度「凑」出来的，
// 真卡片 308px、骨架 259px（每张矮 49px），列表起点还高了 144px（工具栏那一段挂在
// 「有没有数据」上，加载中整段不渲染，骨架没给它留占位）。肉眼看截图只觉得「有点糊」，
// 是这两个数把它变成了可判定的事实。
//
// ⚠️ 而且它必须在**同一台机器、同一次运行**里量两侧：几何依赖字体渲染与视口，
// 两次运行之间没有可比性。
//
// 顺序上放在最后：PIN_LOADING_SCRIPT 装上之后这一页就读不了库了，后面不该再有导航。
await freshGoto(page, LIBRARY_URL);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 20000 });
await page.waitForTimeout(300);
const geomReal = await measureGeometry(page);

await page.addInitScript({ content: PIN_LOADING_SCRIPT });
await freshGoto(page, LIBRARY_URL);
await page.waitForSelector('[data-testid="library-skeleton"]', { timeout: 20000 });
await page.waitForTimeout(300);
const geomSkel = await measureGeometry(page);

console.log('\n[H] 骨架与真内容同形：');
console.log('    元素'.padEnd(26) + '真内容 y/h'.padEnd(16) + '骨架 y/h'.padEnd(16) + 'Δy   Δh');
for (let i = 0; i < GEOMETRY_SELECTORS.length; i++) {
  const a = geomReal[i];
  const b = geomSkel[i];
  const show = (g) => (g.missing ? '—' : `${g.y}/${g.h}`);
  console.log(
    `    ${a.sel.padEnd(22)}${show(a).padEnd(16)}${show(b).padEnd(16)}` +
      `${a.missing || b.missing ? '—' : b.y - a.y}    ${a.missing || b.missing ? '—' : b.h - a.h}`,
  );
}

const rowReal = geomReal.find((g) => g.sel === '.video-row');
const rowSkel = geomSkel.find((g) => g.sel === '.video-row');
const gridReal = geomReal.find((g) => g.sel === '.video-grid');
const gridSkel = geomSkel.find((g) => g.sel === '.video-grid');

const withinTolerance = (a, b) => a != null && b != null && Math.abs(a - b) <= GEOMETRY_TOLERANCE_PX;

check(rowSkel?.h != null, 'H 骨架里量得到卡片', `h=${rowSkel?.h ?? 'null'}`);
check(
  withinTolerance(rowReal?.h, rowSkel?.h),
  'H 骨架卡片与真卡片等高（形状对不上 = 加载完再抖一下）',
  `真 ${rowReal?.h} / 骨架 ${rowSkel?.h} / 容差 ${GEOMETRY_TOLERANCE_PX}px`,
);
check(
  withinTolerance(gridReal?.y, gridSkel?.y),
  'H 骨架列表起点与真列表对齐（工具栏那一段必须留占位）',
  `真 ${gridReal?.y} / 骨架 ${gridSkel?.y}`,
);
check(
  withinTolerance(
    geomReal.find((g) => g.sel === '.video-row__thumb')?.h,
    geomSkel.find((g) => g.sel === '.video-row__thumb')?.h,
  ),
  'H 缩略图等高（16:9 的盒子必须逐像素一致）',
);
check(
  withinTolerance(
    geomReal.find((g) => g.sel === '.video-row__actions')?.h,
    geomSkel.find((g) => g.sel === '.video-row__actions')?.h,
  ),
  'H 操作行等高（真卡片上最容易被漏掉的一行）',
);

report.scenarios.geometry = { real: geomReal, skeleton: geomSkel, tolerancePx: GEOMETRY_TOLERANCE_PX };


report.pageErrors = errors;
writeFileSync(join(CACHE_DIR, 'loading-latency.json'), JSON.stringify(report, null, 2));
console.log('\n报告写入 scripts/.cache/loading-latency.json');
if (errors.length) console.log(`页面报错 ${errors.length} 条：`, errors.slice(0, 3));

if (failures.length) {
  console.error(`\n断言未通过 ${failures.length} 项：`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('\n全部断言通过。');
}

await browser.close();
