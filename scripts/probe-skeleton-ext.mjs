/* eslint-disable no-console */
// 骨架屏扩展的核验：播放页首载 / 面板空态 / 材料正文。
//
// 这是 docs/plans/2026-10-16-骨架屏扩展-design.md 的验证脚本。三组各自回答一个具体问题：
//
//   P 播放页首载骨架：形状对不对（16:9 + 面板栏），条目行骨架与真行等高吗。
//   Q 面板不再闪空态：造一门「有字幕 / 有卡片 / 有弹幕 / 有讨论」的课，断言四个面板的空态
//     **一次都不出现**。这是本轮真正的 bug 修复（不变量 I1）；判据与
//     probe-loading-latency 的 B 组同源。同时断言快速路径**不出骨架**（延迟门控生效）。
//   R 材料正文骨架：把 OPFS 的 `materials` 目录读取**延迟 8 秒**（不是在跟窗口赛跑，
//     是把「加载中」钉住），断言 Word/Markdown 的正文骨架出现，且延迟结束后真内容就位
//     （证明它是一个有结束条件的加载态，不变量 I5）。
//
// 为什么面板组不量「慢速路径出骨架」：面板读的是本地 IndexedDB（p50 0.1ms），
// CPU 降速 30× 也只有几毫秒，本来就不该越过 200ms 闸门 —— 「不出」才是对的。
// 这一点由 Q 的快速路径断言覆盖；骨架本身的同形由 P 组（侧栏就是 CueSkeleton）量。
//
// 用法：node scripts/probe-skeleton-ext.mjs   （需先 npm run preview）
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const OUT = join(__dirname, '..', 'e2e-shots', 'skeleton-ext');
const WAIT_MS = 30000;
const VIDEO_ID = 'probe-ext-video';
const MATERIAL_ID = 'probe-ext-material';
const MATERIAL_PDF_ID = 'probe-ext-material-pdf';

