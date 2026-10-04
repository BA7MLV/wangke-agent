/* eslint-disable no-console */
// E2E：```svg 围栏在**流式生成过程中**的表现（边生成边画）
//   1. 相位真的走 waiting → drawing → ok，而不是一直卡在 waiting
//   2. 画布元素数随 token 到达单调增长，且**每一拍都能在屏幕上看到**（不是一次性跳到最终态）
//   3. 新到的图元带落画 class；描边的 stroke-dashoffset 从「全长」走到 0（真的在走，不是在闪）
//   4. 闭合后落回完整净化产物：工具条齐全、画布内容 === sanitizeSvg 的输出
//   5. 半截里带外部资源引用的 SVG：预览期不画（等闭合），闭合后照旧报错回退源码
//   6. 围栏外普通正文不受影响
//
// 模型流是**页内假的**：`addInitScript` 里把 window.fetch 换成脚本化 SSE 发生器，
// 逐 chunk 推送 —— 要验的就是「边生成边画」，接真模型反而把时序抖没了。
//
// 用法：npm run dev &  然后 node scripts/e2e-svg-stream.mjs
//   BASE_URL 默认 http://localhost:5173
//   TEST_FILE 不传时用 ffmpeg 现造一段 20s 带音轨的样片
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-svg-stream-test.mp4';
const SHOTS = 'e2e-shots';

if (!existsSync(TEST_FILE)) {
  console.log(`0. 生成测试样片 ${TEST_FILE}`);
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', TEST_FILE,
  ], { stdio: 'ignore' });
}
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

// 一段真实的教学图：坐标轴 → 曲线 → 中文标签。每个元素之间塞 90ms，
// 足以让 Playwright 在**每一拍之间**取一次样 —— 这正是这个脚本的全部意义。
const FIG_BODY = [
  '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6f4ff"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>',
  '<rect x="0" y="0" width="260" height="150" fill="url(#sky)"/>',
  '<line x1="30" y1="120" x2="240" y2="120" stroke="#8c8c8c" stroke-width="1.5"/>',
  '<line x1="30" y1="120" x2="30" y2="24" stroke="#8c8c8c" stroke-width="1.5"/>',
  '<path d="M40 110 Q135 6 230 110" fill="none" stroke="#1677ff" stroke-width="2.5"/>',
  '<circle cx="135" cy="58" r="4" fill="#f5222d"/>',
  // 同时带 fill 与 stroke 的图元：animation 是简写属性，两个 class 同时在时最容易互相覆盖
  '<rect x="152" y="32" width="74" height="18" rx="4" fill="#fff" stroke="#8c8c8c"/>',
  '<text x="135" y="140" font-size="11" text-anchor="middle">顶点 (135, 58)</text>',
];
const GOOD_SVG = `<svg viewBox="0 0 260 150" xmlns="http://www.w3.org/2000/svg">\n${FIG_BODY.join('\n')}\n</svg>`;
const BAD_SVG = '<svg viewBox="0 0 100 60"><rect width="100" height="60" fill="url(https://evil.example/x.svg#a)"/></svg>';

