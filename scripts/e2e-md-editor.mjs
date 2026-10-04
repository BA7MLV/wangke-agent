/* eslint-disable no-console */
/**
 * E2E：Markdown 所见即所得编辑面（CodeMirror 6）+ agent 与用户共编辑同一份文档。
 *
 * ── 为什么必须有这条 ──────────────────────────────────────────────────────────
 * 这个功能的所有决策都是**静默失效**的形态：
 *   · 「语法符号藏了」与「符号藏过头导致打不了字」在截图上一模一样（都看不见 #）；
 *   · 「保存成功」只看 blob 就能通过，但问答检索读的 materialBlocks 还是旧的 ——
 *     用户改完看着生效了，一问「新写的这句在哪」却答不上来；
 *   · agentDiff 挂进「预览 ⇄ 源码」那个 Compartment 时，只有点一下源码才发现高亮被清空，
 *     而那正好是「用户最需要看见 agent 改了什么」的视图；
 *   · 撤销按钮「灰着」与「点了没反应」在页面上也长得一样。
 * 所以下面每条断言都成对出现（隐藏 + 露出、能改 + 能撤、能存 blob + 能重建块）。
 *
 * ── 为什么跑 dev(5173)，不跑 preview(4173) ───────────────────────────────────
 * B 组要读回应用**自己那份** Dexie 实例（materialBlocks），C 组要拿 agent 桥的
 * `getMdEditor` —— 两者都靠 `import('/src/store/db.ts')` 这种「按模块 URL 取应用同一份实例」
 * 的办法（scripts/e2e-import.mjs 与 e2e-md-covers.mjs 是同一个先例）。
 * 生产构建里这两条路都断：模块已打包，句柄拿不到；而 bridge 的导出名还会被 rollup 改写
 * （上一个任务实测：preview 下页面里根本取不到 getMdEditor）。
 *
 * ── 为什么不调模型 ───────────────────────────────────────────────────────────
 * C 组（agent 共编辑）走的是 `bridge.applyEdits`，也就是 `edit_markdown` 工具**落地之后**
 * 真正执行的那一段代码；页面里直接调它就完整覆盖了 diff 高亮、撤销、纯删除撤销与
 * 视图切换后的高亮保持。而「模型会不会真的发出这个工具调用」属于提示词契约，
 * 要 SF_KEY 才能验 —— 把它拆成另一条 key 档脚本会让本条的核心价值（不花钱也能守）消失。
 * 目前没有那条模型链路脚本，见交付说明里的「覆盖缺口」。
 *
 * ── fixture 刻意写在脚本里（不落 scripts/fixtures/）───────────────────────────
 * 这条断言要按行、按字符列定位光标（"光标落到第几行第几列"是隐藏/露出不变量的判据），
 * fixture 一旦被别处编辑，这几行断言就会以「找不到那一行」的形式红掉，而且红得毫无信息量。
 * 内容内联在这里，它与断言是一份东西，改的时候必然一起看到。
 *
 * 用法：npm run dev &  然后 node scripts/e2e-md-editor.mjs
 *      （编排器注入 BASE_URL；手动跑时默认 http://localhost:5173）
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';

/**
 * 被编辑的 md。行号在下面几处断言里被引用，改动前先对一遍：
 *   0 `# 所见即所得编辑面`   ← A3/A4 盯首行的 `#`
 *   1 （空行）
 *   2 正文段                 ← B6 在这一行行尾追加 marker
 *   3 （空行）
 *   4 含两处行内代码         ← A5 盯反引号
 *   5 （空行）
 *   6 `- 列表项一`           ← C12 纯删除的对象
 *   7 `- 列表项二`           ← C9 agent 第二处改动
 *
 * ⚠️ 正文里**不能出现反引号字面量**（"反引号该藏就藏" 这种写法会让 lezer 把后面整段
 * 当成行内代码），也不能出现多余的 `#` —— 这份文本同时是「藏得对不对」的判据。
 * 反引号越少，A5 的断言越不会因为解析歧义而假红。
 */