/** 把「加载中」钉住的脚本（与 probe-skeleton-visual.mjs 同源）：库读一直悬着。 */
const PIN_LOADING = `
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

/**
 * 只把「读 OPFS 里的 materials 目录」拖慢（8s），别的 IO 不动。
 *
 * 为什么不能像 P 组那样整体钉住 IndexedDB：播放页要先读 `videos` 那一行才知道这是材料，
 * 整体钉住的话页面会停在播放页骨架、永远走不到阅读器。这里拖的是**阅读器那一步**。
 *
 * 刻意包一层普通对象而不是给原生句柄挂方法：原生 `FileSystemDirectoryHandle` 的方法
 * 要求 `this` 是它自己，改写实例属性在部分实现上会直接失效（静默不生效）。包装只覆盖
 * `getDirectoryHandle` / `getFileHandle` / `removeEntry` 这三个 fileStore 真正会用到的。
 */
const DELAY_MATERIAL_READ = `
(() => {
  if (!navigator.storage || !navigator.storage.getDirectory) return;
  const realGetDirectory = navigator.storage.getDirectory.bind(navigator.storage);
  navigator.storage.getDirectory = async () => {
    const root = await realGetDirectory();
    return {
      getDirectoryHandle: async (name, opts) => {
        const realDir = await root.getDirectoryHandle(name, opts);
        if (name !== 'materials') return realDir;
        return {
          getFileHandle: async (fileId, o) => {
            await new Promise((r) => setTimeout(r, 8000));
            return realDir.getFileHandle(fileId, o);
          },
          removeEntry: (entryName, o) => realDir.removeEntry(entryName, o),
        };
      },
    };
  };
})();
`;

/**
 * 观察一组选择器的首次出现时刻，以及（给定了 testid 的）「谁先挂上 DOM」。
 * 用 mutation 记录序号而不是时间戳相减：回调会被长任务推迟（见 probe-loading-latency 的说明）。
 */
const watchScript = (entries) => `
(() => {
  const ENTRIES = ${JSON.stringify(entries)};
  const firstSeen = {};
  const order = {};
  let seq = 0;
  const note = (records) => {
    if (records) {
      for (const rec of records) {
        seq += 1;
        for (const node of rec.addedNodes) {
          if (node.nodeType !== 1 || !node.querySelectorAll) continue;
          const all = [node, ...node.querySelectorAll('[data-testid]')];
          for (const el of all) {
            if (!el.getAttribute) continue;
            const id = el.getAttribute('data-testid');
            for (const e of ENTRIES) {
              if (e.id && e.id === id && order[e.key] === undefined) order[e.key] = seq;
            }
          }
        }
      }
    }
    const now = Math.round(performance.now());
    for (const e of ENTRIES) {
      if (firstSeen[e.key] === undefined && document.querySelector(e.selector)) firstSeen[e.key] = now;
    }
  };
  const attach = () => new MutationObserver((recs) => note(recs)).observe(document.documentElement, {
    childList: true, subtree: true,
  });
  if (document.documentElement) attach();
  else new MutationObserver(() => { if (document.documentElement) attach(); }).observe(document, { childList: true, subtree: true });
  note(null);
  window.__watch = () => ({ firstSeen, order });
})();
`;

/** `panelSkeleton` 必须**限定在面板里**：播放页首载骨架的侧栏也用 CueSkeleton，
 *  不限定的话会把「播放页加载中」误记成「面板出了骨架」。 */
const PANEL_SKELETON_SELECTOR = [
  '[data-testid="panel-subs"] [data-testid="cue-skeleton"]',
  '[data-testid="panel-dm"] [data-testid="cue-skeleton"]',
  '[data-testid="panel-cards"] [data-testid="cue-skeleton"]',
].join(', ');

const WATCH = [
  { key: 'subsEmpty', selector: '[data-testid="subs-empty"]' },
  { key: 'cardsEmpty', selector: '[data-testid="cards-empty"]' },
  { key: 'dmEmpty', selector: '[data-testid="dm-empty"]' },
  { key: 'commentsEmpty', selector: '[data-testid="comments-empty"]' },
  { key: 'panelSkeleton', selector: PANEL_SKELETON_SELECTOR },
  { key: 'subsRow', selector: '[data-testid="subs-row"]', id: 'subs-row' },
  { key: 'dmRow', selector: '[data-testid="dm-row"]', id: 'dm-row' },
  { key: 'cmtThread', selector: '[data-testid="cmt-thread"]', id: 'cmt-thread' },
];

const failures = [];
function check(ok, label, extra = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` —— ${extra}` : ''}`);
  if (!ok) failures.push(label);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });

/** 造一门「什么都有」的课 + 一份 Markdown 材料。直接写 IndexedDB / OPFS，不走 AI 流水线。 */
async function seed(page) {
  await page.evaluate(
    async ({ videoId, materialId, materialPdfId }) => {
      const open = () =>
        new Promise((res, rej) => {
          const r = indexedDB.open('wangke');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      const db = await open();
      const now = Date.now();
      const tx = db.transaction(['videos', 'segments', 'cards', 'danmakus', 'comments'], 'readwrite');
      const videos = tx.objectStore('videos');
      videos.put({
        id: videoId,
        name: '探针课程.mp4',
        size: 1024,
        mimeType: 'video/mp4',
        duration: 600,
        createdAt: now,
        status: 'transcribed',
        lastPosition: 0,
        finished: 0,
        coverState: 'done',
      });
      videos.put({
        id: materialId,
        name: '探针材料.md',
        size: 2048,
        mimeType: 'text/markdown',
        duration: 0,
        createdAt: now,
        status: 'transcribed',
        kind: 'material',
        materialFormat: 'md',
        unitCount: 3,
        lastUnit: 1,
        coverState: 'done',
      });
      videos.put({
        id: materialPdfId,
        name: '探针材料.pdf',
        size: 2048,
        mimeType: 'application/pdf',
        duration: 0,
        createdAt: now,
        status: 'transcribed',
        kind: 'material',
        materialFormat: 'pdf',
        unitCount: 1,
        lastUnit: 1,
        coverState: 'done',
      });
      const segs = tx.objectStore('segments');
      for (let i = 0; i < 12; i += 1) {
        segs.put({
          videoId,
          idx: i,
          start: i * 10,
          end: i * 10 + 9,
          text: `第 ${i + 1} 句字幕：探针造出来的内容，用来验证空态不再误闪。`,
          status: 1,
        });
      }
      const cards = tx.objectStore('cards');
      for (let i = 0; i < 4; i += 1) {
        cards.put({ videoId, q: `问题 ${i + 1}？`, a: `答案 ${i + 1}`, time: i * 10, status: 0, createdAt: now });
      }
      const dm = tx.objectStore('danmakus');
      for (let i = 0; i < 4; i += 1) dm.put({ videoId, time: i * 10, text: `思考题 ${i + 1}` });
      const cm = tx.objectStore('comments');
      for (let i = 0; i < 3; i += 1) {
        cm.put({ videoId, time: i * 10, author: '小明', role: 'ask', text: `讨论 ${i + 1}`, createdAt: now });
      }
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
      db.close();
    },
    { videoId: VIDEO_ID, materialId: MATERIAL_ID, materialPdfId: MATERIAL_PDF_ID },
  );
}

/** 直接往 OPFS 的 materials 目录写一份 Markdown（不经过应用的 fileStore）。 */
async function seedMaterialFile(page, id, text) {
  await page.evaluate(
    async ({ id, text }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('materials', { create: true });
      const fh = await dir.getFileHandle(id, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([text], { type: 'text/markdown' }));
      await w.close();
    },
    { id, text },
  );
}

/** 先让应用建好库（Dexie 的 schema 由它自己写），再造数据。 */
async function bootAndSeed(page) {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="course-chat-page"]', { timeout: WAIT_MS });
  await seed(page);
}

// ── P. 播放页首载骨架 ────────────────────────────────────────────────────────
console.log('=== 骨架屏扩展核验 ===');
console.log(`   BASE = ${BASE}`);

{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript({ content: PIN_LOADING });
  const page = await context.newPage();
  await page.goto(`${BASE}/#/player/${VIDEO_ID}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="player-skeleton"]', { timeout: WAIT_MS });
  await page.waitForTimeout(300);

  const geo = await page.evaluate(() => {
    const stage = document.querySelector('.player-skel__stage');
    const rows = [...document.querySelectorAll('.skel-cue__row')].map((el) =>
      Math.round(el.getBoundingClientRect().height),
    );
    const scene = document.querySelector('.side-pane');
    const r = stage?.getBoundingClientRect();
    const sr = scene?.getBoundingClientRect();
    return {
      stage: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      rows,
      sidePane: sr ? { w: Math.round(sr.width), h: Math.round(sr.height) } : null,
      hasContent: !!document.querySelector('[data-testid="panel-tabs"]'),
    };
  });
  const file = join(OUT, 'skel-ext-1-player.png');
  await page.screenshot({ path: file });
  await context.close();

  console.log('\n[P] 播放页首载骨架：');
  console.log(`    视频块 ${JSON.stringify(geo.stage)} · 侧栏 ${JSON.stringify(geo.sidePane)} · 条目行高 ${JSON.stringify(geo.rows)}`);
  console.log(`    → ${file}`);
  const ratio = geo.stage ? geo.stage.w / geo.stage.h : 0;
  const oneLine = geo.rows.filter((h) => h < 44);
  const twoLine = geo.rows.filter((h) => h >= 44);
  check(!!geo.stage, 'P 首载渲染了同形骨架（不是一条居中转圈）');
  check(Math.abs(ratio - 16 / 9) < 0.06, 'P 视频块是 16:9（与真播放器等高）', `ratio=${ratio.toFixed(3)}`);
  check(
    oneLine.length > 0 && oneLine.every((h) => h >= 32 && h <= 38),
    'P 单行条目骨架与真行等高（真 `.sub-item` 单行 ≈36px，±4）',
    `单行=${JSON.stringify(oneLine)}`,
  );
  check(
    twoLine.length > 0 && twoLine.every((h) => h >= 52 && h <= 62),
    'P 双行条目骨架也同形（真两行 ≈56px，±4）',
    `双行=${JSON.stringify(twoLine)}`,
  );
  check(!!geo.sidePane, 'P 右侧面板栏在位（左视频 / 右面板两栏）');
  check(!geo.hasContent, 'P 骨架期没有真实面板（加载态确实在台上）');
}

// ── Q. 面板不再闪空态 + 快速路径不出骨架 ─────────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

  await bootAndSeed(page);
  await page.addInitScript({ content: watchScript(WATCH) });
  await page.goto('about:blank');
  await page.goto(`${BASE}/#/player/${VIDEO_ID}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="subs-row"]', { timeout: WAIT_MS });
  // 讨论区默认展开，直接验证「有内容时不显示空态」。
  await page.waitForSelector('[data-testid="cmt-thread"]', { timeout: WAIT_MS });
  await page.waitForTimeout(900);
  const watch = await page.evaluate(() => window.__watch());
  const commentMeta = await page.evaluate(
    () => document.querySelector('[data-testid="comments-count"]')?.textContent ?? '',
  );
  // 卡片面板被 SkeletonReveal 包了一小块（只包占位），切过去量一下滑动卡还在不在原位
  await page.click('[data-testid="panel-tab-cards"]');
  await page.waitForSelector('[data-testid="swipe-deck"]', { timeout: WAIT_MS });
  const deck = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="swipe-deck"]');
    const r = el?.getBoundingClientRect();
    const panel = document.querySelector('[data-testid="panel-cards"]');
    return {
      visible: !!r && r.width > 0 && r.height > 0,
      h: r ? Math.round(r.height) : null,
      inPanel: !!(el && panel && panel.contains(el)),
    };
  });
  const file = join(OUT, 'skel-ext-2-panels-content.png');
  await page.screenshot({ path: file });
  await context.close();

  const emptyKeys = ['subsEmpty', 'cardsEmpty', 'dmEmpty', 'commentsEmpty'];
  const flashed = emptyKeys.filter((k) => watch.firstSeen[k] !== undefined);
  console.log('\n[Q] 面板（有数据）冷启动：');
  console.log(`    firstSeen ${JSON.stringify(watch.firstSeen)}`);
  console.log(`    讨论计数条文案：${JSON.stringify(commentMeta.trim())}`);
  console.log(`    卡片滑动卡：${JSON.stringify(deck)}`);
  console.log(`    页面错误 ${errors.length ? JSON.stringify(errors) : '无'}`);
  console.log(`    → ${file}`);
  check(watch.firstSeen['subsRow'] !== undefined, 'Q 字幕条目已渲染（造的数据读到了）');
  check(watch.firstSeen['cmtThread'] !== undefined, 'Q 讨论条目已渲染（展开后）');
  check(flashed.length === 0, 'Q 四个面板的空态一次都没出现（未加载 ≠ 确认为空）', `闪现=${JSON.stringify(flashed)}`);
  check(watch.firstSeen['panelSkeleton'] === undefined, 'Q 快速路径不出骨架（延迟门控生效）');
  check(commentMeta.includes('条讨论'), 'Q 讨论计数条报的是真实条数，不是「还没有讨论」');
  check(deck.visible && deck.inPanel && deck.h === 300, 'Q 卡片面板切过去后滑动卡布局完好（SkeletonReveal 没破坏高度链）', JSON.stringify(deck));
  check(errors.length === 0, 'Q 页面无 JS 报错', errors.join(' | '));
}

