/* eslint-disable no-console */
// E2E：阅读材料（PDF）链路 —— 导入 → 解析 → 阅读器 → 划词/框选提问（无需 API key）。
//
// 走**真实导入路径**（setInputFiles 打到库页的文件输入），不播种 OPFS：
// 这样 isImportable / saveMaterialFile / videos.put / startMaterialJob 整条链路一起被覆盖，
// 播种文件会绕过其中一半，也就测不出「导入就报错」这类最要命的问题。
//
// 用法：npm run preview &  然后 node scripts/e2e-materials.mjs
//
// 覆盖点（对应设计文档 §8 的契约表）：
//   1. 中文 PDF 导入后能解析出页数与文本块（未内嵌字体，走 /pdfjs/cmaps/）
//   2. 文本层真的渲染出中文 —— **这条是 cmaps 链路的验证**，失败说明 vite 的
//      pdfjsAssets 插件没把 cmaps 供出来（症状：PDF 画面空白、划不了词）
//   3. 页码导航 / 跳页 / 缩放 / 书签目录
//   4. 划词 → 浮层（带「第 N 页」）→ 引用条
//   5. 框选 → 浮层 → 引用条（带裁图）
//   6. 回答里的 [第2页] 引用可点击跳页（顺带验证材料模式不跑 linkifyTimestamps）
//   7. Word：导入解析 → docx-preview 渲染 → 段落定位不变式 → 划词 → [第5段] 跳段
//   8. 无文本层（扫描件 PDF）→ 明确提示且不建索引
//   9. 有图片但一个字都抽不出来（Word）→ 判为「无正文」，**不能**说成「扫描件」
//  10. HTML 原样视图：文档自带样式生效、脚本不执行、沙箱只有 allow-same-origin、
//      相对路径不打到应用自身、远程图片按开关加载、划词浮层落在 iframe 内、[第3段] 跳转
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const FIX_ZH = path.resolve('scripts/fixtures/sample-zh.pdf');
const FIX_DOCX = path.resolve('scripts/fixtures/sample.docx');
const FIX_SCANNED = path.resolve('scripts/fixtures/sample-scanned.pdf');
const FIX_EMPTY_DOCX = path.resolve('scripts/fixtures/sample-empty.docx');
const FIX_HTML = path.resolve('scripts/fixtures/sample.html');
/** 与 `sample.html` 同结构，但**内容高于容器** —— 见「切视图落位（可滚动）」那条检查 */
const FIX_HTML_LONG = path.resolve('scripts/fixtures/sample-long.html');

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
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`   [console.error] ${m.text().slice(0, 200)}`);
});

// ── HTML 原样视图的两条外部条件 ──────────────────────────────────────────────
//
// 1. 远程图片就地应答（1×1 GIF），否则断言会依赖真实 DNS，且「有没有加载成功」无从判断；
// 2. 记下全部请求，用来钉住不变量「渲染期不得请求应用自身的源」——
//    这条只有在这一层能验：它是「运行时会发什么请求」的性质，不是纯函数。
//    注意 Playwright 只报**真的发出去**的请求，被 CSP 拦掉的根本不会出现在这里。
const REMOTE_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
await page.route('https://cdn.mr.test/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/gif', body: REMOTE_PIXEL }),
);
const requests = [];
page.on('request', (r) => requests.push(r.url()));

/**
 * 导入一个文件并等它出现在库列表里；返回库行的 data-video-id。
 *
 * ⚠️ **不能按文件名匹配**：`:has-text("sample")` 会同时命中 `sample.docx`（名字 "sample"）
 * 与 `sample-zh.pdf`（"sample" 是 "sample-zh" 的子串），于是这个函数可能立刻在**上一张**
 * 卡片上返回，把 PDF 的 id 当成 docx 的 id —— 后续所有断言都会以一种「看起来像功能坏了」
 * 的方式失败（实测：Word 一节 6 条全红，而真实原因是拿错了行）。
 *
 * 正确做法是记住导入前的 id 集合，等**新增的那一行**出现。与文件名、排序、文案都无关。
 */
async function importFile(filePath) {
  const before = await page.$$eval('[data-testid="video-item"]', (els) =>
    els.map((el) => el.dataset.videoId),
  );
  await page.setInputFiles('input[type="file"]', filePath);
  const handle = await page.waitForFunction(
    (known) => {
      const fresh = [...document.querySelectorAll('[data-testid="video-item"]')].find(
        (el) => !known.includes(el.dataset.videoId),
      );
      return fresh ? fresh.dataset.videoId : false;
    },
    before,
    { timeout: 30000 },
  );
  return await handle.jsonValue();
}

/**
 * 选中某一页的文本层片段（真实拖选难做稳，用 Selection API 等价触发 selectionchange）。
 *
 * 必须**等目标页自己的** span 出现，而不是等「页面上任意一处有 span」：
 * 视口窗口化渲染下，滚动到第 1 页时第 2 页的文本层可能还在，等到别的页就等于没等。
 */
async function selectPageText(pageIndex, spanCount = 6) {
  const host = page.locator('.mr-page').nth(pageIndex);
  await host.locator('.textLayer span').first().waitFor({ timeout: 20000 });
  return await host.evaluate((h, n) => {
    const spans = [...h.querySelectorAll('.textLayer span')];
    if (spans.length === 0) return '文本层还没渲染出来';
    const range = document.createRange();
    range.setStartBefore(spans[0]);
    range.setEndAfter(spans[Math.min(n, spans.length) - 1]);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return 'ok';
  }, spanCount);
}

/**
 * 播一条「助手回答」历史消息。
 *
 * 用于验证回答里的页码/段号引用可点击跳转 —— 这件事**不需要 API key**，
 * 播种一条历史消息就够了（顺带覆盖「历史消息也要走 linkify」这条路径）。
 */
