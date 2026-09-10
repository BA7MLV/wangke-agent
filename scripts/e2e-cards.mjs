/* eslint-disable no-console */
// E2E：Anki 滑动制卡（无需 API key，自播种字幕 + 卡片数据）。
// 验证：1) 桌面：卡栈渲染 / 按钮保留·翻面·丢弃·撤销 / 已保留列表移除 / 导出 .apkg（Node 侧解包校验 SQLite）
//      2) 重新生成的确认弹窗
//      3) 移动端：底部 Tab「卡片」+ CDP 触摸右滑保留
// 用法：npm run preview &  然后 node scripts/e2e-cards.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import initSqlJs from 'sql.js';
import { unzipSync } from 'fflate';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const VIDEO_ID = 'e2e-cards-vid';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✅ ${msg}`);

/** 种入一条已转写视频 + 3 条字幕 + 3 张卡片（2 待审 1 已留） */
async function seed(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
  await page.evaluate(async (videoId) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('wangke');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const tx = db.transaction(['videos', 'segments', 'cards'], 'readwrite');
    tx.objectStore('videos').put({
      id: videoId,
      name: '测试课程.mp4',
      size: 1,
      mimeType: 'video/mp4',
      duration: 300,
      createdAt: Date.now(),
      status: 'transcribed',
    });
    const segs = tx.objectStore('segments');
    for (let i = 0; i < 3; i++)
      segs.add({ videoId, idx: i, start: i * 60, end: i * 60 + 55, text: `字幕内容 ${i}`, status: 1 });
    const cards = tx.objectStore('cards');
    cards.add({ videoId, q: '候选卡甲：光合作用的场所是？', a: '叶绿体', time: 65, status: 0, createdAt: 1 });
    cards.add({ videoId, q: '候选卡乙：线粒体的功能是？', a: '细胞供能', time: 125, status: 0, createdAt: 2 });
    cards.add({ videoId, q: '已留卡：细胞核的作用是？', a: '遗传信息库', time: 185, status: 1, createdAt: 3 });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, VIDEO_ID);
}

/** 顶卡问题文本（等飞出动画结束后读取） */
const topText = (page) =>
  page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el?.textContent || '';
    },
    '.deck-card.is-top .deck-face.front .face-text',
    { timeout: 8000 },
  );

// ── 场景 1：桌面端完整审核 + 导出 ────────────────────────────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  await seed(page);
  console.log('1. 进入卡片面板（桌面 Tabs）');
  await page.goto(`${BASE}/#/player/${VIDEO_ID}`, { waitUntil: 'networkidle' });
  await page.click('[data-testid="panel-tab-cards"]');
  await page.waitForSelector('.deck-card.is-top', { timeout: 10000 });

  const t0 = await (await topText(page)).jsonValue();
  if (t0.includes('候选卡甲')) ok('卡栈顶卡为第一张待审卡');
  else fail(`顶卡不符：${t0}`);

  const exportBtn = page.locator('[data-testid="cards-export"]');
  if ((await exportBtn.textContent())?.includes('（1）')) ok('导出按钮带保留计数（1）');
  else fail(`导出按钮计数不符：${await exportBtn.textContent()}`);

  console.log('2. 点「保留」→ 顶卡切到第二张，计数变 2');
  await page.click('[data-testid="swipe-keep"]');
  await page.waitForFunction(
    () => document.querySelector('.deck-card.is-top .deck-face.front .face-text')?.textContent?.includes('候选卡乙'),
    { timeout: 8000 },
  );
  ok('顶卡切换为候选卡乙');
  if ((await exportBtn.textContent())?.includes('（2）')) ok('导出计数（2）');
  else fail(`导出计数未更新：${await exportBtn.textContent()}`);

  console.log('3. 点「翻面」→ 显示答案与来源时间戳');
  await page.click('[data-testid="swipe-swap"]');
  await page.waitForSelector('.deck-inner.flipped', { timeout: 5000 });
  const back = await page.locator('.deck-card.is-top .deck-face.back').textContent();
  if (back?.includes('细胞供能') && back?.includes('[2:05]')) ok('背面含答案与 [2:05] 来源');
  else fail(`背面内容不符：${back}`);

  console.log('4. 点「丢弃」→ 待审清空，出现审核汇总');
  await page.click('[data-testid="swipe-drop"]');
  await page.waitForFunction(() => document.body.textContent?.includes('审核完成：保留 2 · 丢弃 1'), { timeout: 8000 });
  ok('汇总：保留 2 · 丢弃 1');

  console.log('5. 撤销 → 候选卡乙回到待审；再保留 → 汇总 保留 3 · 丢弃 0');
  await page.click('[data-testid="cards-undo"]');
  await page.waitForFunction(
    () => document.querySelector('.deck-card.is-top .deck-face.front .face-text')?.textContent?.includes('候选卡乙'),
    { timeout: 8000 },
  );
  await page.click('[data-testid="swipe-keep"]');
  await page.waitForFunction(() => document.body.textContent?.includes('审核完成：保留 3 · 丢弃 0'), { timeout: 8000 });
  ok('撤销 + 重新保留成功');

  console.log('6. 已保留列表「移除」候选卡乙 → 汇总 保留 2 · 丢弃 1');
  await page
    .locator('.sub-item', { hasText: '候选卡乙' })
    .locator('[aria-label="移除"]')
    .click();
  await page.waitForFunction(() => document.body.textContent?.includes('审核完成：保留 2 · 丢弃 1'), { timeout: 8000 });
  ok('移除生效');

  console.log('7. 导出 .apkg → 校验文件名与包内 SQLite');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    exportBtn.click(),
  ]);
  const fname = download.suggestedFilename();
  if (fname === '测试课程.apkg') ok(`文件名 ${fname}`);
  else fail(`文件名不符：${fname}`);
  const buf = await fs.readFile(await download.path());
  const entries = unzipSync(new Uint8Array(buf));
  assert.ok(entries['collection.anki2'], '缺 collection.anki2');
  const SQL = await initSqlJs();
  const db = new SQL.Database(entries['collection.anki2']);
  const noteCount = db.exec('SELECT COUNT(*) FROM notes')[0].values[0][0];
  const flds = db.exec('SELECT flds FROM notes ORDER BY id')[0].values.map((r) => r[0]);
  db.close();
  if (noteCount === 2 && flds.some((f) => String(f).includes('叶绿体')) && flds.every((f) => !String(f).includes('候选卡乙'))) {
    ok('apkg 含 2 张保留卡，已移除卡不在其中');
  } else fail(`apkg 内容不符：count=${noteCount}`);

  console.log('8. 「重新生成卡片」弹确认框，取消后数据不变');
  // mdui 的 dialog() 自己 new 组件挂到 body、插不进属性 —— 用 confirmDialog 注入的标记元素定位；
  // 按钮顺序固定为「先取消、后确认」，取消永远是第一个 action
  await page.click('[data-testid="cards-generate"]');
  const regenDlg = page.locator('mdui-dialog:has([data-testid="confirm-dialog-danger"])');
  await regenDlg.waitFor({ state: 'attached', timeout: 5000 });
  await regenDlg.locator('mdui-button[slot="action"]').first().click();
  await page.waitForFunction(() => document.body.textContent?.includes('审核完成：保留 2 · 丢弃 1'), { timeout: 5000 });
  ok('确认弹窗取消后数据不变');
  await ctx.close();
}