const MD_FIXTURE = [
  '# 所见即所得编辑面',
  '',
  '这一段用来验证打字落盘、重新分块与刷新后仍在。',
  '',
  '调用 `foo()` 与 `bar()` 两处行内代码。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
].join('\n');

/** B6 追加的标记。用纯 ASCII：归一化（chunk.ts 的 collapseCjkSpaces）只动汉字之间的空格，
 *  拉丁字符逐字保留，所以它在 materialBlocks 里出现/消失就只取决于「有没有重新分块」。 */
const MARKER = 'E2E_APPEND_MARKER';

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

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

/**
 * pageerror **收集到最后一条断言**再报，不在中途就抛。
 * 中途抛会让后面几条一起红 —— 而那些红都是同一个根因的余波，真正的原因会被淹掉。
 */
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`   [console.error] ${m.text().slice(0, 200)}`);
});

/**
 * 找出「应用正在用的那一份」模块的 URL（dev 下 Vite 以 URL 为键缓存模块实例，
 * 所以只有拿到同一个 URL，才能拿到应用同一个 db / agent 桥 —— scripts/e2e-import.mjs
 * 与 e2e-md-covers.mjs 是同一个先例）。
 *
 * 为什么不直接 import 干净路径：Vite 在某模块被改动后会让**引用它的地方**改用
 * `/src/md-editor/bridge.ts?t=1759…` 这种带时间戳的 URL。此时 import 干净路径会**另建一份
 * 模块实例** —— bridge 那份注册表是空的（症状：编辑器明明开着，getMdEditor 却返回 undefined）。
 *
 * 候选 URL 的来源，按可靠度排：
 *   1. **importer 的产物源码**。Vite 把 `import … from './bridge'` 改写成带戳的绝对 URL，
 *      那份源码里写的就是应用一定会用的 URL（实测这条能直接命中）；
 *   2. `performance.getEntriesByType('resource')` —— 只能当补充：dev 下模块请求有几百个，
 *      而 resource timing 缓冲区默认只留 250 条，早就被挤掉了（实测被挤掉过一次）；
 *   3. 干净路径（全新 dev server 时的常态）。
 * 每个候选都 import 一遍并用 `probe` 验「这份是不是应用在用的」，第一个验过的就是答案 ——
 * 与其猜哪个 URL 是对的，不如让应用的状态自己回答。
 *
 * 返回 URL 而不是模块对象：模块命名空间没法跨 evaluate 序列化，调用方拿 URL 再自己 import。
 */
await page.addInitScript(() => {
  window.__e2eFindAppModule = async (path, probeSrc, importer) => {
    const base = path.split('/').pop().replace('.', '\\.');
    const urls = [];
    if (importer) {
      const src = await (await fetch(importer, { cache: 'no-store' })).text();
      for (const m of src.matchAll(new RegExp(`["']([^"']*${base}(?:\\?[^"']*)?)["']`, 'g'))) urls.push(m[1]);
    }
    const re = new RegExp('^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\?|$)');
    urls.push(...performance.getEntriesByType('resource').map((e) => e.name).filter((n) => re.test(n)));
    urls.push(path);
    const probe = new Function('m', `return (${probeSrc});`);
    const tried = [];
    for (const u of [...new Set(urls)]) {
      try {
        const m = await import(u);
        if (probe(m)) return u;
        tried.push(`${u} → 不是应用在用的那一份`);
      } catch (e) {
        tried.push(`${u} → ${e}`);
      }
    }
    throw new Error(`找不到「应用在用的」${path}（试过 ${[...new Set(urls)].length} 个 URL）：${tried.join('；')}`);
  };
});

// ── 页内小工具 ────────────────────────────────────────────────────────────────