async function seedChat(materialId, content) {
  await page.evaluate(
    async ({ materialId, content }) => {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open('wangke');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const tx = db.transaction(['chatSessions', 'chats'], 'readwrite');
      const sid = await new Promise((res, rej) => {
        const req = tx.objectStore('chatSessions').add({
          videoId: materialId,
          title: '引用跳转',
          createdAt: Date.now() + 1000,
        });
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      tx.objectStore('chats').add({
        videoId: materialId,
        sessionId: sid,
        role: 'assistant',
        content,
        createdAt: Date.now() + 1000,
      });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
    { materialId, content },
  );
}

/**
 * 播种阅读位置（视图 + 段号）。与 `seedChat` 同一惯例：只种**状态**，不种文件。
 *
 * 为什么这里需要它，而不是「滚一下容器」：分段视图的当前段号来自 `IntersectionObserver`，
 * 而它的**首批回调被显式丢弃**（进入视图不是用户动作，见 `HtmlReader` 里那段注释）。
 * 若我们的滚动恰好赶在那批之前，它会被当成「这个视图的初始状态」一起丢掉，
 * 之后没有任何变化，IO 不会再报 —— 指示器永远不动，检查偶发变红。
 * 播种 + 打开走的是产品自己的断点续读路径，确定性。
 */
async function seedReadingPos(videoId, { htmlView, lastUnit }) {
  await page.evaluate(
    async ({ videoId, htmlView, lastUnit }) => {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open('wangke');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const tx = db.transaction('videos', 'readwrite');
      const store = tx.objectStore('videos');
      const row = await new Promise((res, rej) => {
        const req = store.get(videoId);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      store.put({ ...row, htmlView, lastUnit });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    { videoId, htmlView, lastUnit },
  );
}

/**
 * 轮询直到 `ok(state)` 成立或超时，返回**最后一次**的结果。
 *
 * 与 `waitForFunction` 的分工：这里把判定权留给调用方 —— 超时也返回实况，
 * 于是 assert 的失败消息里带着真实数值（「scrollTop=0」比「Timeout 3000ms exceeded」可查得多）。
 * 用途是等「某个 effect 跑完」，不是等「断言成立」：断言仍在下面显式写出来。
 */
async function until(fn, ok, { timeout = 3000, step = 60 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (ok(last) || Date.now() > end) return last;
    await page.waitForTimeout(step);
  }
}

console.log('—— 1. 导入中文 PDF（真实导入路径）——');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
const zhId = await importFile(FIX_ZH);
await check('导入后在库列表出现', async () => assert.ok(zhId, '没拿到 material id'));

await check('库列表标记为已解析且页数正确（3 页）', async () => {
  await page.waitForSelector(`[data-video-id="${zhId}"]:has-text("已解析 3 页")`, { timeout: 40000 });
});

// 播一条历史会话，用于验证「回答里的 [第N页] 可点击跳页」（不需要 API key）。
// 消息里刻意混入 [03:25]：材料模式下前者该变链接、后者必须保持纯文本（见第 6 节断言）。
await seedChat(zhId, '矩阵的秩的定义见 [第2页]，可逆矩阵讲在第 3 页。另外 [03:25] 是视频里才有的时间戳。');

console.log('\n—— 2. 阅读器渲染 ——');
await page.click(`[data-video-id="${zhId}"] [data-testid="btn-play"]`);
await page.waitForSelector('[data-testid="material-reader"]', { timeout: 20000 });

await check('阅读器出现且页码指示为 1 / 3', async () => {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() === '1 / 3',
    { timeout: 20000 },
  );
});

await check('文本层渲染出中文（= /pdfjs/cmaps 链路可用）', async () => {
  await page.waitForSelector('.mr-page .textLayer span', { timeout: 30000 });
  const text = await page.evaluate(() =>
    [...document.querySelectorAll('.mr-page')][0]
      .querySelectorAll('.textLayer span')
      .length
      ? [...document.querySelectorAll('.mr-page')][0].textContent.replace(/\s/g, '')
      : '',
  );
  assert.ok(text.includes('线性代数讲义'), `第 1 页文本层里没有「线性代数讲义」，实际：${text.slice(0, 80)}`);
});

await check('canvas 与文本层尺寸一致（错位就会选到错的位置）', async () => {
  const r = await page.evaluate(() => {
    const p = document.querySelector('.mr-page');
    const c = p.querySelector('canvas');
    const t = p.querySelector('.textLayer');
    const cr = c.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    return { dw: Math.abs(cr.width - tr.width), dh: Math.abs(cr.height - tr.height) };
  });
  assert.ok(r.dw < 2 && r.dh < 2, `canvas 与文本层差 ${r.dw}x${r.dh}px`);
});

console.log('\n—— 3. 导航 / 缩放 / 目录 ——');
await check('缩放：点两次缩小到 80%', async () => {
  await page.click('[data-testid="reader-zoom-out"]');
  await page.click('[data-testid="reader-zoom-out"]');
  await page.waitForFunction(() => document.body.textContent.includes('80%'), { timeout: 5000 });
  await page.click('[data-testid="reader-zoom-in"]');
  await page.click('[data-testid="reader-zoom-in"]');
});

await check('下一页 → 2 / 3', async () => {
  await page.click('[data-testid="reader-next"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() === '2 / 3',
    { timeout: 10000 },
  );
});

await check('跳页输入 1 + 回车 → 1 / 3', async () => {
  // 不能对 mdui-text-field 用 page.fill：真实输入框在 shadow DOM 里，
  // fill 会把值写到宿主元素上、既不触发 input 也不走组件状态。点击 + 键盘输入才是真实路径。
  await page.click('[data-testid="reader-jump"]');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() === '1 / 3',
    { timeout: 10000 },
  );
});

await check('书签目录可点，点「第二章」跳到第 2 页', async () => {
  await page.click('[data-testid="reader-outline"]');
  const item = page.locator('mdui-menu-item', { hasText: '第二章 矩阵的秩' });
  await item.waitFor({ timeout: 8000 });
  await item.click(); // 点目录项同时关掉下拉，省掉「按 Esc 收菜单」的不确定性
  await page.waitForFunction(
    () => document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() === '2 / 3',
    { timeout: 10000 },
  );
});

/** 把阅读器翻回第 1 页（前面的用例可能把它带到别处，不假设具体在第几页） */
async function gotoFirstPage() {
  for (let i = 0; i < 5; i++) {
    const cur = await page.textContent('[data-testid="reader-page-indicator"]');
    if (cur.trim().startsWith('1 /')) return;
    await page.click('[data-testid="reader-prev"]');
    await page.waitForTimeout(150);
  }
  throw new Error('没能回到第 1 页');
}

console.log('\n—— 4. 划词提问 ——');
await gotoFirstPage();
await page.waitForSelector('.mr-page .textLayer span', { timeout: 20000 });

await check('拖选文字后浮层出现，且位置标为「第 1 页」', async () => {
  const r = await selectPageText(0);
  assert.equal(r, 'ok', r);
  await page.waitForSelector('[data-testid="ask-float"]', { timeout: 5000 });
  const where = await page.textContent('.ask-float__where');
  assert.equal(where.trim(), '第 1 页');
});

await check('点「就这段提问」→ 引用条出现且带页标', async () => {
  await page.click('[data-testid="ask-compose"]');
  await page.waitForSelector('[data-testid="chat-ref-chip"]', { timeout: 5000 });
  const chip = await page.textContent('[data-testid="chat-ref-chip"]');
  assert.ok(chip.includes('第 1 页'), `引用条内容：${chip}`);
  const gone = await page.$('[data-testid="ask-float"]');
  assert.equal(gone, null, '浮层应当在选完之后收起');
});

await check('引用条可单条删除', async () => {
  await page.click('[data-testid="ref-chip-remove"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-ref-chip"]'), { timeout: 5000 });
});

/**
 * 回归：一次 `scroll` 曾经把浮层永久吃掉。
 *
 * 原实现是 `onScroll = () => { setHit(null); hideBar(); }`，而浮层只在 `selectionchange`
 * 时重算 —— 滚动之后不会再有该事件（选区没变），于是浮层再也不回来。
 * 触摸端表现为「只有第一页能划词」：容器在顶部时无处可滚，压根不产生 scroll 事件。
 * 上面那两条用例测不出来 —— 它们只划第 1 页，而且 Selection API 本身不产生滚动。
 * 详见 docs/plans/2026-09-18-selection-ask-scroll-design.md
 */
await check('滚动到第 2 页后仍能划词（非首屏页的划词入口）', async () => {
  await page.click('[data-testid="reader-next"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() === '2 / 3',
    { timeout: 10000 },
  );
  // goto() 用的是 smooth 滚动，等它落定再建选区，否则量到的锚点还在动
  await page.waitForTimeout(600);
  const r = await selectPageText(1);
  assert.equal(r, 'ok', r);
  await page.waitForSelector('[data-testid="ask-float"]', { timeout: 5000 });
  const where = await page.textContent('.ask-float__where');
  assert.equal(where.trim(), '第 2 页');
});

await check('划词后滚动：浮层跟随重算，而不是被永久吃掉', async () => {
  const before = await page.locator('[data-testid="ask-float"]').boundingBox();
  await page.evaluate(() => {
    document.querySelector('.mr-scroll').scrollTop += 40;
  });
  await page.waitForTimeout(600); // 滚动停止(120ms 防抖) + 一次重算
  const after = await page.locator('[data-testid="ask-float"]').boundingBox();
  assert.ok(after, '滚动后浮层不应永久消失');
  // 只断言「还在」会在旧实现下漏报（旧实现里它已经消失），所以再断言位置确实跟着滚动变了 ——
  // 位置变化才能证明「重算过」，而不只是「碰巧没被收起」
  assert.ok(
    Math.abs(after.y - before.y) > 20,
    `浮层位置应跟着滚动重算：${Math.round(before.y)} → ${Math.round(after.y)}`,
  );
});

// 复位到第 1 页：第 5 节的框选用例假设从第 1 页开始
await gotoFirstPage();

console.log('\n—— 5. 框选提问 ——');

/**
 * 在第 1 页上拖出一个矩形。
 *
 * 两个必须处理的地方：
 * 1. `goto()` 用的是 smooth 滚动，**立刻量 boundingBox 会拿到动画中间的位置**，
 *    拖拽起点可能落到页面外（表现为「框选没反应」，且时灵时不灵）。
 *    这里先等两次测量结果一致，再把拖拽范围夹到「页面的可视部分」内。
 * 2. 拖拽必须完全落在视口内，否则 mouse 事件会被丢掉。
 */
async function dragOnFirstPage() {
  const loc = page.locator('.mr-page').first();
  let prev = null;
  for (let i = 0; i < 25; i++) {
    const b = await loc.boundingBox();
    if (prev && Math.abs(b.y - prev.y) < 0.5) break;
    prev = b;
    await page.waitForTimeout(120);
  }
  const b = await loc.boundingBox();
  const vh = page.viewportSize().height;
  const top = Math.max(b.y, 0) + 50;
  const bottom = Math.min(b.y + b.height, vh) - 50;
  const x0 = b.x + 60;
  const x1 = Math.min(b.x + b.width - 60, x0 + 300);
  const y0 = top;
  const y1 = Math.min(top + 170, bottom);
  if (y1 - y0 < 30 || x1 - x0 < 30) throw new Error(`可拖拽区域太小：${x1 - x0}x${y1 - y0}`);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  await page.mouse.up();
}

await check('框选一块区域 → 浮层带裁图 → 引用条出现缩略图', async () => {
  await page.click('[data-testid="reader-tool-areaselect"]');
  await page.waitForSelector('[data-testid="reader-area-hint"]', { timeout: 5000 });
  await dragOnFirstPage();

  await page.waitForSelector('[data-testid="ask-float"]', { timeout: 8000 });
  await page.click('[data-testid="ask-compose"]');
  await page.waitForSelector('[data-testid="chat-ref-chip"] img.chat-ref__img', { timeout: 8000 });
  // 框完自动退出框选态（否则用户会以为「选不了字了」）
  await page.waitForFunction(() => !document.querySelector('[data-testid="reader-area-hint"]'), {
    timeout: 5000,
  });
});

await check('框选态下文本层让位（否则拖不出框）', async () => {
  // 不假设上一步留下了什么状态：需要就先进入框选态
  if (!(await page.$('[data-testid="reader-area-hint"]'))) {
    await page.click('[data-testid="reader-tool-areaselect"]');
    await page.waitForSelector('[data-testid="reader-area-hint"]', { timeout: 5000 });
  }
  const pe = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.mr-page .textLayer')).pointerEvents,
  );
  assert.equal(pe, 'none', '框选态下文本层必须让出指针事件');
  // 收尾：退出框选态，避免影响后面的用例
  await page.click('[data-testid="reader-tool-areaselect"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="reader-area-hint"]'), {
    timeout: 5000,
  });
});

await check('框选浮层滚动后收起，不会「变身」成划词浮层', async () => {
  // 先留一个**残留选区**：划完词不点浮层按钮（直接去点框选是真实路径），选区就还在。
  // 它是这条用例的关键 —— 没有它，滚动后的重算本来就返回 null，根本测不出这个守卫。
  const r = await selectPageText(0);
  assert.equal(r, 'ok', r);
  await page.waitForTimeout(300);

  await page.click('[data-testid="reader-tool-areaselect"]');
  await page.waitForSelector('[data-testid="reader-area-hint"]', { timeout: 5000 });
  await dragOnFirstPage();
  await page.waitForSelector('[data-testid="ask-float"]', { timeout: 8000 });

  await page.evaluate(() => {
    document.querySelector('.mr-scroll').scrollTop += 40;
  });
  await page.waitForTimeout(600); // 滚动停止(120ms 防抖) + 一次重算
  const f = await page.$('[data-testid="ask-float"]');
  assert.equal(f, null, '框选浮层滚动后应收起，而不是把残留选区重新弹出来');
});

console.log('\n—— 6. 回答里的页码引用可跳页 ——');
await check('点了 [第2页] 之后阅读器跳到第 2 页', async () => {
  const link = page.locator('[data-testid="chat-msg-ai"] a', { hasText: '第2页' }).first();
  await link.waitFor({ timeout: 10000 });
  await link.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() === '2 / 3',
    { timeout: 10000 },
  );
});

