/* eslint-disable no-console */
// E2E：封面（covers 表）—— 导入即有封面、小图档位、材料首页、刷新后仍在、删除不残留。
//
// 这一版守的是**旧实现必然失败**的那几条：
//   旧的封面是「从 db.frames 取第一帧」，而 frames 只有跑过讲义才有 ——
//   于是「刚导入的视频没有封面」被当成了正常现象。本脚本**全程不碰讲义**，
//   断言封面在导入后自动出现，正是把这条旧行为钉死。
//
// 用法：
//   npm run dev &        → BASE_URL=http://localhost:5173 node scripts/e2e-covers.mjs
//   npm run preview &    → node scripts/e2e-covers.mjs          （默认 4173）
//
// 视频夹具：TEST_FILE 指向一个真实视频；没有就用 ffmpeg 造一个（同 e2e-all.mjs）。
// PDF 夹具：scripts/fixtures/sample-zh.pdf。
//
// 关于浏览器：默认用 Playwright 自带的 Chromium（本机 Chrome 启动时要写自己的代码签名
// 缓存与 RLZ 配置，在受限沙箱里会被拦；其余 e2e 用 channel:'chrome' 是因为它们在不受限的
// 终端里跑）。需要跑真实 Chrome 时：PW_CHANNEL=chrome。
//
// 关于读库断言：核心断言全部走 DOM（封面最终要渲染成 `<img>`），对 preview 构建同样有效；
// 另有几条需要动态 import `/src/store/db.ts` 的交叉验证，preview 下自动跳过不算失败。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const FIX_PDF = path.resolve('scripts/fixtures/sample-zh.pdf');
const COVER_EDGE = 480;

let failed = 0;
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.error(`❌ ${m}`);
  failed++;
};
const skip = (m) => console.log(`⏭️  ${m}`);
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(`${name}\n   ${e.message}`);
  }
}

/** 找一个现成的测试视频，没有就用 ffmpeg 造一个 640×360 / 40s 的 */
function ensureVideo() {
  const given = process.env.TEST_FILE;
  if (given && fs.existsSync(given)) return given;
  const made = '/tmp/wangke-cover-test.mp4';
  if (fs.existsSync(made)) return made;
  console.log(`   [video] 用 ffmpeg 生成 ${made}`);
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '40', '-pix_fmt', 'yuv420p', made],
    { stdio: 'ignore' },
  );
  if (r.status !== 0 || !fs.existsSync(made)) throw new Error('缺少测试视频，且 ffmpeg 生成失败');
  return made;
}

const VIDEO = ensureVideo();
console.log(`   视频夹具：${VIDEO}`);
console.log(`   PDF 夹具：${FIX_PDF}`);

