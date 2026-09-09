/* eslint-disable no-console */
// E2E：讲义结构化预览与块级编辑（无需 API key）。
// 种入视频记录 + 字幕 + 幻灯片帧 + 带 sectionsJson 的讲义，验证：
// 1) 讲义按 IR 结构化渲染（公文样式类名 / 三线表 / 插图 / 编号）
// 2) 桌面 hover → 编辑段落 → 保存后 DOM 更新，且 DB 中 sectionsJson 更新、DOCX blob 被重建
// 3) hover → 「AI 改写」面板展开（预设 chips + 自由输入），无 key 时点击预设给出错误提示
// 4) 触摸端左滑手势露出操作按钮（CDP 触摸事件）
// 5) 旧版无 IR 讲义 → 回退只读预览 + 升级提示
// 用法：npm run preview &  然后 node scripts/e2e-handout-edit.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const VIDEO_ID = 'e2e-hd-edit-vid';
const LEGACY_VIDEO_ID = 'e2e-hd-legacy-vid';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✅ ${msg}`);

const SECTIONS = [
  {
    heading: '极限的概念',
    blocks: [
      { type: 'lead', text: '本节介绍极限的定义与几何意义。' },
      { type: 'para', text: '极限是描述函数在某点附近变化趋势的工具。' },
      { type: 'h2', text: '极限的定义' },
      { type: 'list', ordered: true, items: ['给定任意小的正数', '存在对应的邻域', '函数值落入该邻域'] },
      { type: 'table', caption: '符号对照', header: ['符号', '含义'], rows: [['ε', '任意小正数'], ['δ', '对应邻域半径']] },
      { type: 'figure', ts: 10, caption: '极限的几何意义' },
      { type: 'note', text: '注意区分左极限与右极限。' },
    ],
  },
  {
    heading: '极限的运算',
    blocks: [
      { type: 'lead', text: '本节讲极限的四则运算法则。' },
      { type: 'para', text: '两个收敛函数的和的极限等于极限的和。' },
    ],
  },
];
const OUTLINE = {
  title: '微积分极限学习讲义',
  summary: '本课程讲授极限的定义、几何意义与运算法则。',
  sections: [
    { heading: '极限的概念', start: '00:00', end: '05:00', points: ['极限定义'] },
    { heading: '极限的运算', start: '05:00', end: '10:00', points: ['四则运算'] },
  ],
};

async function seed(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
  await page.evaluate(
    async ({ videoId, legacyId, sections, outline }) => {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open('wangke');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      // 造一张 640x360 的 JPEG 帧
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#2b5cab';
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff';
      ctx.font = '32px sans-serif';
      ctx.fillText('极限的几何意义', 40, 180);
      const frameBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));

      const tx = db.transaction(['videos', 'segments', 'frames', 'handouts'], 'readwrite');
      for (const [id, name] of [
        [videoId, '微积分第一课.mp4'],
        [legacyId, '旧版课程.mp4'],
      ]) {
        tx.objectStore('videos').put({
          id,
          name,
          size: 1,
          mimeType: 'video/mp4',
          duration: 600,
          createdAt: Date.now(),
          status: 'transcribed',
        });
        tx.objectStore('segments').add({ videoId: id, idx: 0, start: 0, end: 5, text: '这是字幕内容', status: 1 });
      }
      tx.objectStore('frames').add({ videoId, ts: 10, blob: frameBlob, kind: 'slide', caption: '极限的几何意义' });
      // 新版：带 IR 的讲义（blob 先放空，编辑保存后由重建管线生成真 DOCX）
      tx.objectStore('handouts').add({
        videoId,
        createdAt: Date.now(),
        title: outline.title,
        blob: new Blob(['placeholder'], { type: 'application/octet-stream' }),
        outlineJson: JSON.stringify(outline),
        sectionsJson: JSON.stringify(sections),
      });
      // 旧版：无 sectionsJson
      tx.objectStore('handouts').add({
        videoId: legacyId,
        createdAt: Date.now(),
        title: '旧版讲义',
        blob: new Blob(['placeholder'], { type: 'application/octet-stream' }),
        outlineJson: JSON.stringify(outline),
      });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
    { videoId: VIDEO_ID, legacyId: LEGACY_VIDEO_ID, sections: SECTIONS, outline: OUTLINE },
  );
}

/** 读 handouts 行（断言落盘结果用） */
async function readHandout(page, videoId) {
  return page.evaluate(async (vid) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('wangke');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return new Promise((res, rej) => {
      const req = db.transaction('handouts', 'readonly').objectStore('handouts').getAll();
      req.onsuccess = () => {
        const row = req.result.find((r) => r.videoId === vid);
        res(row ? { sectionsJson: row.sectionsJson, blobSize: row.blob.size, outlineJson: row.outlineJson } : null);
      };
      req.onerror = () => rej(req.error);
    });
  }, videoId);
}

async function openHandoutTab(page, videoId, mobile = false) {
  await page.goto(`${BASE}/#/player/${videoId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=讲义', { timeout: 15000 });
  if (mobile) {
    await page.click('nav >> text=讲义');
  } else {
    await page.click('.ant-tabs-nav >> text=讲义');
  }
  await page.waitForSelector('.hd-doc', { timeout: 10000 });
}