await check('材料模式不把 [mm:ss] 渲染成链接（点了没反应的死链）', async () => {
  // 种入的回答里同时有 [第2页] 与 [03:25]：前者该成为链接，后者必须保持纯文本
  const tsLink = await page.locator('[data-testid="chat-msg-ai"] a', { hasText: '[03:25]' }).count();
  assert.equal(tsLink, 0, '[03:25] 不该被渲染成链接');
  const unitLink = await page.locator('[data-testid="chat-msg-ai"] a', { hasText: '[第2页]' }).count();
  assert.equal(unitLink, 1, '[第2页] 应该是可点击链接');
});

console.log('\n—— 7. Word（.docx）阅读与划词 ——');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
const docxId = await importFile(FIX_DOCX);

await check('Word 解析出 10 段', async () => {
  await page.waitForSelector(`[data-video-id="${docxId}"]:has-text("已解析 10 段")`, { timeout: 40000 });
});

// 播种一条含段落引用的历史会话，用于验证 Word 的引用跳转
await seedChat(docxId, '矩阵的秩的定义见 [第5段]。');

await page.click(`[data-video-id="${docxId}"] [data-testid="btn-play"]`);
await page.waitForSelector('[data-testid="material-reader"]', { timeout: 20000 });

await check('docx-preview 渲染出正文', async () => {
  await page.waitForFunction(
    () => (document.querySelector('.mr-docx')?.textContent ?? '').includes('矩阵的秩'),
    { timeout: 30000 },
  );
});

