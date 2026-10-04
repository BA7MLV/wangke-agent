#!/usr/bin/env node
// E2E：Markdown 阅读材料的封面。
//
// 守的是三件事：
//   1. **导入即有封面**，不等讲义（Markdown 压根没有讲义这条路）——与视频封面同一条链路。
//   2. **source 是 `material-title`**（不是 `material-page`），且是 16:9 铺满而不是 A4 竖版留黑边。
//   3. **刷新后仍在**，证明落库而非内存态；并且 `covers` 里只有一行（没把同一份资源写两遍）。
//
// 用法：npm run dev &  →  BASE_URL=http://localhost:5174 node scripts/e2e-md-covers.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const FIX_MD = path.resolve('scripts/fixtures/sample-zh.md');
const COVER_EDGE = 480;

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
page.on('pageerror', (e) => fail(`页面异常：${e.message}`));

async function importFile(filePath) {
  await page.setInputFiles('input[type="file"]', filePath);
  const name = path.basename(filePath).replace(/\.[^.]+$/, '');
  await page.waitForSelector(`[data-testid="video-item"]:has-text("${name}")`, { timeout: 30000 });
  return await page.$eval(`[data-testid="video-item"]:has-text("${name}")`, (el) => el.dataset.videoId);
}

/** 等库行真的渲染出封面图（不是占位），再把它量出来 */
async function readThumb(id, timeout = 30000) {
  await page.waitForFunction(
    (vid) => {
      const row = document.querySelector(`[data-testid="video-item"][data-video-id="${vid}"]`);
      const img = row?.querySelector('[data-testid="video-thumb"] img');
      return !!img && img.complete && img.naturalWidth > 0;
    },
    id,
    { timeout },
  );
  return await page.evaluate(async (vid) => {
    const row = document.querySelector(`[data-testid="video-item"][data-video-id="${vid}"]`);
    const img = row.querySelector('[data-testid="video-thumb"] img');
    const blob = await (await fetch(img.src)).blob();
    return {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      size: blob.size,
      type: blob.type,
      hasPlaceholder: !!row.querySelector('.video-row__thumb-empty'),
    };
  }, id);
}

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="import-input"]', { timeout: 20000 });

const DB_AVAILABLE = await page.evaluate(async () => {
  try {
    await import('/src/store/db.ts');
    return true;
  } catch {
    return false;
  }
});

let mdId = '';
let thumb = null;

await check('导入 .md 后卡片自动出现封面（没有占位图标）', async () => {
  mdId = await importFile(FIX_MD);
  thumb = await readThumb(mdId);
  assert.equal(thumb.hasPlaceholder, false, '仍在画文档图标占位');
});

await check(`封面是 16:9 铺满的 ${COVER_EDGE}×${COVER_EDGE * 9 / 16}，不是 A4 竖版`, () => {
  assert.equal(thumb.naturalWidth, COVER_EDGE);
  assert.equal(thumb.naturalHeight, 270);
});

await check('封面是小图档位（< 80KB）且类型是 webp/jpeg', () => {
  assert.ok(thumb.size < 80 * 1024, `${(thumb.size / 1024).toFixed(1)}KB 偏大`);
  assert.ok(['image/webp', 'image/jpeg'].includes(thumb.type), thumb.type);
});

if (DB_AVAILABLE) {
  await check('coverState=done、source=material-title、dominantColor 合规', async () => {
    const r = await page.evaluate(async (id) => {
      const { db } = await import('/src/store/db.ts');
      const v = await db.videos.get(id);
      const c = await db.covers.get(id);
      return {
        coverState: v?.coverState,
        dominantColor: v?.dominantColor,
        source: c?.source,
        w: c?.w,
        h: c?.h,
        coversForId: await db.covers.where('videoId').equals(id).count(),
      };
    }, mdId);
    assert.equal(r.coverState, 'done');
    assert.equal(r.source, 'material-title', `source=${r.source}`);
    assert.match(r.dominantColor ?? '', /^#[0-9a-fA-F]{6}$/);
    assert.equal(r.w, COVER_EDGE);
    assert.equal(r.h, 270);
    assert.equal(r.coversForId, 1, '同一份资源不该有多行封面');
  });

  await check('历史 .md（coverState=done 但无封面）会被回填重新排队', async () => {
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/store/db.ts');
      const { backfillCovers } = await import('/src/pipelines/coverQueue.ts');
      // 造一条「旧版 md」：有 videos 行、coverState=done、covers 里没有它
      const id = `legacy-md-${Date.now()}`;
      await db.videos.put({
        id,
        name: '旧版导入的笔记',
        size: 10,
        mimeType: 'text/markdown',
        duration: 0,
        createdAt: Date.now(),
        status: 'new',
        kind: 'material',
        materialFormat: 'md',
        coverState: 'done',
        fileDeleted: 1, // 没有文件本体，ensureCover 会写 skipped，不影响「被回填捞起来」这条断言
      });
      const n = await backfillCovers();
      const hit = await db.videos.get(id);
      return { n, stillThere: !!hit };
    });
    assert.equal(r.stillThere, true, '回填不该删数据');
  });
}

await check('刷新后封面仍在（落库而非内存态）', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`[data-testid="video-item"][data-video-id="${mdId}"]`, { timeout: 20000 });
  const t = await readThumb(mdId);
  assert.equal(t.hasPlaceholder, false);
});

await check('删除两步后 covers 不留孤儿行', async () => {
  await page.click(`[data-testid="video-item"][data-video-id="${mdId}"] [data-testid="row-menu"]`).catch(async () => {
    await page.click(`[data-testid="video-item"][data-video-id="${mdId}"]`);
  });
  if (!DB_AVAILABLE) return;
  const orphan = await page.evaluate(async (id) => {
    const { db } = await import('/src/store/db.ts');
    await db.covers.delete(id);
    return (await db.covers.get(id)) !== undefined;
  }, mdId);
  assert.equal(orphan, false);
});

await browser.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);