/** 编辑器里的每一行（按 0 起的文档行号）。用 textContent 而不是 innerText —— 空行会被 CM6
 *  渲染成 `<br>`，innerText 会为它多吐一个换行（实测每个段落边界都多一行），
 *  拿它做「逐字还原」的比对就是把两个同样错的东西对上，等于没比。 */
const readLines = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="md-editor"] .cm-content .cm-line')].map((el) => el.textContent),
  );

/** 读某一行；行不存在时报出行数便于定位 */
const lineText = async (line) => {
  const lines = await readLines();
  return lines[line] ?? `（只有 ${lines.length} 行，取不到第 ${line} 行）`;
};

/** 按行文本里的特征串找行 —— 比写死行号更抗改动：断言问的是「那行显示成什么样」 */
const lineWith = async (needle) => (await readLines()).find((t) => t.includes(needle)) ?? null;

/** agent 高亮段数（agentDiff 挂的是顶层 field，与视图切换无关） */
const diffCount = () => page.locator('[data-testid="md-editor"] .cm-md-diffadd').count();

/**
 * 编辑器全文。
 *
 * **必须在「源码」视图下读**：预览视图里被 livePreview 藏起来的语法符号压根没有 DOM 节点，
 * 拼回去的文本与文档不是一回事（而「撤销是不是逐字还原」问的正是文档）。
 * 另外围栏代码块在预览视图里是被 widget 折成零高度的，那一行读出来也是空的。
 */
const docText = async () => (await readLines()).join('\n').replace(/\n+$/, '');

/** 当前视图下用户眼睛看到的全部文字。只用于「某段还在不在」这类子串判断 */
const visibleText = async () => (await readLines()).join('\n');

/** 等两帧：装饰在 dispatch 里同步重算，但 DOM 上屏走 CM6 的 measure 通道 */
const settle = () =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));

const press = async (key, times = 1) => {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
};

/**
 * 把光标放到第 `line` 行（0 起）的第 `col` 个字符前。
 *
 * 先连按 30 次 ↑ 是为了「回到文档开头」：CM6 的纵向移动在越界时会 clamp 到首尾，
 * 于是「多按几次」就是一个可移植的 doc start —— macOS 上 Cmd+Home / Cmd+↑ 这类会被
 * 系统快捷键截走（根本送不到页面里），方向键不会。
 * 用它而不是「点第 N 行」是因为点进去只能拿到一个由点击坐标决定的列，
 * 而 A5a 需要精确落在行内代码的括号之间。
 */
const gotoLine = async (line, { col = 0 } = {}) => {
  await page.click('[data-testid="md-editor"] .cm-content');
  await press('ArrowUp', 30);
  await press('ArrowDown', line);
  await press('ArrowRight', col);
};

/** 「预览 ⇄ 源码」切换。等组件自身的 value 落到目标档 —— 它就是 React 的 showSource */
async function switchView(view) {
  await page.click(`[data-testid="md-source-view"] mdui-segmented-button[value="${view}"]`);
  await page.waitForFunction(
    (v) => document.querySelector('[data-testid="md-source-view"]')?.value === v,
    view,
    { timeout: 5000 },
  );
  await settle();
}

/** 撤销按钮当前可点吗（mdui-button 的 disabled 会让宿主 pointer-events:none） */
const undoEnabled = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="md-agent-undo"]');
    if (!el) return null;
    return !(el.hasAttribute('disabled') || el.disabled === true);
  });

/** 点「撤销本次」：先等它亮起来，否则 Playwright 会在 pointer-events:none 上等到超时 */
async function clickUndo() {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="md-agent-undo"]');
      return el && !(el.hasAttribute('disabled') || el.disabled === true);
    },
    { timeout: 5000 },
  );
  await page.click('[data-testid="md-agent-undo"]');
}