/**
 * 段落定位不变式：**DOM 里带 data-unit 的块数 === 数据侧去重后的 unit 数**。
 *
 * 这条是 Word 引用能跳对地方的全部依据（两边靠「跳过空块、按文档顺序编号」的同一套规则对齐）。
 * 一旦 Word 模板引入新结构（比如 docx-preview 多渲染出包装元素），这条会先炸，
 * 而不是让「点 [第5段] 跳到第 6 段」这种问题悄悄上线。
 */
await check('DOM 段落块数 === 数据侧 unit 数（引用定位不变式）', async () => {
  const n = await page.evaluate(() => document.querySelectorAll('.mr-docx [data-unit]').length);
  assert.equal(n, 10, `DOM 里有 ${n} 个 data-unit，期望 10`);
});

await check('Word 划词 → 浮层标出「第二章 矩阵的秩 第 5 段」', async () => {
  const r = await page.evaluate(() => {
    const el = document.querySelector('[data-unit="5"]');
    if (!el) return '找不到第 5 段';
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return 'ok';
  });
  assert.equal(r, 'ok', r);
  await page.waitForSelector('[data-testid="ask-float"]', { timeout: 5000 });
  const where = (await page.textContent('.ask-float__where')).trim();
  assert.equal(where, '第二章 矩阵的秩 第 5 段');
});

await check('Word 划词 → 引用条带段标', async () => {
  await page.click('[data-testid="ask-compose"]');
  await page.waitForSelector('[data-testid="chat-ref-chip"]', { timeout: 5000 });
  const chip = await page.textContent('[data-testid="chat-ref-chip"]');
  assert.ok(chip.includes('第 5 段'), `引用条内容：${chip}`);
  await page.click('[data-testid="ref-chip-remove"]');
});

await check('点 [第5段] 引用 → Word 阅读器滚动到第 5 段', async () => {
  const link = page.locator('[data-testid="chat-msg-ai"] a', { hasText: '第5段' }).first();
  await link.waitFor({ timeout: 10000 });
  await link.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() === '第 5 / 10 段',
    { timeout: 10000 },
  );
});

console.log('\n—— 8. 扫描件（无文本层）——');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
const scanId = await importFile(FIX_SCANNED);

await check('扫描件标记为「不可检索」', async () => {
  await page.waitForSelector(`[data-video-id="${scanId}"]:has-text("扫描件")`, { timeout: 40000 });
});

await check('打开后有「只能划词/框选提问」的明确提示', async () => {
  await page.click(`[data-video-id="${scanId}"] [data-testid="btn-play"]`);
  await page.waitForSelector('[data-testid="material-scan-hint"]', { timeout: 20000 });
  const text = await page.textContent('[data-testid="material-scan-hint"]');
  assert.ok(text.includes('无法参与问答检索'), `提示文案：${text}`);
});

