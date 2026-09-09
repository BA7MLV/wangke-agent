/* eslint-disable no-console */
// 高清抽帧验证（无需 API key）：dev server 页面内直接 import src 模块，
// 验证 extractFramesAt 输出分辨率/质量、ts 对齐；与 extractFrames（VL 低清轨）对照。
// 用法：npm run dev &（5173）→ node scripts/e2e-frames-hires.mjs
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ok' : '  FAIL'} - ${name}${detail ? `（${detail}）` : ''}`);
  if (!cond) failed++;
};

await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const blob = await (await fetch('/.tmp-frames.mp4')).blob();
  const { extractFramesAt, extractFrames } = await import('/src/media/frames.ts');

  const hires = await extractFramesAt(blob, [2, 5], { maxWidth: 1600, quality: 0.92 });
  const hiresInfo = [...hires.entries()].map(([ts, f]) => ({ ts, width: f.width, height: f.height, size: f.blob.size }));

  // 对照：VL 低清轨（10 秒视频 interval=20 只抽 1 帧左右，很快）
  const lowres = await extractFrames(blob, {});
  const lowresInfo = lowres.map((f) => ({ width: f.width, size: f.blob.size }));

  return { hiresInfo, lowresInfo, videoBlob: blob.size };
});

console.log('   高清帧:', JSON.stringify(result.hiresInfo));
console.log('   VL 帧:', JSON.stringify(result.lowresInfo));

check('定点重抽返回请求的 2 个时间戳', result.hiresInfo.length === 2);
check('Map key 与请求 ts 一致（整数秒对齐）', result.hiresInfo.every((f) => f.ts === 2 || f.ts === 5));
check('1920 宽视频按 1600 封顶', result.hiresInfo.every((f) => f.width === 1600));
check('高度按比例 900', result.hiresInfo.every((f) => f.height === 900));
check('q0.92 高清 JPEG 体积合理（>80KB）', result.hiresInfo.every((f) => f.size > 80_000));
check('VL 轨保持 640px 低清（省 token）', result.lowresInfo.every((f) => f.width === 640));

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);
