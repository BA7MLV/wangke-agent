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
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const FIX_ZH = path.resolve('scripts/fixtures/sample-zh.pdf');
const FIX_DOCX = path.resolve('scripts/fixtures/sample.docx');
const FIX_SCANNED = path.resolve('scripts/fixtures/sample-scanned.pdf');
const FIX_EMPTY_DOCX = path.resolve('scripts/fixtures/sample-empty.docx');

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

await page.screenshot({ path: 'e2e-shots/materials.png', fullPage: false });
console.log('\n截图：e2e-shots/materials.png');

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
if (failed > 0) process.exit(1);