await check('扫描件仍然渲染出页面（能看、能框选）', async () => {
  await page.waitForSelector('.mr-page canvas', { timeout: 20000 });
  const n = await page.evaluate(() => document.querySelectorAll('.mr-page').length);
  assert.equal(n, 2, `扫描件应有 2 页，实际 ${n}`);
});

await check('问答面板说明「为什么不能提问」（不然用户只看到输入框是灰的）', async () => {
  await page.waitForSelector('[data-testid="chat-index-note"]', { timeout: 15000 });
  const text = await page.textContent('[data-testid="chat-index-note"]');
  assert.ok(text.includes('无法参与检索'), `提示文案：${text}`);
});

/**
 * 9. 有内容但抽不出一个字（Word 里全是图片）。
 *
 * 这条是「扫描件」判定的**反向锁**：`scanned` 只对 PDF 成立，
 * Word 抽不到字是「没有正文」。两者都会跳过建索引，但给用户看的话必须不一样 ——
 * 曾经把 PDF 的「页均 50 字」套到 Word 上，短段落 Word 被整体误判成扫描件，
 * 于是这里要同时钉住两件事：① 判成「无正文」；② **不许**出现「扫描件」字样。
 */
console.log('\n—— 9. 只有图片的 Word（无正文）——');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
const emptyId = await importFile(FIX_EMPTY_DOCX);

await check('库列表标记为「无正文·不可检索」', async () => {
  await page.waitForSelector(`[data-video-id="${emptyId}"]:has-text("无正文")`, { timeout: 40000 });
  const text = await page.textContent(`[data-video-id="${emptyId}"]`);
  assert.ok(!text.includes('扫描件'), `Word 不该被说成扫描件：${text}`);
});

await check('打开后提示「没有正文」（不是「没有文本层」）', async () => {
  await page.click(`[data-video-id="${emptyId}"] [data-testid="btn-play"]`);
  await page.waitForSelector('[data-testid="material-empty-hint"]', { timeout: 20000 });
  const text = await page.textContent('[data-testid="material-empty-hint"]');
  assert.ok(text.includes('没有正文'), `提示文案：${text}`);
  assert.ok(!text.includes('扫描件'), `提示文案不该提扫描件：${text}`);
});

await check('问答面板也按「没有正文」解释（与扫描件话术分开）', async () => {
  await page.waitForSelector('[data-testid="chat-index-note"]', { timeout: 15000 });
  const text = await page.textContent('[data-testid="chat-index-note"]');
  assert.ok(text.includes('没有正文'), `提示文案：${text}`);
  assert.ok(!text.includes('扫描件'), `提示文案不该提扫描件：${text}`);
});

/**
 * 10. HTML 原样视图。
 *
 * 这一节钉的是「保真」与「保真的代价」两件事。前者的判别依据是**文档自己的样式真的生效**
 * （分段视图走白名单净化，`class` 会被剥掉，同一条声明必然不生效 —— 两个视图因此有区分度）；
 * 后者是三条容易被悄悄放松的边界：沙箱只有 `allow-same-origin`、脚本不执行、
 * 相对路径不打到应用自身的域名。
 */
console.log('\n—— 10. HTML 原样视图 ——');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
const htmlId = await importFile(FIX_HTML);

await check('HTML 解析出 5 段', async () => {
  await page.waitForSelector(`[data-video-id="${htmlId}"]:has-text("已解析 5 段")`, { timeout: 40000 });
});

// 播种一条含段落引用的历史会话，用于验证原样视图里的 [第3段] 跳转
await seedChat(htmlId, '这一段见 [第3段]。');

const reqMark = requests.length;
await page.click(`[data-video-id="${htmlId}"] [data-testid="btn-play"]`);
await page.waitForSelector('[data-testid="html-frame"]', { timeout: 20000 });
await page.waitForFunction(
  () => {
    const f = document.querySelector('[data-testid="html-frame"]');
    return !!f?.contentDocument?.querySelector('[data-mr-unit]');
  },
  { timeout: 20000 },
);

await check('沙箱只有 allow-same-origin（多了 allow-scripts 就等于没有沙箱）', async () => {
  const sandbox = await page.getAttribute('[data-testid="html-frame"]', 'sandbox');
  assert.equal(sandbox, 'allow-same-origin');
});

await check('文档自己的样式表生效（保真的判别依据）', async () => {
  const color = await page.evaluate(() => {
    const doc = document.querySelector('[data-testid="html-frame"]').contentDocument;
    return getComputedStyle(doc.querySelector('.mr-probe')).color;
  });
  assert.equal(color, 'rgb(1, 2, 3)');
});

await check('导入文档的脚本没有执行', async () => {
  const pwned = await page.evaluate(
    () => document.querySelector('[data-testid="html-frame"]').contentWindow.__mrPwned ?? null,
  );
  assert.equal(pwned, null, '导入文档里的脚本被执行了');
});

await check('内嵌图片与远程图片都显示，相对路径图片被摘掉', async () => {
  await page.waitForFunction(
    () => {
      const doc = document.querySelector('[data-testid="html-frame"]')?.contentDocument;
      const imgs = doc ? [...doc.querySelectorAll('img')] : [];
      return imgs.length === 3 && imgs[2].naturalWidth > 0;
    },
    null,
    { timeout: 15000 },
  );
  const imgs = await page.evaluate(() => {
    const doc = document.querySelector('[data-testid="html-frame"]').contentDocument;
    return [...doc.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth }));
  });
  assert.equal(imgs[0].src, null, '相对路径图片该被摘掉 src');
  assert.equal(imgs[0].w, 0);
  assert.ok(imgs[1].src.startsWith('data:image/'));
  assert.ok(imgs[1].w > 0, '内嵌图片没显示');
  assert.equal(imgs[2].src, 'https://cdn.mr.test/remote.png');
  assert.ok(imgs[2].w > 0, '远程图片没显示');
});

