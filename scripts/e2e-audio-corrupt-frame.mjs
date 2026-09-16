/* eslint-disable no-console */
/**
 * 「抽音频遇到坏帧」的回归用例。
 *
 * 背景：WebCodecs 的 `AudioDecoder` 只要有一帧解不出来就关闭整个解码器（EncodingError），
 * 而现实里下载下来的课程文件常有极个别损坏帧（实测一个 91 分钟的文件里只有 1 帧坏）。
 * 这里造一个**确定损坏**的音频文件，跑真实应用代码 `src/media/audio.ts`，断言：
 *   1. 坏文件也能解完（recoveries ≥ 1），且跳过的时长很小（不是整段丢弃）；
 *   2. PCM 时间轴长度 ≈ 媒体时长（补静音后不漂）；
 *   3. 干净的对照文件 recoveries === 0（不能「容忍」到把正常文件也当坏的）。
 *
 * 用法：node scripts/e2e-audio-corrupt-frame.mjs
 * 需要本机 chrome + ffmpeg（与其它 e2e 相同）。
 *
 * 先验牙齿：把 `src/media/tolerantDecode.ts` 的 `MAX_RECOVERIES` 改成 0（退化成不支持坏帧），
 * 本用例应当变红。
 */
import { chromium } from 'playwright';
import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'scripts/.cache');
const TMP = '/tmp';
const SRC = path.join(TMP, 'wangke-corrupt-src.m4a');
const BAD = path.join(TMP, 'wangke-corrupt.m4a');
const DURATION = 60;
/** 涂坏哪一秒的音频帧 */
const CORRUPT_AT = 30;

let failed = 0;
const ok = (m) => console.log(`   ✓ ${m}`);
const fail = (m) => {
  failed++;
  console.error(`   ❌ ${m}`);
};
const check = (cond, m, extra) => (cond ? ok(m) : fail(`${m}${extra === undefined ? '' : `（实测 ${JSON.stringify(extra)}）`}`));

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** ffmpeg 全量解一遍音轨，返回 stderr（有解码错误时非空） */
function ffmpegDecodeErrors(file) {
  try {
    sh('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-map', '0:a:0', '-f', 'null', '-']);
    return '';
  } catch (e) {
    return String(e.stderr ?? e.message);
  }
}

/** 造样片 + 涂坏一个 AAC 包 */
function buildFixtures() {
  fs.rmSync(SRC, { force: true });
  fs.rmSync(BAD, { force: true });
  sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION}`, '-c:a', 'aac', '-b:a', '128k', SRC]);

  // 找到 CORRUPT_AT 秒附近的那个音频包，把它的字节涂成 0xFF
  // （用 json 取字段，别用 csv：ffprobe 的 csv 列顺序不跟随 -show_entries 的书写顺序，踩过）
  const packets = JSON.parse(
    sh('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pos,size,pts_time', '-of', 'json', SRC]),
  ).packets.map((p) => ({ t: Number(p.pts_time), pos: Number(p.pos), size: Number(p.size) }));
  const victim = packets.find((p) => p.t >= CORRUPT_AT);
  if (!victim) throw new Error('没找到要涂坏的包');

  const buf = fs.readFileSync(SRC);
  buf.fill(0xff, victim.pos, victim.pos + victim.size);
  fs.writeFileSync(BAD, buf);
  console.log(`   样片：${path.basename(SRC)}（${DURATION}s，${packets.length} 个包）`);
  console.log(`   涂坏：第 ${victim.t.toFixed(3)}s 的包（${victim.size} 字节 @ ${victim.pos}）`);
}

async function bundle() {
  fs.mkdirSync(CACHE, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/media/audio.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    // 用包自带的浏览器打包产物，避免它内部的 node:fs/promises 在页面里 CORS 炸
    alias: { mediabunny: path.join(ROOT, 'node_modules/mediabunny/dist/bundles/mediabunny.mjs') },
    outfile: path.join(CACHE, 'audio-bundle.mjs'),
  });
  fs.writeFileSync(
    path.join(CACHE, 'audio-probe.html'),
    '<!DOCTYPE html><html><body><input id="f" type="file"><script type="module" src="/scripts/.cache/audio-probe.js"></script></body></html>',
  );
  fs.writeFileSync(
    path.join(CACHE, 'audio-probe.js'),
    `import { extractAudio16k } from './audio-bundle.mjs';
window.__run = async (file, duration) => {
  const notes = [];
  try {
    const r = await extractAudio16k(file, duration, () => {}, (info) => notes.push(info));
    return { ok: true, recoveries: r.recoveries, skipped: r.skipped, seconds: r.pcm.length / 16000, notes };
  } catch (e) {
    return { ok: false, name: e?.name, message: e?.message, notes };
  }
};
`,
  );
}

async function runInBrowser(page, file, duration) {
  await page.goto('http://localhost:5310/scripts/.cache/audio-probe.html');
  await page.setInputFiles('#f', file);
  return page.evaluate((d) => window.__run(document.getElementById('f').files[0], d), duration, { timeout: 300000 });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

console.log('▶ 坏帧容忍（抽音频）');
buildFixtures();
await bundle();

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 200)));
  // 自建虚拟静态服务器：沙箱/CI 里不需要真的监听端口（且 WebCodecs 只认安全上下文）
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'localhost') return route.continue();
    const f = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
    return route.fulfill({
      status: 200,
      headers: { 'content-type': MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream' },
      body: fs.readFileSync(f),
    });
  });

  // ── 1. 坏文件：ffmpeg 也确认它确实坏了 ─────────────────────────────────
  const ffErr = ffmpegDecodeErrors(BAD);
  check(/invalid|error/i.test(ffErr), '坏样片确实会让 ffmpeg 报解码错误', ffErr.trim().split('\n')[0] ?? '(无)');

  // ── 2. 真实应用代码要能解完 ───────────────────────────────────────────
  const bad = await runInBrowser(page, BAD, DURATION);
  check(bad.ok === true, '坏文件也能抽完（不抛异常）', bad);
  if (bad.ok) {
    check(bad.recoveries >= 1, '跳过了至少 1 处损坏帧', bad.recoveries);
    check(bad.skipped > 0 && bad.skipped < 2, '跳过的时长很小（秒级以内）', bad.skipped);
    check(
      Math.abs(bad.seconds - DURATION) < 0.5,
      'PCM 时间轴长度 ≈ 媒体时长（补静音后不漂）',
      { pcm: Number(bad.seconds.toFixed(3)), media: DURATION },
    );
  }

  // ── 3. 干净文件：不能把正常文件也当坏的 ───────────────────────────────
  const good = await runInBrowser(page, SRC, DURATION);
  check(good.ok === true, '干净文件正常抽完', good);
  if (good.ok) {
    check(good.recoveries === 0, '干净文件不触发续解', good.recoveries);
    check(good.skipped === 0, '干净文件不补静音', good.skipped);
  }
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