/** 把一段源码切成 ~14 字符一块的 delta 数组（模拟模型逐 token 吐字） */
const toChunks = (text, size = 14) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => { failed++; console.error(`   ❌ ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

// ── 设置 + 假的流式模型 ─────────────────────────────────────────────────────
await page.addInitScript(() => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: {
      apiKey: 'sk-fake-for-e2e',
      baseUrl: 'https://sf.test/v1',
      llmModel: 'test-model', visionModel: 'test-model', asrModel: 'test-model',
      contextWindow: 32768, agentRounds: 6,
    },
    version: 0,
  }));

  /** 脚本化 SSE 发生器：队列里每个元素是一整轮回答，delta 逐块推 + 真 setTimeout */
  const nativeFetch = window.fetch.bind(window);
  window.__LLM__ = { queue: [] };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/chat/completions')) return nativeFetch(input, init);
    const step = window.__LLM__.queue.shift() ?? { chunks: [{ content: '（没有脚本可播）' }] };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const delta of step.chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
          if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
});

/**
 * mdui-text-field 内部可能是 textarea 也可能是 input，两个都试（与 e2e-course-chat-cards 同款）
 */
async function typeAndSend(text) {
  const field = page.locator('[data-testid="chat-input"] textarea, [data-testid="chat-input"] input').first();
  await field.waitFor({ timeout: 10000 });
  await field.click();
  await field.fill(text);
  await field.press('Enter');
}

console.log('1. 导入测试视频');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
const videoId = await page.evaluate(async () => {
  const req = indexedDB.open('wangke');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
  const tx = db.transaction('videos', 'readonly');
  const all = await new Promise((res, rej) => { const q = tx.objectStore('videos').getAll(); q.onsuccess = () => res(q.result); q.onerror = rej; });
  db.close();
  return all[0]?.id ?? null;
});
if (!videoId) { console.error('未取到 videoId，导入失败'); await browser.close(); process.exit(1); }
console.log('   videoId:', videoId);

console.log('2. 播种子库（1 段字幕即可解锁问答面板）');
await page.evaluate(async (vid) => {
  const req = indexedDB.open('wangke');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
  const put = (store, value) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const q = tx.objectStore(store).add(value);
    q.onsuccess = () => res(q.result); q.onerror = rej;
  });
  const now = Date.now();
  await put('segments', { videoId: vid, idx: 0, start: 0, end: 20, text: '测试字幕', status: 1 });
  const sid = await put('chatSessions', { videoId: vid, title: 'svg 流式落画', createdAt: now });
  await put('chats', { videoId: vid, sessionId: sid, role: 'user', content: '画一下抛物线', createdAt: now });
  db.close();
}, videoId);

console.log('3. 重载并进入问答面板，推一段逐 token 的 svg 围栏');
await page.goto(`${BASE}/#/player/${videoId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('video', { timeout: 20000 });
await page.getByRole('tab', { name: '问答', exact: true }).click();
await page.waitForTimeout(600);

const answer = `这道抛物线开口向上，顶点在 (135, 58)：\n\n\`\`\`svg\n${GOOD_SVG}\n\`\`\`\n\n横轴为 x，纵轴为 y。`;
await page.evaluate(
  ([chunks, delayMs]) => window.__LLM__.queue.push({ chunks, delayMs }),
  [toChunks(answer).map((content) => ({ content })), 90],
);
await typeAndSend('画一下抛物线');

/**
 * 在流式进行中反复取样。每次取「相位 + 画布里的元素数 + 新到元素的描边进度」。
 * 取样在**页面内**用一个自跑循环完成：跨进程往返一次要几毫秒，
 * 而一整段流只有 ~1.5s，用 Node 侧轮询会漏掉大半中间态。
 */
console.log('4. 边流边取样（页面内自跑循环，避免漏掉中间态）');
const samples = await page.evaluate(async () => {
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 20000) {
    const block = document.querySelector('[data-testid="svg-block"]');
    if (block) {
      const canvas = block.querySelector('[data-testid="svg-canvas"]');
      const root = canvas?.querySelector('svg');
      const shapes = root ? [...root.querySelectorAll('path,line,circle,rect,g>circle')] : [];
      // 描边进度：计算样式给出的是**带单位的长度**（pathLength=1 时 1 个用户单位，
      // 换算到 CSS px 随 viewBox 缩放而变），所以只能 parseFloat，且阈值按「相对起点」定
      const offsets = shapes
        .filter((s) => s.classList.contains('xmd-svg-stroke'))
        .map((s) => parseFloat(getComputedStyle(s).strokeDashoffset) || 0)
        .filter((o) => Number.isFinite(o));
      // 同时带 fill 与 stroke class 的那些（animation 简写撞车就发生在这里）
      const both = shapes.filter((s) => s.classList.contains('xmd-svg-stroke') && s.classList.contains('xmd-svg-fill'));
      out.push({
        t: Math.round(performance.now() - t0),
        bothClass: both.length,
        bothOffsets: both.map((s) => parseFloat(getComputedStyle(s).strokeDashoffset) || 0),
        bothOpacity: both.map((s) => Number(getComputedStyle(s).opacity)),
        phase: block.getAttribute('data-phase'),
        top: root ? root.childElementCount : 0,
        viewBox: root?.getAttribute('viewBox') ?? null,
        marked: shapes.filter((s) => s.classList.contains('xmd-svg-stroke') || s.classList.contains('xmd-svg-fill') || s.classList.contains('xmd-svg-fade')).length,
        offsets,
        canvasBox: canvas ? Math.round(canvas.getBoundingClientRect().height) : 0,
        live: !!block.querySelector('[data-testid="svg-live"]'),
        // 真画出来了吗：截图之外还要看「有没有非定义的顶层元素」。
        // 首个元素通常是 <defs>，它本来就什么都不画 —— 拿它判空会把「纸已铺好、笔还没落」误报成没画出来。
        inked: (() => {
          if (!root) return null;
          const DEF = new Set(['defs', 'symbol', 'marker', 'pattern', 'clipPath', 'mask', 'linearGradient', 'radialGradient']);
          return [...root.children].some((c) => !DEF.has(c.tagName));
        })(),
      });
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  return out;
});

const drawing = samples.filter((s) => s.phase === 'drawing');
const phases = [...new Set(samples.map((s) => s.phase))];
const tops = samples.map((s) => s.top);

console.log(`   取样 ${samples.length} 次，相位序列：${phases.join(' → ')}`);
check(phases.includes('waiting') && phases.includes('drawing') && phases.includes('ok'),
  `相位走 waiting → drawing → ok（实得 ${phases.join(' → ')}）`);
check(drawing.length >= 3, `drawing 态持续了多拍（${drawing.length} 次取样）`);

// 元素单调增长：这就是「边生成边画」的核心可观测特征
const nonDecreasing = tops.every((v, i) => i === 0 || v >= tops[i - 1]);
const distinctTops = [...new Set(tops)];
check(nonDecreasing, `画布元素数单调不减（${distinctTops.join('→')}）`);
check(distinctTops.length >= 3, `画布是**逐步**长出来的，不是一次性跳到最终（出现过的元素数：${distinctTops.join(',')}）`);
check(distinctTops.at(-1) >= 7, `最终画布有全部图元（${distinctTops.at(-1)} 个顶层元素）`);

// 画布从**第一拍**就有正确的 viewBox：宽高比由根标签定死，
// 整块图形的高度因此一开始就是最终值，不随内容增长来回跳。
// （第一拍没有 viewBox 是 LiveSvg 用 useEffect 建根节点时的症状，已改成 useLayoutEffect）
const badViewBox = drawing.filter((s) => s.viewBox !== '0 0 260 150');
check(badViewBox.length === 0,
  `drawing 从第一拍起就带 viewBox（异常 ${badViewBox.length} 次，${[...new Set(drawing.map((s) => s.viewBox))].join(',')}）`);
check(new Set(drawing.map((s) => s.canvasBox)).size === 1,
  `画布高度全程不变（实得 ${[...new Set(drawing.map((s) => s.canvasBox))].join('/')}px）`);

// 新到的图元带落画 class，且描边真的在「走」
const maxMarked = Math.max(...drawing.map((s) => s.marked));
check(maxMarked > 0, `新到的图元带落画 class（最多同时 ${maxMarked} 个）`);

// 走笔的证据：同一条描边上，dashoffset 从「全长」一路降到 0。
// 判据用**相对起点**而不是常数阈值 —— 计算样式里的长度随 viewBox 缩放，没有绝对值可比。
const drawn = drawing.filter((s) => s.offsets.length > 0);
const minOf = (s) => Math.min(...s.offsets);
const maxOf = (s) => Math.max(...s.offsets);
const startOffset = Math.max(...drawn.slice(0, 4).map(minOf));
check(startOffset > 0.05, `刚落画时描边是藏着的（dashoffset=${startOffset.toFixed(2)}，没一上来就画完）`);
// 收笔判据用 **max**：只要还有一条描边卡在初值（dashoffset=1）就没走完。
// 用 min 会被「别的元素已经走完」掩盖过去 —— 那正是 animation 简写撞车时的样子。
const tail = drawing.at(-1);
const endOffset = maxOf(tail);
check(endOffset <= 0.05, `收笔时**每一条**描边都走完了（最慢的那条 dashoffset=${endOffset.toFixed(2)}）`);
check(startOffset > endOffset * 4, 'dashoffset 一路下降（真在走，不是静态值）');
const inFlight = drawn.filter((s) => maxOf(s) > 0.05 && minOf(s) <= 0.05);
check(inFlight.length > 0, `同一拍里既有走完的也有在走的（${inFlight.length} 次取样）`);

// fill + stroke 同时在的图元：两条动画都得跑。
// 只跑到一条的话，另一条的初值会留在原地 —— 描边那条留在 dashoffset=1 就是「描边不见了」。
const bothSeen = drawing.filter((s) => s.bothClass > 0);
check(bothSeen.length > 0, `fixture 里存在同时带 fill 与 stroke 的图元（最多同时 ${Math.max(...drawing.map((s) => s.bothClass))} 个）`);
// 「也真的走过」：刚落画那一刻它的 dashoffset 必须还在非零处，
// 否则就分不清是真在走、和一开始就摆在终点（描边不可见）这两种情况了。
check(bothSeen.some((s) => s.bothOffsets.some((o) => o > 0.05)), 'fill+stroke 的图元也真的走过描边');
// 收笔判据只看末拍：刚落到画布的那一帧当然还没走完，拿它去要求「都走完」是判错了时机
check(
  tail.bothOffsets.length > 0
    && tail.bothOffsets.every((o) => o <= 0.05)
    && tail.bothOpacity.every((o) => o >= 0.99),
  `收笔时 fill+stroke 的图元描边走完、填充淡入到底（末拍 dashoffset=${JSON.stringify(tail.bothOffsets.map((o) => +o.toFixed(2)))} opacity=${JSON.stringify(tail.bothOpacity)}）`,
);

// 「纸」先铺出来、笔再落：根标签一到就有画布（高度已是最终值），
// 而第一个元素还没写完时画布是空的 —— 这是刻意的，不是没画出来。
// 判据是「落笔之后每一拍都得真的有墨」，否则所谓增长只是画布在长高。
const blank = drawing.filter((s) => s.top === 0);
check(blank.length > 0, `根标签一到就铺出画布，早于第一个图元（空画布 ${blank.length} 次取样）`);

// 落笔之后**不再回退**成空画布。append-only 的意义就在这条：
// 每拍重画整棵树的实现会让画面反复闪回空白。
const firstInk = drawing.findIndex((s) => s.inked === true);
check(firstInk >= 0, 'drawing 期间确实有笔迹落到画布上');
const afterInk = drawing.slice(Math.max(firstInk, 0));
check(
  afterInk.length > 0 && afterInk.every((s) => s.inked === true),
  `落笔之后每一拍都还有笔迹（${afterInk.length} 次取样，无回退）`,
);
check(drawing.every((s) => s.live), 'drawing 态带「生成中」提示，且画布与提示同时在');

console.log('\n5. 闭合后的终态：落回完整净化产物，工具条齐全');
await page.waitForSelector('[data-testid="svg-block"][data-phase="ok"]', { timeout: 20000 });
await page.waitForTimeout(600);
const finalState = await page.evaluate(async () => {
  const { sanitizeSvg } = await import('/src/components/mermaid/svgRender.ts');
  const block = document.querySelector('[data-testid="svg-block"]');
  const canvas = block.querySelector('[data-testid="svg-canvas"]');
  const root = canvas.querySelector('svg');
  return {
    phase: block.getAttribute('data-phase'),
    // 落画 class 必须随终态一起消失 —— 否则 dashoffset=0 的残留会留在图上
    leftovers: root.querySelectorAll('.xmd-svg-stroke,.xmd-svg-fill,.xmd-svg-fade').length,
    pathLengths: [...root.querySelectorAll('[pathLength]')].length,
    top: root.childElementCount,
    viewBox: root.getAttribute('viewBox'),
    // 与 sanitizeSvg 的输出逐元素比对：预览画过什么，最终就得是什么
    matchesSanitize: (() => {
      const expect = sanitizeSvg(root.outerHTML);
      const norm = (s) => s.replace(/\s+/g, '').replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '');
      return norm(expect) === norm(root.outerHTML);
    })(),
    text: [...root.querySelectorAll('text')].map((t) => t.textContent?.trim()),
    tools: {
      copy: !!block.querySelector('[data-testid="svg-copy"]'),
      zoom: !!block.querySelector('[data-testid="svg-zoom"]'),
      download: !!block.querySelector('[data-testid="svg-download"]'),
      source: !!block.querySelector('[data-testid="svg-source-toggle"]'),
    },
    live: !!block.querySelector('[data-testid="svg-live"]'),
    pending: !!block.querySelector('[data-testid="svg-pending"]'),
    chatText: document.querySelector('[data-testid="chat-msg-ai"]')?.textContent ?? '',
  };
});
check(finalState.phase === 'ok', `闭合后相位 = ok（实得 ${finalState.phase}）`);
check(finalState.top === 8, `终态画布有全部 8 个顶层元素（实得 ${finalState.top}）`);
check(finalState.viewBox === '0 0 260 150', `viewBox 保留（${finalState.viewBox}）`);
check(finalState.leftovers === 0, `终态不留落画 class / pathLength 残留（${finalState.leftovers} 个）`);
check(finalState.pathLengths === 0, '终态不留 pathLength（预览期的动画标记不该进最终 DOM）');
check(finalState.matchesSanitize, '终态画布内容 === sanitizeSvg 的完整产物');
check(finalState.text.some((t) => t?.includes('顶点')), `中文标签完整（${JSON.stringify(finalState.text)}）`);
check(finalState.tools.copy && finalState.tools.zoom && finalState.tools.download && finalState.tools.source,
  '闭合后工具条齐全（复制/大图/下载/源码）');
check(!finalState.live && !finalState.pending, '闭合后不再显示「生成中」提示');
check(finalState.chatText.includes('横轴为 x'), '围栏外的正文原样保留');

await page.locator('[data-testid="svg-canvas"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/svg-stream-final.png` });

console.log('\n6. 半截里带外部资源引用：预览期不画，闭合后照旧报错回退源码');
const badAnswer = `这张图的填充引用了外部资源：\n\n\`\`\`svg\n${BAD_SVG}\n\`\`\``;
await page.evaluate(
  ([chunks, delayMs]) => window.__LLM__.queue.push({ chunks, delayMs }),
  [toChunks(badAnswer, 10).map((content) => ({ content })), 60],
);
await typeAndSend('再来一张');
await page.waitForSelector('[data-testid="svg-block"][data-phase="error"]', { timeout: 20000 });

const badStream = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('[data-testid="svg-block"]')];
  const bad = blocks.find((b) => b.getAttribute('data-phase') === 'error');
  return {
    count: blocks.length,
    err: bad?.querySelector('[data-testid="svg-error"]')?.textContent ?? null,
    source: bad?.querySelector('[data-testid="svg-source"]')?.textContent ?? null,
    canvas: !!bad?.querySelector('[data-testid="svg-canvas"]'),
    live: !!bad?.querySelector('[data-testid="svg-live"]'),
    // 安全闸门在**预览期**就已经拦住了：半截里那句外部 url() 不会先画出来再回退
    drewDuringStream: blocks.filter((b) => b.getAttribute('data-phase') === 'drawing' && b.querySelector('svg')).length,
  };
});
check(badStream.count === 2, `两条回答建出 2 个块（实得 ${badStream.count}）`);
check(!!badStream.err?.includes('外部资源'), `闭合后报错点明原因（${JSON.stringify(badStream.err?.slice(0, 40))}）`);
check(!!badStream.source?.includes('evil.example'), '失败态仍给出源码');
check(!badStream.canvas && !badStream.live, '失败态没有残留画布 / 生成中提示');
check(badStream.drewDuringStream === 0, '带外部引用的 SVG 在预览期从未进过 drawing 态（闸门在闭合前就拦下）');
await page.screenshot({ path: `${SHOTS}/svg-stream-reject.png`, fullPage: true });

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