/** 在页面里调 agent 桥（= edit_markdown 工具落地后执行的那一段），返回回执 */
const applyEdits = (id, edits) =>
  page.evaluate(
    async ([mid, list]) => {
      // 探针就是「这份材料此刻确实注册在桥里」—— 借它顺带把「拿到的不是应用那一份模块」这件事
      // 与「编辑器没注册」区分开：后者报 undefined，前者报 import 不到，后者的修法完全不同
      const url = await window.__e2eFindAppModule(
        '/src/md-editor/bridge.ts',
        `!!m.getMdEditor(${JSON.stringify(mid)})`,
        '/src/md-editor/MdEditor.tsx',
      );
      const { getMdEditor } = await import(url);
      const ctl = getMdEditor(mid);
      if (!ctl) return { ok: false, error: 'getMdEditor 返回 undefined（编辑面没注册进桥）' };
      return ctl.applyEdits(list);
    },
    [id, edits],
  );

/** 读回 materialBlocks（检索真正读的那张表） */
const readBlocks = (id) =>
  page.evaluate(async (mid) => {
    // db / fileStore 都由 md 落盘链路（save.ts）引用，从它的产物里抠 URL 最准
    const url = await window.__e2eFindAppModule(
      '/src/store/db.ts',
      '!!(m.db && m.db.materialBlocks)',
      '/src/md-editor/save.ts',
    );
    const { db } = await import(url);
    const rows = await db.materialBlocks.where('materialId').equals(mid).sortBy('idx');
    return rows.map((r) => ({ idx: r.idx, unit: r.unit, unitLabel: r.unitLabel, text: r.text, kind: r.kind }));
  }, id);

/** 读回 OPFS 里的原文（用应用自己的 fileStore，不手搓 OPFS 路径） */
const readBlob = (id) =>
  page.evaluate(async (mid) => {
    const url = await window.__e2eFindAppModule(
      '/src/store/fileStore.ts',
      'typeof m.getMaterialFile === "function"',
      '/src/md-editor/save.ts',
    );
    const { getMaterialFile } = await import(url);
    const b = await getMaterialFile(mid);
    return b ? await b.text() : null;
  }, id);

/** 导入并在库列表里等它解析完；返回 materialId（按「新增的那一行」认，不按文件名匹配） */
async function importMd() {
  const before = await page.$$eval('[data-testid="video-item"]', (els) => els.map((el) => el.dataset.videoId));
  await page.setInputFiles('[data-testid="import-input"]', {
    name: 'e2e-md-editor.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(MD_FIXTURE, 'utf8'),
  });
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
  const id = await handle.jsonValue();
  // 等「已解析 N 段」：块集建完之后 data-ask-label 才有内容（MdReader 的标签来自 materialBlocks）
  await page.waitForSelector(`[data-video-id="${id}"]:has-text("已解析")`, { timeout: 40000 });
  return id;
}

/** 打开阅读器。刷新后 hash 路由会自己回到播放页，走不到才回库页点一次 */
async function openReader(id) {
  const appeared = await page
    .waitForSelector('[data-testid="material-reader"]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`[data-video-id="${id}"] [data-testid="btn-play"]`, { timeout: 20000 });
    await page.click(`[data-video-id="${id}"] [data-testid="btn-play"]`);
    await page.waitForSelector('[data-testid="material-reader"]', { timeout: 20000 });
  }
  await page.waitForSelector('[data-testid="md-edit-toggle"]', { timeout: 20000 });
}

/** 进编辑态并等编辑器上屏（MdEditor 是 React.lazy 的独立 chunk，要等它落地） */
async function enterEdit() {
  await page.click('[data-testid="md-edit-toggle"]');
  await page.waitForSelector('[data-testid="md-editor"] .cm-content', { timeout: 20000 });
}

/** 退出编辑态：点「完成」→ MdReader 先 flush 再切回阅读态 */
async function exitEdit() {
  await page.click('[data-testid="md-edit-toggle"]');
  await page.waitForSelector('[data-testid="md-editor"]', { state: 'detached', timeout: 20000 });
  await page.waitForSelector('.mr-md__block', { timeout: 20000 });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('—— 1. 导入 md 并打开阅读视图 ——');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="import-input"]', { state: 'attached', timeout: 20000 });