// ── R. 材料正文骨架 ──────────────────────────────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await bootAndSeed(page);
  await seedMaterialFile(
    page,
    MATERIAL_ID,
    [
      '# 探针材料',
      '',
      '这一段用来确认材料正文骨架有结束条件：文件到点之后，阅读器必须真的渲染出来。',
      '',
      '## 第二节',
      '',
      '正文内容。',
      '',
      '## 第三节',
      '',
      '正文内容。',
    ].join('\n'),
  );
  await page.addInitScript({ content: DELAY_MATERIAL_READ });
  await page.goto('about:blank');
  await page.goto(`${BASE}/#/player/${MATERIAL_ID}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="doc-skeleton"]', { timeout: WAIT_MS });
  const variant = await page.evaluate(() => ({
    column: !!document.querySelector('.doc-skel--column'),
    page: !!document.querySelector('.doc-skel--page'),
    reader: !!document.querySelector('[data-testid="material-reader"]'),
  }));
  const file = join(OUT, 'skel-ext-3-material.png');
  await page.screenshot({ path: file });
  // 延迟结束后必须落到真内容（否则就是一个「永久骨架」，违反 I5）
  await page.waitForSelector('[data-testid="material-reader"]', { timeout: WAIT_MS });
  await page.waitForSelector('.mr-md__block', { timeout: WAIT_MS });
  const after = await page.evaluate(() => !!document.querySelector('[data-testid="doc-skeleton"]'));
  await context.close();

  console.log('\n[R] 材料正文骨架：');
  console.log(`    变体 column=${variant.column} page=${variant.page} 骨架期阅读器已在=${variant.reader}`);
  console.log(`    → ${file}`);
  check(variant.column && !variant.page, 'R Markdown 用正文列变体（不是白页卡片）');
  check(!variant.reader, 'R 骨架期没有真内容（加载态确实在台上）');
  check(after === false, 'R 文件到点后骨架收走、真内容就位（有结束条件，不变量 I5）');
}

// ── R2. 白页变体（Word / PDF）──────────────────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await bootAndSeed(page);
  // 内容无关紧要：这里量的是「加载中」那一屏，文件到点前不会去解析它
  await seedMaterialFile(page, MATERIAL_PDF_ID, '%PDF-1.4\n% probe\n');
  await page.addInitScript({ content: DELAY_MATERIAL_READ });
  await page.goto('about:blank');
  await page.goto(`${BASE}/#/player/${MATERIAL_PDF_ID}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="doc-skeleton"]', { timeout: WAIT_MS });
  const variant = await page.evaluate(() => {
    const body = document.querySelector('.doc-skel__body');
    return {
      page: !!document.querySelector('.doc-skel--page'),
      column: !!document.querySelector('.doc-skel--column'),
      paper: body ? getComputedStyle(body).backgroundColor : null,
      bar: getComputedStyle(document.querySelector('.doc-skel__body .skel-bar')).backgroundColor,
    };
  });
  const file = join(OUT, 'skel-ext-4-material-pdf.png');
  await page.screenshot({ path: file });
  await context.close();

  console.log('\n[R2] 材料白页骨架（PDF/Word）：');
  console.log(`    变体 page=${variant.page} column=${variant.column} · 纸底 ${variant.paper} · 灰条 ${variant.bar}`);
  console.log(`    → ${file}`);
  check(variant.page && !variant.column, 'R2 PDF/Word 用白页卡片变体（与 docx 真页同形）');
  check(variant.paper === 'rgb(255, 255, 255)', 'R2 白页恒为白（深浅色下都是白纸黑字）', String(variant.paper));
  check(
    variant.bar !== variant.paper,
    'R2 白纸上的灰条读得出来（没用深色令牌反成黑杠）',
    `bar=${variant.bar}`,
  );
}

await browser.close();
console.log(`\n截图写入 ${OUT}`);

if (failures.length) {
  console.error(`\n${failures.length} 项断言未通过：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\n全部断言通过。');