// ---------- 桌面端 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`页面异常：${e.message}`));
  await seed(page);

  // 1) 结构化渲染
  await openHandoutTab(page, VIDEO_ID);
  try {
    assert.match((await page.textContent('.hd-title')) ?? '', /微积分极限学习讲义/);
    assert.match((await page.textContent('.hd-doc')) ?? '', /本课程讲授极限的定义/);
    assert.match((await page.textContent('.hd-h1')) ?? '', /一、极限的概念/);
    assert.match((await page.textContent('.hd-h2')) ?? '', /（一）极限的定义/);
    await page.waitForSelector('.hd-table th', { timeout: 5000 });
    assert.match((await page.textContent('.hd-table-title')) ?? '', /表 1-1 符号对照/);
    await page.waitForSelector('.hd-figure img', { timeout: 5000 });
    assert.match((await page.textContent('.hd-figcaption')) ?? '', /图 1-1 极限的几何意义/);
    ok('讲义按 IR 结构化渲染（编号 / 三线表 / 插图 / 图注）');
  } catch (e) {
    fail(`结构化渲染断言失败：${e.message}`);
  }

  // 2) hover → 编辑段落 → 保存 → DOM + DB 更新
  // 注意：antd 对两个汉字的按钮自动在字间插空格（「编 辑」），用正则 name 匹配
  try {
    const para = page.locator('.hd-swipe', { hasText: '极限是描述函数在某点附近' });
    await para.hover();
    await para.locator('.hd-hover-actions').getByRole('button', { name: /编\s*辑/ }).click();
    const ta = para.locator('textarea');
    await ta.waitFor({ timeout: 5000 });
    await ta.fill('极限刻画的是函数值无限接近某个确定值的趋势。');
    // 进入编辑态后原文本从 DOM 消失（textarea 的值不在 textContent），para 定位器失效，全局定位编辑器
    await page.locator('.hd-editor').getByRole('button', { name: /保\s*存/ }).click();
    await page.waitForSelector('text=极限刻画的是函数值无限接近', { timeout: 5000 });
    // 等待落盘（后台重建 DOCX）
    let row = null;
    for (let i = 0; i < 20; i++) {
      row = await readHandout(page, VIDEO_ID);
      if (row && row.sectionsJson.includes('极限刻画的是函数值') && row.blobSize > 5000) break;
      await page.waitForTimeout(300);
    }
    assert.ok(row, 'handout 行存在');
    assert.ok(row.sectionsJson.includes('极限刻画的是函数值'), 'sectionsJson 已更新');
    assert.ok(row.blobSize > 5000, `DOCX blob 已重建（实际 ${row.blobSize} 字节）`);
    ok('手动编辑段落：DOM 更新 + sectionsJson 落盘 + DOCX 重建');
  } catch (e) {
    fail(`手动编辑断言失败：${e.message}`);
  }

  // 3) AI 改写面板（无 API key → 错误提示，验证调用路径）
  try {
    const para = page.locator('.hd-swipe', { hasText: '两个收敛函数的和的极限' });
    await para.hover();
    await para.locator('.hd-hover-actions button', { hasText: 'AI 改写' }).click();
    await page.waitForSelector('.hd-ai-panel', { timeout: 5000 });
    const chips = await page.locator('.hd-chip').allTextContents();
    assert.deepEqual(chips, ['更精简', '更详细', '更口语化', '换个说法']);
    await page.click('.hd-chip >> text=更精简');
    await page.waitForSelector('.ant-message-error', { timeout: 8000 });
    ok('AI 改写面板：预设 chips + 自由输入；无 key 时给出错误提示');
  } catch (e) {
    fail(`AI 改写面板断言失败：${e.message}`);
  }

  await ctx.close();
}

// ---------- 旧版无 IR 讲义：回退只读预览 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await seed(page); // 每个 context 有独立 IndexedDB，需各自播种
  await page.goto(`${BASE}/#/player/${LEGACY_VIDEO_ID}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=讲义', { timeout: 15000 });
  await page.click('.ant-tabs-nav >> text=讲义');
  try {
    await page.waitForSelector('text=该讲义由旧版生成', { timeout: 8000 });
    await page.waitForSelector('.docx-preview-container', { timeout: 8000 });
    ok('旧版无 IR 讲义：回退只读预览 + 升级提示');
  } catch (e) {
    fail(`旧版回退断言失败：${e.message}`);
  }
  await ctx.close();
}

// ---------- 移动端断点：底部 Tab + 触控目标 ----------
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`移动端页面异常：${e.message}`));
  await seed(page); // 独立 IndexedDB，需播种
  try {
    await openHandoutTab(page, VIDEO_ID, true);
    await page.waitForSelector('.hd-para', { timeout: 8000 });
    // 触摸端 hover 按钮应隐藏（走左滑）
    const hoverVisible = await page.locator('.hd-hover-actions').first().isVisible();
    assert.equal(hoverVisible, false, '触摸端不渲染 hover 操作按钮');
    ok('移动端：底部 Tab 打开讲义，结构化渲染正常，触摸端无 hover 按钮');

    // 触摸左滑手势（CDP 派发触摸事件）：露出操作按钮
    const cdp = await ctx.newCDPSession(page);
    const target = page.locator('.hd-swipe-content', { hasText: '注意区分左极限与右极限' });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box, '目标块可见');
    console.log('  [debug] note 块 box:', JSON.stringify(box));
    const y = box.y + box.height / 2;
    const startX = box.x + box.width - 20;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y, id: 1 }] });
    for (const dx of [30, 60, 100, 160]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX - dx, y, id: 1 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    const transform = await target.evaluate((el) => el.style.transform);
    assert.match(transform, /translateX\(-136px\)/, `左滑后内容位移（实际 ${transform}）`);
    // 点击滑出的「编辑」→ 出现编辑器
    await target
      .locator('..')
      .locator('.hd-swipe-actions button', { hasText: /编\s*辑/ })
      .click();
    await page.waitForSelector('.hd-editor textarea', { timeout: 5000 });
    ok('触摸左滑：露出「AI 改写 / 编辑」按钮，点击编辑进入编辑器');
  } catch (e) {
    fail(`移动端断言失败：${e.message}`);
  }
  await ctx.close();
}

await browser.close();
console.log('done');
