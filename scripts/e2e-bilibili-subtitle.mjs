/* eslint-disable no-console */
// B 站自带字幕链路 e2e：解析（语言列表 + 默认勾选）→ 导入（视频重封装 + 字幕落库）→
// 播放页字幕列表 → 切「对照语言」中英同屏（面板 + 画面字幕）。
//
// 用法：BASE_URL=http://localhost:5173 node scripts/e2e-bilibili-subtitle.mjs
// 需先 npm run dev（5173）。**需要能直连 B 站**（默认视频 BV1GJ411x7h7 的 12 路字幕），
// 因此 e2e-all 里默认 skip —— 它验证的是真接口而不是桩，值得单独跑。
//
// 设计：页面里那层「油猴桥」用 playwright 的 exposeFunction 转发到 Node 侧 fetch，
// 这样既走了应用真实的 transport/bridge 契约，又绕开页面 CORS。
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const BVID = process.env.BVID || 'BV1GJ411x7h7';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let failed = 0;
const ok = (m) => console.log(`   ✓ ${m}`);
const fail = (m) => { failed++; console.error(`   ❌ ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

// Node 侧真实转发（避开页面 CORS）
await page.exposeFunction('__biliRelay', async (p) => {
  const headers = { Referer: 'https://www.bilibili.com', 'User-Agent': UA, ...(p.headers || {}) };
  if (p.cookie) headers.Cookie = p.cookie;
  const res = await fetch(p.url, {
    method: p.method || 'GET',
    headers,
    body: p.bodyB64 ? Buffer.from(p.bodyB64, 'base64') : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers), bodyB64: buf.toString('base64') };
});

await page.addInitScript(() => {
  localStorage.setItem('wangke-settings', JSON.stringify({ state: { apiKey: 'sk-fake-e2e' }, version: 1 }));
  const enc = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const dec = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  window.__wangkeBiliBridge = {
    version: '2.1.1-e2e',
    async fetch(url, init = {}) {
      const r = await window.__biliRelay({
        url, method: init.method || 'GET',
        bodyB64: init.body ? enc(init.body) : '',
        headers: init.headers || {}, cookie: init.cookie || '',
      });
      const buf = dec(r.bodyB64);
      const text = () => Promise.resolve(new TextDecoder().decode(buf));
      return { ok: r.ok, status: r.status, headers: r.headers, json: () => text().then((t) => JSON.parse(t)), text, arrayBuffer: () => Promise.resolve(buf.buffer) };
    },
    async getCookie() { return 'SESSDATA=e2e-fake; bili_jct=e2e'; },
  };
});

await page.goto(BASE, { waitUntil: 'networkidle' });
console.log('\n1. 解析：对话框应按优先级默认勾选语言');
await page.click('[data-testid="btn-bili-import"]');
await page.waitForTimeout(800);
// mdui-text-field 的 value 是元素属性（不是原生 input），用属性 + input 事件模拟输入
await page.$eval('[data-testid="bili-url"]', (el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, BVID);
await page.waitForTimeout(200);
await page.click('[data-testid="bili-confirm"]');
await page.waitForSelector('[data-testid="bili-lang"]', { timeout: 30000 });
const chips = await page.$$eval('[data-testid="bili-lang"]', (els) => els.map((e) => ({ lang: e.dataset.lang, doc: e.textContent.trim(), selected: !!e.selected })));
console.log('   语言：', chips.map((c) => `${c.lang}${c.selected ? '[✓]' : ''}`).join(' '));
check(chips.length >= 4, `解析出 ${chips.length} 种自带字幕`);
const pageChips = await page.locator('[data-testid="bili-page"]').count();
check(pageChips === 0, `单 P 视频不显示分 P 列表（实际 ${pageChips}）`);
const picked = chips.filter((c) => c.selected).map((c) => c.lang);
check(picked.length === 2, `默认勾选 2 路（实际 ${JSON.stringify(picked)}）`);
check(picked[0].startsWith('zh'), `第一路是中文（${picked[0]}）`);
check(picked[1].startsWith('en'), `第二路是英文（${picked[1]}）`);

console.log('\n2. 导入：视频 + 所选字幕落库');
await page.click('[data-testid="bili-confirm"]');
await page.waitForSelector('[data-testid="video-item"]', { timeout: 300000 });
await page.waitForTimeout(1500);
const dbState = await page.evaluate(async () => {
  const { db } = await import('/src/store/db.ts');
  const videos = await db.videos.toArray();
  const v = videos[videos.length - 1];
  const segs = await db.segments.where('videoId').equals(v.id).toArray();
  const tracks = await db.subtitleTracks.where('videoId').equals(v.id).toArray();
  return { name: v.name, status: v.status, size: v.size, segs: segs.length, firstSeg: segs.sort((a, b) => a.idx - b.idx)[0], tracks: tracks.map((t) => ({ lang: t.lang, lanDoc: t.lanDoc, primary: t.primary, cues: t.cues.length })) };
});
console.log('   ', JSON.stringify(dbState).slice(0, 400));
check(dbState.status === 'transcribed', '视频状态 = transcribed（AI 面板已解锁）');
check(dbState.segs > 20, `segments 已写入（${dbState.segs} 行，主语言）`);
check(dbState.tracks.length === 2, 'subtitleTracks 写了 2 路');
check(dbState.tracks.filter((t) => t.primary === 1).length === 1, '只有一路标记为主语言');

console.log('\n3. 播放页：字幕列表 + 「对照语言」叠加');
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 30000 });
await page.waitForSelector('[data-testid="subs-row"]', { timeout: 30000 });
const rows = await page.locator('[data-testid="subs-row"]').count();
check(rows > 20, `字幕列表 ${rows} 行`);
const firstLine = (await page.locator('[data-testid="subs-row"] .sub-item__text').first().innerText()).trim();
check(!firstLine.includes('\n'), `未选对照语言时单行（${JSON.stringify(firstLine)}）`);

const compareOptions = await page.$$eval('[data-testid="subs-compare"] mdui-menu-item', (els) => els.map((e) => e.value));
console.log('   对照语言选项：', JSON.stringify(compareOptions));
const en = compareOptions.find((v) => v && v.startsWith('en'));
check(!!en, '对照下拉里有英文轨');

await page.click('[data-testid="subs-compare"]');
await page.waitForTimeout(400);
await page.click(`mdui-menu-item[value="${en}"]`);
await page.waitForTimeout(1000);
const allTexts = await page.locator('[data-testid="subs-row"] .sub-item__text').allInnerTexts();
check(allTexts.filter((t) => t.includes('\n')).length > 10, `多数行合成两行（${allTexts.filter((t) => t.includes('\n')).length}/${allTexts.length}）`);
// 第 0 行没有对照是正常的：en-US 轨道的第一条 cue 从 18.788s 才开始（前奏没翻译）
const withEn = allTexts.find((t) => t.includes('Were no strangers to love'));
console.log('   中文行 + 英文行：', JSON.stringify(withEn));
check(!!withEn && withEn.split('\n').length === 2, '同屏两行（中文 + 英文）');
check(withEn.split('\n')[1].startsWith('Were no strangers'), '第二行是对照语言');

// 画面字幕（播放器轨由 VTTCue 文本里的 \n 渲染成两行）
await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.currentTime = 19.5; void v.play(); } });
await page.waitForTimeout(1500);
const caption = await page.evaluate(() => {
  const el = document.querySelector('.vds-captions');
  return el ? el.innerText.trim() : '';
});
console.log('   画面字幕：', JSON.stringify(caption.slice(0, 160)));
check(caption.includes('Were no strangers'), '画面字幕含对照语言');
check(caption.split('\n').length >= 2, '画面字幕同为两行');

console.log('\n4. 多分 P 合集：分 P 多选 + 语言跟随 + 命名');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('[data-testid="btn-bili-import"]');
await page.waitForTimeout(800);
await page.$eval('[data-testid="bili-url"]', (el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, 'https://www.bilibili.com/video/BV1h7pteyEww');
await page.click('[data-testid="bili-confirm"]');
await page.waitForSelector('[data-testid="bili-page"]', { timeout: 60000 });

const pages = await page.$$eval('[data-testid="bili-page"]', (els) => els.map((e) => ({ page: Number(e.dataset.page), selected: !!e.selected })));
check(pages.length === 94, `解析出 94 个分 P（实际 ${pages.length}）`);
const sel = pages.filter((p) => p.selected).map((p) => p.page);
check(sel.length === 1 && sel[0] === 1, `默认只勾第一个分 P（实际 ${JSON.stringify(sel)}）`);
const summary = (await page.textContent('[data-testid="bili-summary"]')) ?? '';
check(summary.includes('共 94 P') && summary.includes('已选 1 P') && summary.includes('3 分 21 秒'), `摘要显示合集规模与合计时长（${summary}）`);

// 切到 P2：语言列表应按 P2 刷新（每个分 P 的 cid 不同）
await page.click('[data-testid="bili-page"][data-page="2"]');
await page.waitForFunction(
  () => (document.querySelector('[data-testid="bili-summary"]')?.textContent ?? '').includes('已选 2 P'),
  undefined,
  { timeout: 15000 },
);
const summary2 = (await page.textContent('[data-testid="bili-summary"]')) ?? '';
check(summary2.includes('30 分 42 秒'), `勾上 P2 后合计变 30 分 42 秒（P1 201s + P2 1641s）（${summary2}）`);
const langChips = await page.$$eval('[data-testid="bili-lang"]', (els) => els.map((e) => e.dataset.lang));
check(langChips.includes('ai-zh'), `语言列表按 P 刷新（${langChips.join(',') || '空'}）`);

// 清空 → 只勾 P1（回到可导入状态）
await page.click('[data-testid="bili-pages-none"]');
await page.waitForTimeout(400);
const cleared = (await page.textContent('[data-testid="bili-summary"]')) ?? '';
check(cleared.includes('已选 0 P'), `清空后已选 0 P（${cleared}）`);
await page.click('[data-testid="bili-page"][data-page="1"]');
await page.waitForTimeout(600);

// 导入 P1（201s，体积最小），断言命名带「P1 分P名」
await page.click('[data-testid="bili-confirm"]');
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="video-item"]').length >= 2,
  undefined,
  { timeout: 300000 },
);
await page.waitForTimeout(1200);
const names = await page.$$eval('[data-testid="video-item"]', (els) => els.map((e) => e.innerText.replace(/\n/g, ' ')));
console.log('   视频行：', JSON.stringify(names.map((n) => n.slice(0, 46))));
check(names.some((n) => n.includes('P1 线性代数视频2.0版 说明')), '新视频命名带「P1 分P名」，不会和别的 P 撞名');

const multiPageDb = await page.evaluate(async () => {
  const { db } = await import('/src/store/db.ts');
  const videos = await db.videos.orderBy('createdAt').reverse().toArray();
  const v = videos[0];
  const segs = await db.segments.where('videoId').equals(v.id).count();
  return { name: v.name, segs };
});
console.log('   落库：', JSON.stringify(multiPageDb));
check(multiPageDb.segs > 10, `该分 P 的字幕已落库（${multiPageDb.segs} 行）`);

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed > 0 ? 1 : 0);