// ── 场景 2：移动端底部 Tab + 触摸右滑保留 ────────────────────────────────────
{
  console.log('9. 移动端：底部 Tab「卡片」+ CDP 触摸右滑保留');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  await seed(page);
  await page.goto(`${BASE}/#/player/${VIDEO_ID}`, { waitUntil: 'networkidle' });
  await page.click('[data-testid="panel-tab-cards"]');
  await page.waitForSelector('.deck-card.is-top', { timeout: 10000 });
  ok('移动端卡栈渲染');

  const cdp = await ctx.newCDPSession(page);
  const box = await page.locator('.deck-card.is-top').boundingBox();
  const y = box.y + box.height / 2;
  const startX = box.x + box.width / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y, id: 1 }] });
  for (let dx = 8; dx <= 200; dx += 24) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX + dx, y, id: 1 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(
    () => document.querySelector('.deck-card.is-top .deck-face.front .face-text')?.textContent?.includes('候选卡乙'),
    { timeout: 8000 },
  );
  const label = await page.locator('[data-testid="cards-export"]').textContent();
  if (label?.includes('（2）')) ok('触摸右滑保留成功，计数（2）');
  else fail(`右滑后计数不符：${label}`);
  await ctx.close();
}

await browser.close();
if (process.exitCode) process.exit(process.exitCode);
console.log('\n全部通过');