await check('不变量：渲染期没有请求应用自身的源', async () => {
  const since = requests.slice(reqMark);
  const selfHits = since.filter((u) => u.includes('local.png'));
  assert.deepEqual(selfHits, [], `相对路径图片打到了应用自身：${selfHits.join(', ')}`);
  assert.ok(
    since.some((u) => u.includes('cdn.mr.test/remote.png')),
    '远程图片没有被请求（联网加载没生效）',
  );
});

await check('联网提示条出现并说明外部资源与相对路径', async () => {
  const hint = await page.textContent('[data-testid="html-remote-hint"]');
  assert.ok(hint.includes('正在联网加载'), `提示文案：${hint}`);
  assert.ok(hint.includes('本地相对路径'), `提示文案：${hint}`);
});

await check('iframe 内划词：浮层出现，锚点落在 iframe 内且标为「第 1 段」', async () => {
  await page.evaluate(() => {
    const doc = document.querySelector('[data-testid="html-frame"]').contentDocument;
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelectorAll('p')[0]);
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.waitForSelector('[data-testid="ask-float"]', { timeout: 5000 });
  const where = await page.textContent('.ask-float__where');
  // 段标签带章节前缀（与 Word 的「§2.1 第 4 段」同一套规则），所以断言后缀而不是全等
  assert.ok(where.trim().endsWith('第 1 段'), `位置标签：${where}`);
  // 坐标必须换算到宿主视口：iframe 内的 rect 是它自己的坐标系，漏了这一步浮层会飘，
  // 且只在 iframe 不在视口原点时才显形 —— 所以这条要真的比几何
  const g = await page.evaluate(() => {
    const f = document.querySelector('[data-testid="html-frame"]').getBoundingClientRect();
    const b = document.querySelector('[data-testid="ask-float"]').getBoundingClientRect();
    return {
      fTop: f.top,
      fBottom: f.bottom,
      fLeft: f.left,
      fRight: f.right,
      bTop: b.top,
      bCx: b.left + b.width / 2,
    };
  });
  assert.ok(g.bTop >= g.fTop - 1 && g.bTop <= g.fBottom, `浮层 top=${g.bTop} 不在 iframe [${g.fTop}, ${g.fBottom}] 内`);
  // 比**中心**而不是整个矩形：浮层最宽 560px，选区一靠左它必然溢出 iframe 左边 ——
  // 那是设计如此（与 PDF 阅读器同一套钳制，只保证不出视口，实测 fLeft≈235、中心≈430）。
  // 但**中心**必须落在 iframe 内：漏加 iframe 偏移时中心会停在 iframe 左边的侧栏上（≈104），
  // 所以这条仍然能把「忘了换算坐标」钉住，同时不因浮层宽度误报。
  assert.ok(
    g.bCx >= g.fLeft - 1 && g.bCx <= g.fRight,
    `浮层中心 x=${g.bCx} 不在 iframe [${g.fLeft}, ${g.fRight}] 内（多半是漏加了 iframe 偏移）`,
  );
});

await check('点「就这段提问」→ 引用条带「第 1 段」', async () => {
  await page.click('[data-testid="ask-compose"]');
  await page.waitForSelector('[data-testid="chat-ref-chip"]', { timeout: 5000 });
  const chip = await page.textContent('[data-testid="chat-ref-chip"]');
  assert.ok(chip.includes('第 1 段'), `引用条内容：${chip}`);
});

await check('回答里的 [第3段] 可点击，高亮落在第三段', async () => {
  const link = page.locator('[data-testid="chat-msg-ai"] a', { hasText: '第3段' }).first();
  await link.waitFor({ timeout: 10000 });
  await link.click();
  await page.waitForFunction(
    () => {
      const doc = document.querySelector('[data-testid="html-frame"]')?.contentDocument;
      return !!doc && doc.querySelectorAll('.mr-doc-mark').length > 0;
    },
    null,
    { timeout: 10000 },
  );
  const marked = await page.evaluate(() => {
    const doc = document.querySelector('[data-testid="html-frame"]').contentDocument;
    return [...doc.querySelectorAll('.mr-doc-mark')].map((e) => e.textContent.trim());
  });
  assert.equal(marked.length, 1, `高亮元素数：${marked.length}`);
  assert.ok(marked[0].includes('第三段'), `高亮落在：${marked[0].slice(0, 40)}`);
});

await check('阅读位置写回库（原样视图下 lastUnit = 视口顶部所在单元）', async () => {
  // 上一步的 [第3段] 跳转已经把我送到第 3 段，所以这里直接读库即可。
  // 这条钉的是不变量 6：原样视图的 lastUnit 与分段视图同义，
  // 断点续读才不会因为切视图而错位。
  const saved = await page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('wangke');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const row = await new Promise((res, rej) => {
      const q = db.transaction('videos').objectStore('videos').get(id);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    return row?.lastUnit ?? null;
  }, htmlId);
  assert.equal(saved, 3, `入库的 lastUnit=${saved}（跳到第 3 段后应写回 3）`);
});

await page.screenshot({ path: 'e2e-shots/materials-html.png', fullPage: false });

await check('切到分段视图：文档样式不再生效，但正文仍在', async () => {
  await page.click('[data-testid="html-view"] mdui-segmented-button[value="blocks"]');
  await page.waitForSelector('.mr-html .mr-html__block', { timeout: 10000 });
  const state = await page.evaluate(() => ({
    frame: !!document.querySelector('[data-testid="html-frame"]'),
    probe: !!document.querySelector('.mr-html .mr-probe'),
    text: document.querySelector('.mr-html')?.textContent ?? '',
  }));
  assert.equal(state.frame, false, '分段视图不该还挂着 iframe');
  assert.equal(state.probe, false, '分段视图走白名单净化，class 属性不该保留');
  assert.ok(state.text.includes('第三段'), '分段视图应渲染出正文');
});

await check('切视图不丢位置，且视图选择写回库', async () => {
  // 静置再读库：`htmlView` 的写回是异步的（Dexie），刚点完可能还没落库。
  // 这里**不能**拿「指示器 = 第 3 段」当同步点 —— `current` 是两个视图共用的状态，
  // 切过去时它本来就是 3，那个条件会立刻成立，等不到写库完成。
  await page.waitForTimeout(800);
  const snap = await page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('wangke');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const row = await new Promise((res, rej) => {
      const q = db.transaction('videos').objectStore('videos').get(id);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    return {
      indicator: document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() ?? '',
      htmlView: row?.htmlView ?? null,
      lastUnit: row?.lastUnit ?? null,
    };
  }, htmlId);

  assert.equal(snap.htmlView, 'blocks', `入库的 htmlView=${snap.htmlView}（切到分段后应写回 videos.htmlView）`);
  // 这条是不变量 6 的判据：两种视图共用一个 lastUnit，切视图**不能**把它改掉。
  // 曾经的实现会在这里写成 1 —— IntersectionObserver 创建后的首批回调报的是
  // 「这个视图的初始交集状态」（对装得下的文档必然命中第 1 段），不是用户动作，
  // 却被当成了位置来源。修法见 HtmlReader 里那段注释。
  assert.equal(
    snap.lastUnit,
    3,
    `切到分段视图后 lastUnit 变成 ${snap.lastUnit}（应保持 3），指示器=${snap.indicator}`,
  );
});

await check('切回原样：位置回到第 3 段，视图选择改回 raw', async () => {
  await page.click('[data-testid="html-view"] mdui-segmented-button[value="raw"]');
  await page.waitForSelector('[data-testid="html-frame"]', { timeout: 10000 });
  const saved = await page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('wangke');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const row = await new Promise((res, rej) => {
      const q = db.transaction('videos').objectStore('videos').get(id);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    return {
      indicator: document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() ?? '',
      htmlView: row?.htmlView ?? null,
      lastUnit: row?.lastUnit ?? null,
    };
  }, htmlId);
  // 位置必须**原样带过来**。原样视图的 iframe 装得下整份 fixture（约 250px 内容 / 704px 视口，
  // 根本没有滚动条），若在进入视图时按「视口顶部所在单元」重算，这里必然读到第 1 段。
  // 判据与取舍理由见 HtmlReader 里那段「落位即位置」注释。
  assert.equal(saved.indicator, '第 3 / 5 段', `切回原样后指示器=${saved.indicator}（应保持第 3 段）`);
  assert.equal(saved.htmlView, 'raw', `入库的 htmlView=${saved.htmlView}（切回原样后应写回 raw）`);
  assert.equal(saved.lastUnit, 3, `切回原样后 lastUnit=${saved.lastUnit}（应保持 3）`);
});

await check('重开：落在原样视图且回到第 3 段（「选择会记住」+ 断点续读）', async () => {
  // 真重载页面（不是只重挂组件），确认初值确实从库里来 ——
  // 只验组件内切换证明不了入库，更证明不了下次打开会用它当初值
  //（`initialView` 传错、字段没进同步白名单，两种错都漏得掉）。
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click(`[data-video-id="${htmlId}"] [data-testid="btn-play"]`);
  await page.waitForSelector('[data-testid="html-view"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="html-frame"]', { timeout: 20000 });
  // 「等稳定 → 精确断言」而不是直接 waitForFunction 等那个精确值：
  // 后者超时只会说「Timeout 15000ms exceeded」，把实况值（第几段）埋在诊断里；
  // 前者失败时 assert 会把读到的值写进消息，一眼能看出是回到第 1 段还是根本没渲染。
  // 位置本身是**立即**就对的（`current` 初值取库里的 lastUnit），所以这里没有等待窗口。
  await page.waitForFunction(
    () => /^第 \d+ \/ \d+ 段$/.test(document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() ?? ''),
    null,
    { timeout: 20000 },
  );
  const ind = (await page.textContent('[data-testid="reader-page-indicator"]')).trim();
  assert.equal(ind, '第 3 / 5 段', '重开后应回到第 3 段（断点续读）');
});

await check('「本次离线」后，远程资源不再加载', async () => {
  // 基线必须等**这一轮** iframe 的远程图片加载完再记：
  // 上一步刚重载过页面（重开 = 重新载入一份文档），浏览器会重新取一次远程图片，
  // 而 `waitForSelector('html-frame')` 只保证 <iframe> 元素存在，此刻请求可能还没发出去。
  // 基线记早了，它就会落到「本次离线」之后，被误判成「离线失效」——测量误差，不是功能坏了。
  await page.waitForFunction(
    () => {
      const doc = document.querySelector('[data-testid="html-frame"]')?.contentDocument;
      const imgs = doc ? [...doc.querySelectorAll('img')] : [];
      return imgs.length === 3 && imgs[2].naturalWidth > 0;
    },
    null,
    { timeout: 15000 },
  );
  const mark = requests.length;
  await page.click('[data-testid="html-offline-once"]');
  await page.waitForFunction(
    () => {
      const doc = document.querySelector('[data-testid="html-frame"]')?.contentDocument;
      const imgs = doc ? [...doc.querySelectorAll('img')] : [];
      return imgs.length === 3 && imgs[2].getAttribute('src') === null;
    },
    null,
    { timeout: 15000 },
  );
  const since = requests.slice(mark);
  assert.deepEqual(since.filter((u) => u.includes('cdn.mr.test')), [], '「本次离线」之后仍请求了远程资源');
  const hint = await page.textContent('[data-testid="html-remote-hint"]');
  assert.ok(hint.includes('未加载'), `提示文案：${hint}`);
});

await check('长文档（内容高于容器）：切视图后两个视图都落位到同一段', async () => {
  // 上一条的 `sample.html` 装得下（约 250px 内容 / 704px 视口），几何给不出位置 ——
  // 「切视图落位」在那时没有判别力（怎么切都对，因为压根没得滚）。这条换一份**高过一屏**的
  // 文档：容器真的能滚动，位置才有几何表达，才钉得住「切视图不丢位置」的另一半。
  //
  // 位置用**播种入库值**建立（`htmlView=blocks` + `lastUnit=3`），不靠「滚一下容器」去制造 ——
  // 分段视图的段号来自 `IntersectionObserver`，而它的首批回调被显式丢弃；我们的滚动若恰好
  // 赶在那批之前，会被当成「初始状态」一起丢掉，指示器就永远不动（实测踩到过，偶发变红）。
  // 播种 + 打开走的是产品自己的断点续读路径，确定性。
  //
  // 钉三段，缺一不可：
  //   ⓪ 打开：断点续读落在第 3 段（分段容器）；
  //   ① 分段 → 原样：容器重挂 + iframe 重新加载 → 靠原样视图那段「落位即位置」；
  //   ② 原样 → 分段：容器重挂、滚动位置归零 → 靠分段视图那段落位。它原来**只做一次**，
  //                  切回来就停在顶部，而指示器还报着第 3 段（位置丢了还看不出来）。
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
  const longId = await importFile(FIX_HTML_LONG);
  await page.waitForSelector(`[data-video-id="${longId}"]:has-text("已解析")`, { timeout: 40000 });

  // 用**中间**那一段当目标：最后一段「落到视口顶部」在几何上做不到（它下面没内容了，
  // 滚动会被钳住），拿它当目标会变成一条永远红的假断言。
  const MID = 3;
  await seedReadingPos(longId, { htmlView: 'blocks', lastUnit: MID });
  await page.click(`[data-video-id="${longId}"] [data-testid="btn-play"]`);
  await page.waitForSelector('.mr-html .mr-html__block', { timeout: 20000 });

  const total = await page.evaluate(() => {
    const m = /\/ (\d+) 段/.exec(document.querySelector('[data-testid="reader-page-indicator"]')?.textContent ?? '');
    return m ? Number(m[1]) : 0;
  });
  assert.ok(total > MID, `长文档至少要解析出 ${MID + 1} 段，实得 ${total}`);

  const readBlocks = () =>
    page.evaluate((n) => {
      const root = document.querySelector('.mr-scroll');
      const el = root?.querySelector(`.mr-html__block[data-unit="${n}"]`);
      return {
        indicator: document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() ?? '',
        scrollTop: root?.scrollTop ?? null,
        top: el ? Math.round(el.getBoundingClientRect().top) : null,
        rootTop: root ? Math.round(root.getBoundingClientRect().top) : null,
      };
    }, MID);

  // ⓪ 开局：断点续读把分段容器落在第 3 段（等落位 effect 跑完再读，读到的就是实况）
  const open = await until(readBlocks, (s) => s.scrollTop > 0);
  assert.equal(open.indicator, `第 ${MID} / ${total} 段`, `打开后指示器=${open.indicator}`);
  assert.ok(open.scrollTop > 0, `打开后分段容器停在顶部（scrollTop=${open.scrollTop}）—— 断点续读没生效`);
  assert.ok(
    open.top !== null && Math.abs(open.top - open.rootTop) <= 16,
    `打开后第 ${MID} 段不在容器顶部（段 top=${open.top} / 容器 top=${open.rootTop}）`,
  );

  // ① 分段 → 原样：iframe 里这一段要落到视口顶部（判定线与组件里那条 72px 一致）
  await page.click('[data-testid="html-view"] mdui-segmented-button[value="raw"]');
  await page.waitForSelector('[data-testid="html-frame"]', { timeout: 20000 });
  // ⚠️ `waitForSelector` 只保证 <iframe> 元素存在，此刻它的 contentDocument 还是个空的
  // `about:blank` —— 必须再等文档真的就绪（出现锚点），否则下面查到的是空气。
  // 同一个坑 §5.4 已经记过一次（「基线记早了」），这里是它的第二次。
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="html-frame"]')?.contentDocument?.querySelector('[data-mr-unit]'),
    null,
    { timeout: 20000 },
  );
  const raw = await page.evaluate((n) => {
    const doc = document.querySelector('[data-testid="html-frame"]')?.contentDocument;
    const el = doc?.querySelector(`[data-mr-unit="${n}"]`);
    return {
      top: el ? Math.round(el.getBoundingClientRect().top) : null,
      indicator: document.querySelector('[data-testid="reader-page-indicator"]')?.textContent.trim() ?? '',
    };
  }, MID);
  assert.ok(raw.top !== null, `原样视图里找不到第 ${MID} 段`);
  assert.ok(raw.top <= 72, `切到原样后第 ${MID} 段不在视口顶部（top=${raw.top}）`);
  assert.equal(raw.indicator, `第 ${MID} / ${total} 段`, `切到原样后指示器=${raw.indicator}`);

  // ② 原样 → 分段：容器重挂、滚动位置归零，必须**重新落位**。
  //    落位原来只做一次，切回来就不再落位。实测过它的后果 —— 把容器的元素类型从 `div`
  //    换成 `section`（一次无害重构）：`scrollTop=0`、第 3 段停在容器下方 480px 处，
  //    而指示器照样报「第 3 段」：位置丢了，而且看不出来（指示器在说谎，比单纯丢位置更难发现）。
  //
  //    也记一条**不改也不会红**的原因，免得下次有人以为这条断言没判别力：
  //    两个视图分支渲染的都是 `div`，React 会复用同一个节点，连带把滚动偏移一起保住了 ——
  //    「位置没丢」是捡来的，不是落位逻辑挣来的。这条断言钉的是**结果**（两个视图落在同一段），
  //    机制由组件负责；所以它不区分「靠复用侥幸对」和「靠落位明确对」，那是刻意的。
  await page.click('[data-testid="html-view"] mdui-segmented-button[value="blocks"]');
  await page.waitForSelector('.mr-html .mr-html__block', { timeout: 20000 });
  const back = await until(readBlocks, (s) => s.scrollTop > 0);
  assert.equal(back.indicator, `第 ${MID} / ${total} 段`, `切回分段后指示器=${back.indicator}`);
  assert.ok(back.scrollTop > 0, `切回分段后容器停在顶部（scrollTop=${back.scrollTop}）—— 位置丢了`);
  assert.ok(
    back.top !== null && Math.abs(back.top - back.rootTop) <= 16,
    `切回分段后第 ${MID} 段不在容器顶部（段 top=${back.top} / 容器 top=${back.rootTop}）`,
  );
});

await page.screenshot({ path: 'e2e-shots/materials.png', fullPage: false });
console.log('\n截图：e2e-shots/materials.png');

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
if (failed > 0) process.exit(1);