const CHANNEL = process.env.PW_CHANNEL;
const browser = await chromium.launch(CHANNEL ? { channel: CHANNEL, headless: true } : { headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => fail(`页面异常：${e.message}`));

/** 导入一个文件并等它出现在库列表里；返回库行的 data-video-id */
async function importFile(filePath) {
  await page.setInputFiles('input[type="file"]', filePath);
  const name = path.basename(filePath).replace(/\.[^.]+$/, '');
  await page.waitForSelector(`[data-testid="video-item"]:has-text("${name}")`, { timeout: 30000 });
  return await page.$eval(`[data-testid="video-item"]:has-text("${name}")`, (el) => el.dataset.videoId);
}

/** 等某个库行真的渲染出封面图（不是占位），再把它量出来 */
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
    // 封面是 blob: URL，可以直接 fetch 回来量体积与真实类型
    const res = await fetch(img.src);
    const blob = await res.blob();
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

// 读库能力探测：preview 构建下 /src/... 不存在，相关断言只跳过不失败
const DB_AVAILABLE = await page.evaluate(async () => {
  try {
    await import('/src/store/db.ts');
    return true;
  } catch {
    return false;
  }
});
if (!DB_AVAILABLE) console.log('   [note] 拿不到 /src/store/db.ts（preview 构建），读库类断言将跳过');

const DBSkip = '本构建不支持动态 import src 模块';

async function readDb(id, tables) {
  return await page.evaluate(
    async ({ vid, t }) => {
      const { db } = await import('/src/store/db.ts');
      const out = {};
      for (const name of t) out[name] = (await db[name].get(vid)) ?? null;
      return out;
    },
    { vid: id, t: tables },
  );
}

// ── 1. 视频：导入即有封面 ────────────────────────────────────────────────
console.log('\n▸ 视频封面（全程不碰讲义）');
const videoId = await importFile(VIDEO);
let videoThumb = null;

await check('导入后卡片自动出现封面（不需要跑过讲义）', async () => {
  videoThumb = await readThumb(videoId);
  assert.equal(videoThumb.hasPlaceholder, false, '仍停在占位图上');
});

await check(`封面为小图：长边 ${COVER_EDGE}（不是原尺寸帧）`, async () => {
  assert.ok(videoThumb, '上一步没拿到封面');
  // 640×360 源 → 480×270
  assert.equal(videoThumb.naturalWidth, 480);
  assert.equal(videoThumb.naturalHeight, 270);
});

await check('封面编码为 WebP（不支持时回退 JPEG），且体积远小于原帧', async () => {
  assert.ok(['image/webp', 'image/jpeg'].includes(videoThumb.type), `意外的类型 ${videoThumb.type}`);
  assert.ok(videoThumb.size < 80_000, `体积 ${videoThumb.size}B 偏大，可能存了原尺寸图`);
});

await check('封面落库：source=auto、coverState=done、主色（LQIP）已写', async () => {
  if (!DB_AVAILABLE) return skip(DBSkip);
  const { covers, videos } = await readDb(videoId, ['covers', 'videos']);
  assert.ok(covers, 'covers 表里没有记录');
  assert.equal(covers.source, 'auto', '没跑过讲义时应走自动抽样');
  assert.equal(videos.coverState, 'done');
  assert.match(videos.dominantColor ?? '', /^#[0-9a-fA-F]{6}$/, '主色没写上，占位就没有底色可铺');
  // 旧路径的证伪：frames 这张表全程没被写过，封面却已经有了
  const frames = await page.evaluate(async (vid) => {
    const { db } = await import('/src/store/db.ts');
    return await db.frames.where('videoId').equals(vid).count();
  }, videoId);
  assert.equal(frames, 0, 'frames 竟然有数据，这条断言的前提变了');
});

// ── 2. 刷新后仍在（证明落在库里，不是内存态）──────────────────────────────
await check('刷新页面后封面依然渲染', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const again = await readThumb(videoId);
  assert.equal(again.naturalWidth, 480);
});

// ── 3. PDF 材料：渲染首页当封面 ─────────────────────────────────────────
console.log('\n▸ PDF 材料封面');
const pdfId = await importFile(FIX_PDF);
let pdfThumb = null;

await check('PDF 导入后有封面（不是文档图标占位）', async () => {
  pdfThumb = await readThumb(pdfId);
  assert.equal(pdfThumb.hasPlaceholder, false, '仍是图标占位');
});

await check('PDF 封面为首页渲染：长边 480 且保持竖版比例', async () => {
  assert.ok(pdfThumb, '上一步没拿到封面');
  assert.equal(Math.max(pdfThumb.naturalWidth, pdfThumb.naturalHeight), COVER_EDGE);
  assert.ok(pdfThumb.naturalHeight > pdfThumb.naturalWidth, 'A4 首页应当是竖版');
  // A4 是 1:√2 ≈ 0.707，留一点容差
  const ratio = pdfThumb.naturalWidth / pdfThumb.naturalHeight;
  assert.ok(Math.abs(ratio - 0.707) < 0.05, `比例 ${ratio.toFixed(3)} 不像 A4`);
});

await check('PDF 封面是不透明的（pdf.js 不留底色，必须自己铺白底）', async () => {
  const alpha = await page.evaluate(async (vid) => {
    const row = document.querySelector(`[data-testid="video-item"][data-video-id="${vid}"]`);
    const img = row.querySelector('[data-testid="video-thumb"] img');
    const bitmap = await createImageBitmap(await (await fetch(img.src)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    // 抽查四角与边缘中点：白底若没铺上，pdf.js 的空白区会是 alpha=0
    const pts = [[2, 2], [bitmap.width >> 1, 4], [4, bitmap.height >> 1], [bitmap.width - 3, bitmap.height - 3]];
    return pts.map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3]);
  }, pdfId);
  assert.ok(
    alpha.every((a) => a === 255),
    `有半透明像素（alpha=${alpha.join(',')}）`,
  );
});

await check('PDF 封面的 source 记为 material-page、取自第 1 页', async () => {
  if (!DB_AVAILABLE) return skip(DBSkip);
  const { covers } = await readDb(pdfId, ['covers']);
  assert.equal(covers?.source, 'material-page');
  assert.equal(covers?.ts, 1);
});

// ── 4. 删除级联：封面必须跟着记录一起走 ──────────────────────────────────
// v10 给「彻底删除」的级联清单加了 covers；漏掉它就会留下一堆孤儿 blob 永远占着配额，
// 而这种泄漏在界面上完全看不出来（卡片已经没了），只能靠脚本守。
console.log('\n▸ 删除级联');
await check('两步删除后 covers 不留孤儿行', async () => {
  if (!DB_AVAILABLE) return skip(DBSkip);
  const dlg = page.locator('mdui-dialog:has([data-testid="confirm-dialog-danger"])');
  const row = page.locator(`[data-testid="video-item"][data-video-id="${videoId}"]`);
  for (let step = 0; step < 2; step++) {
    await row.locator('[data-testid="btn-delete"]').click();
    await dlg.waitFor({ state: 'attached', timeout: 5000 });
    await dlg.locator('mdui-button[slot="action"]').last().click();
    await page.waitForTimeout(1500);
  }
  const left = await readDb(videoId, ['covers', 'videos']);
  assert.equal(left.videos, null, '记录还在，删除没生效');
  assert.equal(left.covers, null, '封面成了孤儿行（级联清单漏了 covers）');
});

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);
