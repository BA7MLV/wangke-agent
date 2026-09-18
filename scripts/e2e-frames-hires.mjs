/* eslint-disable no-console */
// 高清抽帧验证（无需 API key）：dev server 页面内直接 import src 模块，
// 验证 extractFramesAt 输出分辨率/质量、ts 对齐；与 extractFrames（VL 低清轨）对照。
// 用法：npm run dev &（5173）→ node scripts/e2e-frames-hires.mjs
//
// fixture 说明：页面里 `fetch('/.tmp-frames.mp4')` 取的是**项目根目录**下的文件
// （dev server 把根目录当静态根），仓库里不放二进制，所以缺了就现造一个 ——
// 与 scripts/e2e-all.mjs 的 resolveVideo() 同一套思路。
// 尺寸必须是 1920×1080：断言「1920 宽视频按 1600 封顶」「高度按比例 900」靠的就是这个源尺寸，
// 拿 /tmp 那些 640×360 的通用测试片来跑，这两条必假红。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, '.tmp-frames.mp4');
if (!existsSync(fixture)) {
  console.log('   [fixture] 缺 .tmp-frames.mp4，用 ffmpeg 造一个 1920×1080 的测试片…');
  // 参数是称过的，别随手改：
  //  · 源图案要**有细节**，别用纯 testsrc —— 它是低熵几何块，1600×900 的 q0.92 JPEG
  //    只有 54KB 左右，会假红在「体积 >80KB」那条上（那条守的是画质档位真生效，
  //    不是守某种压缩率）。testsrc2 本身约 84KB，仍贴着阈值，所以叠一层噪点。
  //  · 噪点必须用 `allf=u`（**静态**）：单帧的空间细节才是 JPEG 体积的来源，与时域无关；
  //    换成 `allf=t`（时域）每帧都不同，几乎无法帧间压缩 —— 实测同样参数下
  //    文件从 6.5MB 涨到 302MB，而 JPEG 体积并没有变得更有意义。
  execFileSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25',
      '-t', '10', '-vf', 'noise=alls=18:allf=u',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '26', '-pix_fmt', 'yuv420p', fixture],
    { stdio: 'ignore' },
  );
}

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