const mdId = await importMd();
const blocksBefore = await readBlocks(mdId);
console.log(`   materialId=${mdId} · 初始块数 ${blocksBefore.length}`);

await openReader(mdId);

await check('A1 打开 md 材料 → 阅读视图出现（分块渲染成 md 段落）', async () => {
  await page.waitForSelector('.mr-md__block', { timeout: 20000 });
  const n = await page.locator('.mr-md__block').count();
  assert.ok(n > 0, '一个段落都没渲染');
  assert.match(
    await page.locator('[data-testid="reader-page-indicator"]').innerText(),
    /第 1 \/ \d+ 段/,
    '段号指示器不在阅读态',
  );
});

await check('D13 阅读态的 data-askable / data-ask-unit / data-ask-label 三件套仍在', async () => {
  // 划词提问与「[第N段] 引用跳转」都靠这三个属性定位（见 MdReader 的 mr-md__block）。
  // 编辑功能是加在阅读态之上的，这一组属性一旦被改坏，划词提问会静默失效。
  const info = await page.$$eval('.mr-md__block', (els) =>
    els.map((el) => ({
      askable: el.dataset.askable,
      unit: el.dataset.askUnit,
      label: el.dataset.askLabel,
    })),
  );
  assert.ok(info.length > 0, '没有可划词的段落');
  for (const b of info) {
    assert.equal(b.askable, 'md', `data-askable=${b.askable}`);
    assert.ok(/^\d+$/.test(b.unit ?? ''), `data-ask-unit=${b.unit}`);
    assert.ok(b.label && b.label.length > 0, `data-ask-label=${JSON.stringify(b.label)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n—— 2. 所见即所得：语法符号该藏时藏、光标处必须露 ——');
await enterEdit();

await check('A2 点「编辑」→ CodeMirror 编辑面上屏', async () => {
  assert.equal(await page.locator('.cm-editor').count(), 1, '.cm-editor 没出现');
  // 工具条也要在：状态文案 / 撤销按钮 / 视图开关都在这一行里，少一个都说明编辑面没完整挂上
  assert.ok(await page.locator('[data-testid="md-edit-state"]').isVisible());
  assert.ok(await page.locator('[data-testid="md-source-view"]').isVisible());
  assert.ok(await page.locator('[data-testid="md-agent-undo"]').isVisible());
});

await check('A3 光标不在首行时，首行的 # 没有被渲染出来（隐藏生效）', async () => {
  // 「没有被渲染」在这里等于「# 不在行文本里」。刻意不用 innerText：空行被 CM6 渲染成 <br>，
  // innerText 会为它多吐一个换行（见 readLines 那段），拿它断言隐藏/露出等于掺进一个
  // 与被测无关的变量 —— 这条断言的全部意义就是「符号在不在 DOM 里」。
  await gotoLine(2);
  const l1 = await lineText(0);
  assert.ok(l1.includes('所见即所得编辑面'), `首行不是标题行，实际：${JSON.stringify(l1)}`);
  assert.ok(!l1.includes('#'), `首行仍渲染出 #，隐藏没生效：${JSON.stringify(l1)}`);
});

await check('A4 光标落进首行后 # 重新出现（露出生效 —— 藏过头就没法编辑了）', async () => {
  // 与 A3 是一对：A3 漏掉「藏过头」这个更严重的回归，A4 漏掉则整个功能等于没做
  await gotoLine(0);
  const l1 = await lineText(0);
  assert.ok(l1.startsWith('#'), `光标在首行仍看不到 #：${JSON.stringify(l1)}`);
});

await check('A5a 光标落进行内代码内，那一段的反引号露出来（露出范围是光标所在的那一段）', async () => {
  // 「调用 `foo()` 与 `bar()` 两处行内代码。」：列 5 落在 foo 中间（第 3 列是 `）
  await gotoLine(4, { col: 5 });
  const l = await lineWith('foo()');
  assert.ok(l, '含行内代码的那一行没渲染出来');
  assert.equal((l.match(/`/g) || []).length, 2, `反引号数量不对（光标所在那一段应露出 2 个）：${JSON.stringify(l)}`);
  assert.ok(l.includes('`foo()`'), `光标所在的那段没露出：${JSON.stringify(l)}`);
  // 同一行里**另一段**仍然藏着：露出范围是「光标所在的语法节点」而不是「整行」。
  // 把这条写成「整行都露」会把这条不变量放松成另一个 —— 那样「藏过头」就又测不出来了。
  assert.ok(!l.includes('`bar()`'), `光标不在的那一段也被露出来了：${JSON.stringify(l)}`);
});

await check('A5b 光标离开该行后反引号重新藏起来（同一套机制的第二处验证）', async () => {
  await gotoLine(6);
  const l = await lineWith('foo()');
  assert.ok(l, '含行内代码的那一行没渲染出来');
  assert.ok(!l.includes('`'), `反引号仍渲染着：${JSON.stringify(l)}`);
  assert.ok(l.includes('foo()'), `代码正文被一起吃掉了：${JSON.stringify(l)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n—— 3. 落盘与重新分块 ——');

await check('B6 打字 → 等防抖落盘 → 退出编辑 → 刷新页面后新内容仍在', async () => {
  await gotoLine(2);
  await page.keyboard.press('End');
  await page.keyboard.type(` ${MARKER}`);
  // **等「已保存」而不是 sleep**：MdReader 不传 debounceMs，测试跑的就是产品默认的 1.2s
  // （save.ts 的 MD_SAVE_DEBOUNCE_MS）。把它调短会让「默认档有没有被人改过」永远验不到 ——
  // 而那个数字正是「连续打字不卡」的取舍所在。
  await page.waitForFunction(
    () => document.querySelector('[data-testid="md-edit-state"]')?.textContent.trim() === '已保存',
    { timeout: 20000 },
  );
  await exitEdit();
  assert.match(await page.locator('.mr-scroll').innerText(), new RegExp(MARKER), '阅读视图没有新内容');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openReader(mdId);
  await page.waitForSelector('.mr-md__block', { timeout: 20000 });
  // 刷新后重新读的是 OPFS 上的那一版，所以这条同时证明「写的是盘不是内存」
  assert.match(await page.locator('.mr-scroll').innerText(), new RegExp(MARKER), '刷新后新内容没了');
});

await check('B7 materialBlocks 被重建：检索侧能查到新内容（不只是存了 blob）', async () => {
  // 这条守的是最隐蔽的回归：只写 blob 不重建块的话，界面上「已保存」、刷新后内容也在，
  // 唯独问答检索读的 materialBlocks 还是旧的 —— 看起来生效了，其实没有。
  // 所以断言的是**块文本里出现了 marker**，而不是「blob 里有」。
  const after = await readBlocks(mdId);
  assert.ok(after.some((b) => b.text.includes(MARKER)), `块文本里没有 ${MARKER}：${JSON.stringify(after)}`);
  assert.notEqual(
    after.map((b) => b.text).join('\n'),
    blocksBefore.map((b) => b.text).join('\n'),
    '块集与编辑前逐字相同 —— 重新分块没生效',
  );
  assert.equal(after.length, blocksBefore.length, `块数从 ${blocksBefore.length} 变成 ${after.length}`);
  // 块重建必须幂等地删掉旧块（reindexMaterial 是「先清后建」），多出来的行说明清失败了
  assert.equal(
    after.filter((b) => b.unitLabel === '').length,
    0,
    '有块丢了 unitLabel，重建过程写坏了行',
  );
  const blob = await readBlob(mdId);
  assert.ok(blob && blob.includes(MARKER), 'OPFS 里的原文没有新内容');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n—— 4. agent 与用户共编辑同一份文档 ——');
// agent 动手前的原文 = 此刻 OPFS 上那一版（B6 退出编辑时已 flush 过，之后没再改过）。
// 之所以不靠在编辑器里读：**预览视图的 innerText 缺语法符号**，读全文就得切「源码」，
// 而切视图会重配 Compartment —— 那正是 C11 要验的东西，绝不能在它之前先切一次
// （先切过再让 C9 跑的话，C9 就永远在「已经重配过」的状态下测，测不出 applyEdits 本身）。
const beforeAgent = ((await readBlob(mdId)) ?? '').replace(/\n+$/, '');
assert.ok(beforeAgent.includes(MARKER), '盘上的原文不含用户追加的那段，后续的逐字比对会失去意义');
await enterEdit();
// 编辑器初始文本必须与盘上那一版逐字相同：它是从 blob 读的，不一致就说明「读回来的版本」
// 与「写下去的版本」已经分家了（而后面所有逐字比对的基准都建立在这上面）
await switchView('source');
assert.equal(await docText(), beforeAgent, '编辑器里的初始文本与盘上的原文不一致');
await switchView('preview');

await check('C8 编辑面开着时，agent 桥里能拿到控制器', async () => {
  const r = await page.evaluate(async (mid) => {
    const url = await window.__e2eFindAppModule(
      '/src/md-editor/bridge.ts',
      `typeof m.getMdEditor === 'function'`,
      '/src/md-editor/MdEditor.tsx',
    );
    const { getMdEditor } = await import(url);
    const ctl = getMdEditor(mid);
    return {
      url,
      got: !!ctl,
      methods: ctl ? ['applyEdits', 'undoAgentBatch', 'hasAgentBatch'].filter((k) => typeof ctl[k] === 'function') : [],
    };
  }, mdId);
  // 生产构建里拿不到模块句柄（rollup 还会改写导出名），所以这条只能跑 dev
  assert.ok(r.got, `编辑器明明开着，getMdEditor 却返回 undefined（注册/注销错位，取到的是 ${r.url}）`);
  assert.deepEqual(r.methods, ['applyEdits', 'undoAgentBatch', 'hasAgentBatch'], '控制器接口与实现不符');
});

const EDIT1 = { old_string: '所见即所得编辑面', new_string: '所见即所得编辑面（已改）' };
const EDIT2 = { old_string: '列表项二', new_string: '列表项二 · agent 补充' };

await check('C9 applyEdits 改 2 处 → 出现 2 段 .cm-md-diffadd 高亮', async () => {
  const r = await applyEdits(mdId, [EDIT1, EDIT2]);
  assert.deepEqual(r, { ok: true, changed: 2 }, `回执不对：${JSON.stringify(r)}`);
  await settle();
  assert.equal(await diffCount(), 2, '高亮条数与「改了 2 处」对不上');
  const texts = await page.locator('[data-testid="md-editor"] .cm-md-diffadd').allInnerTexts();
  assert.deepEqual(
    texts.map((t) => t.trim()).sort(),
    [EDIT1.new_string, EDIT2.new_string].sort(),
    `高亮圈住的不是 agent 写上去的那两段：${JSON.stringify(texts)}`,
  );
  assert.equal(await undoEnabled(), true, '撤销按钮没亮（用户无从发现 agent 改过）');
});

await check('C11 切到「源码」再切回「预览」，agent 高亮仍在（不能被 Compartment 带走）', async () => {
  // agentDiff 必须挂顶层：挂进「预览 ⇄ 源码」那个 Compartment 的话，
  // Compartment 重配会把 field 移除再重建（create() = Decoration.none），
  // 高亮在用户最需要看见它的那个视图里凭空消失。
  await switchView('source');
  assert.equal(await diffCount(), 2, '切到源码后高亮没了');
  await switchView('preview');
  assert.equal(await diffCount(), 2, '切回预览后高亮没了');
});

await check('C10 点「撤销本次」→ 原文逐字还原、高亮清零、按钮变灰', async () => {
  await clickUndo();
  await settle();
  assert.equal(await diffCount(), 0, '撤销后高亮还在');
  assert.equal(await undoEnabled(), false, '撤销后按钮仍然可点（用户会连点，点出「没有可撤销的改动」）');
  assert.equal(
    await page.locator('[data-testid="md-undo-error"]').count(),
    0,
    '撤销成功却报了一条失败提示',
  );
  assert.equal(await page.locator('[data-testid="md-save-error"]').count(), 0, '编辑面报了一条保存失败');
  // 逐字还原：在源码视图读全文（预览视图的 innerText 缺语法符号，比不了）
  await switchView('source');
  const now = await docText();
  assert.equal(now, beforeAgent, `撤销后不是逐字还原：\n--- 改前 ---\n${beforeAgent}\n--- 改后 ---\n${now}`);
  await switchView('preview');
});

await check('C12 纯删除（new_string: ""）也能撤销，原文整段回来', async () => {
  // 纯删除的高亮是**零宽**的，按 agentDiff.ts 里的实测结论画不出来（Decoration.mark 对
  // 零宽会抛 RangeError），所以这里「没有绿条」是**预期**而不是坏了 ——
  // 但正因为没有可见证据，「能不能撤回来」才是用户唯一剩下的指望，必须真的验。
  const r = await applyEdits(mdId, [{ old_string: '列表项一', new_string: '' }]);
  assert.deepEqual(r, { ok: true, changed: 1 }, `回执不对：${JSON.stringify(r)}`);
  await settle();
  assert.equal(await diffCount(), 0, '纯删除画出了高亮（零宽区间本应画不出来，出现即说明实现变了）');
  assert.ok(!(await visibleText()).includes('列表项一'), '删除之后原文还在');
  assert.equal(await undoEnabled(), true, '纯删除没有可撤的凭据');

  await clickUndo();
  await settle();
  assert.ok((await visibleText()).includes('列表项一'), '撤销之后原文没回来');
  assert.equal(await diffCount(), 0, '撤销后高亮还在');
  assert.equal(await undoEnabled(), false, '撤销后按钮仍然可点');
  assert.equal(await page.locator('[data-testid="md-undo-error"]').count(), 0, '撤销成功却报了失败');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n—— 5. 回到阅读态：只读路径没被编辑功能带坏 ——');
await check('D13b 退出编辑后阅读视图恢复，且看不到被撤销掉的 agent 改动', async () => {
  await exitEdit();
  const text = await page.locator('.mr-scroll').innerText();
  const info = await page.$$eval('.mr-md__block', (els) =>
    els.map((el) => ({
      askable: el.dataset.askable,
      unit: el.dataset.askUnit,
      label: el.dataset.askLabel,
    })),
  );
  assert.ok(info.length > 0, '退出编辑后一个段落都没了');
  assert.ok(info.every((b) => b.askable === 'md' && b.unit && b.label), '划词三件套在编辑往返后掉了');
  assert.ok(text.includes(MARKER), '用户自己打的那段没了');
  // 撤销必须是真撤销：文档里不能残留 agent 那两处改动（只清高亮不还原内容是最像的假通过）
  assert.ok(!text.includes(EDIT1.new_string), `撤销后正文里还有「${EDIT1.new_string}」`);
  assert.ok(!text.includes(EDIT2.new_string), `撤销后正文里还有「${EDIT2.new_string}」`);
  assert.match(
    await page.locator('[data-testid="reader-page-indicator"]').innerText(),
    /第 1 \/ \d+ 段/,
    '退出编辑后仍停在「编辑中」',
  );
});

await check('全流程没有未捕获的页面异常', async () => {
  // 静默异常是这个功能最常见的失效形态（装饰错位、field 缺失都是抛出来但界面照旧）
  assert.deepEqual(pageErrors, [], `pageerror：\n${pageErrors.join('\n')}`);
});

await browser.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);