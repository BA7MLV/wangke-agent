/* eslint-disable no-console */
// E2E：讲义记住上一次的阅读位置（**不需要 API key**）。
//
// 做法：直接**播种一份讲义行**（outlineJson + sectionsJson），打开播放页的「讲义」面板 ——
// 不生成字幕、不调模型，所以这条链路与 key 无关，也能单独跑。
//
// 覆盖点：
//   1. 往下滚 → 位置写回 handouts.readPos（锚点 + 偏移）
//   2. 刷新重开 → 落回同一个锚点（而不是"附近的某一段"）
//   3. 改动过的讲义里锚点已消失 → 安静地回顶部，不乱跳
//   4. 材料自己那套 lastUnit 断点续读不受影响（回归哨兵：顺手看一眼指示器仍在）
//
// 用法：npm run preview &  然后 node scripts/e2e-handout-position.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';

let failed = 0;
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.error(`❌ ${m}`);
  failed++;
};
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(`${name}\n   ${e.message}`);
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => fail(`页面异常：${e.message}`));

const dbHelper = (fn, arg) =>
  page.evaluate(
    async ([body, payload]) => {
      const run = new Function(`return (${body})`)();
      const req = indexedDB.open('wangke');
      const idb = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const out = await run(idb, payload);
      idb.close();
      return out;
    },
    [fn.toString(), arg ?? null],
  );

/** 讲义正文：3 节 × 8 段，每段两行，够长到需要滚动 */
function handoutSections(paragraphsPerSection) {
  return Array.from({ length: 3 }, (_, s) => ({
    heading: `第 ${s + 1} 节 标题`,
    blocks: Array.from({ length: paragraphsPerSection }, (_, i) => ({
      type: 'para',
      text: `第 ${s + 1} 节第 ${i + 1} 段。` + '这是一段用于把讲义撑到需要滚动的正文内容。'.repeat(4),
    })),
  }));
}

const seed = (videoId, sectionsJson) =>
  dbHelper(async (idb, { videoId, sectionsJson }) => {
    await new Promise((res, rej) => {
      const tx = idb.transaction(['videos', 'handouts'], 'readwrite');
      tx.objectStore('videos').put({
        id: videoId,
        name: '讲义位置测试课',
        size: 1,
        mimeType: 'video/mp4',
        duration: 60,
        createdAt: Date.now(),
        status: 'transcribed',
        fileDeleted: 1,
      });
      tx.objectStore('handouts').put({
        id: 9001,
        videoId,
        createdAt: Date.now(),
        title: '讲义位置测试',
        blob: new Blob(['x']),
        outlineJson: JSON.stringify({ summary: '课程概述。' }),
        sectionsJson,
      });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return true;
  }, { videoId, sectionsJson });

const readPos = () =>
  dbHelper(async (idb) => {
    const tx = idb.transaction('handouts', 'readonly');
    const row = await new Promise((res, rej) => {
      const q = tx.objectStore('handouts').get(9001);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    return row?.readPos ?? null;
  });

/** 当前视口顶部之上最后一个锚点（与产品的取法一致，方便对照断言） */
const topAnchor = () =>
  page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="handout-doc"]');
    if (!scroll) return null;
    const top = scroll.getBoundingClientRect().top;
    const anchors = [...scroll.querySelectorAll('[data-hd-anchor]')];
    let chosen = anchors[0];
    for (const el of anchors) {
      if (el.getBoundingClientRect().top - top <= 0) chosen = el;
      else break;
    }
    return {
      anchor: chosen?.getAttribute('data-hd-anchor') ?? null,
      offset: Math.round(top - (chosen?.getBoundingClientRect().top ?? top)),
      scrollTop: Math.round(scroll.scrollTop),
      scrollable: scroll.scrollHeight - scroll.clientHeight,
    };
  });

const openHandout = async () => {
  // 必须显式 reload：连续两次 goto 同一个 `#/player/...` 是同文档导航，**不会**重新挂载页面，
  // 于是「重开」这条用例其实还在看上一个页面 —— 位置断言会假通过。
  await page.goto(`${BASE}/#/player/handout-pos`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-testid="panel-tab-handout"]').click();
  await page.locator('[data-testid="handout-doc"] [data-hd-anchor]').first().waitFor({ timeout: 20000 });
  // 布局与字体稳定后再读位置
  await page.waitForTimeout(900);
};

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await seed('handout-pos', JSON.stringify(handoutSections(8)));

console.log('—— 1. 首次打开在顶部 ——');
await check('讲义可滚，且开在顶部', async () => {
  await openHandout();
  const before = await topAnchor();
  assert.ok(before, '应读到讲义容器');
  assert.ok(before.scrollable > 200, `讲义应明显超过一屏（可滚 ${before.scrollable}px）`);
  assert.ok(before.scrollTop < 20, `首次打开应在顶部，实际 scrollTop=${before.scrollTop}`);
});

console.log('—— 2. 往下滚 → 位置写回 ——');
/** 记住这次滚到的地方，第 3 条要拿它当基准 */
let want = null;
await check('滚动后 readPos 落库（锚点 + 偏移）', async () => {
  await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="handout-doc"]');
    scroll.scrollTop = Math.round((scroll.scrollHeight - scroll.clientHeight) * 0.62);
  });
  want = await topAnchor();
  assert.ok(want.scrollTop > 200, `应已滚下去（scrollTop=${want.scrollTop}）`);
  // 写入是节流的（rAF + 400ms 窗口），等它落库
  const saved = await (async () => {
    const end = Date.now() + 5000;
    for (;;) {
      const row = await readPos();
      if (row && row.anchor === want.anchor) return row;
      if (Date.now() > end) return row;
      await page.waitForTimeout(150);
    }
  })();
  assert.ok(saved, 'handouts.readPos 应被写回');
  assert.equal(saved.anchor, want.anchor, `锚点应一致（期望 ${want.anchor}）`);
  assert.equal(saved.offset, want.offset, `偏移应一致（期望 ${want.offset}，实际 ${saved.offset}）`);
});

console.log('—— 3. 刷新重开 → 落回同一处 ——');
await check('重开后回到同一个锚点（不是附近的某一段）', async () => {
  await openHandout();
  const after = await topAnchor();
  assert.ok(after.scrollTop > 200, `重开应落回原处，实际 scrollTop=${after.scrollTop}`);
  assert.equal(after.anchor, want.anchor, `锚点应一致（期望 ${want.anchor}@${want.offset}，实际 ${after.anchor}@${after.offset}）`);
  assert.ok(
    Math.abs(after.offset - want.offset) <= 24,
    `块内偏移应基本一致（期望 ${want.offset}，实际 ${after.offset}）`,
  );
});

console.log('—— 4. 锚点已消失（讲义被改短）→ 安静回顶部 ——');
await check('锚点找不到时回顶部而不是乱跳', async () => {
  await seed('handout-pos', JSON.stringify(handoutSections(2)));
  await openHandout();
  const after = await topAnchor();
  assert.ok(after.scrollTop < 20, `锚点失效应回顶部，实际 scrollTop=${after.scrollTop}`);
  assert.ok(after.scrollable >= 0);
});

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
