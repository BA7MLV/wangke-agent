/* eslint-disable no-console */
// 统一 e2e 编排器：升级前基线用的「一键跑分」工具。
// 设计约束：只用 node: 内置模块 + playwright；不碰 build/dist；长驻服务（preview/dev）
// 由本脚本负责启停，端口已占用则复用，跑完只关自己启动的。
//
// 用法：
//   node scripts/e2e-all.mjs                 # 无需 key 的全量（跳过硬依赖 SF_KEY 的脚本）
//   node scripts/e2e-all.mjs --with-key      # 含 key 的全量（需自行 export SF_KEY=...）
//   node scripts/e2e-all.mjs --only=e2e-import,e2e-mobile
//   node scripts/e2e-all.mjs --filter='^e2e-'# 正则过滤脚本名
//
// 输出：scripts/.cache/e2e-report.json + scripts/.cache/e2e-report.md
// 退出码：有 failed 则非 0。

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(__dirname, '.cache');
mkdirSync(CACHE_DIR, { recursive: true });

// ───────────────────────────── 元数据库（分类结果硬编码） ─────────────────────────────
// service: 'none' | 'preview'(4173) | 'dev'(5173)
// key:     是否硬/软依赖 SF_KEY（true → 无 key 档跳过）
// testFile: 是否注入 TEST_FILE
// antd:    是否依赖 antd 的 DOM/类名选择器（迁移 mdui 时会集体变红）
// diagnostic: 诊断脚本，总以 0 退出（输出仅供人工看）
// base:    读取 BASE_URL（编排器会按服务注入正确地址）
// timeout:  单脚本超时（秒）
// video:   优先注入的测试视频
// skip:     非空的跳过原因（整脚本跳过）
const META = {
  // ── 纯 Node（无服务）──
  'render-handout-fixture': { service: 'none', antd: false, timeout: 120 },
  'test-anki-cards': { service: 'none', antd: false, timeout: 120 },
  'test-apkg': { service: 'none', antd: false, timeout: 120 },
  'test-bilibili-api': { service: 'none', antd: false, timeout: 120 },
  'test-bilibili-index': { service: 'none', antd: false, timeout: 120 },
  'test-bilibili-parse': { service: 'none', antd: false, timeout: 120 },
  'test-builtin-skills': { service: 'none', antd: false, timeout: 120 },
  'test-chat-export': { service: 'none', antd: false, timeout: 120 },
  'test-chat-frames': { service: 'none', antd: false, timeout: 120 },
  'test-error-text': { service: 'none', antd: false, timeout: 120 },
  'test-handout-ir': { service: 'none', antd: false, timeout: 120 },
  'test-handout-prompts': { service: 'none', antd: false, timeout: 120 },
  'test-migration': { service: 'none', antd: false, timeout: 120 },
  'test-ort-config': { service: 'none', antd: false, timeout: 120 },
  'test-quiz': { service: 'none', antd: false, timeout: 120 },
  'test-rate': { service: 'none', antd: false, timeout: 120 },

  // ── preview(4173)：生产构建档 ──
  // 注意：本注释与下面 e2e-mdui-adapter 的说明在 mdui 迁移期间才成立
  'debug-import-perf': { service: 'preview', antd: true, testFile: true, diagnostic: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-cards': { service: 'preview', antd: true, base: true, timeout: 300 },
  'e2e-chat-export': { service: 'preview', antd: true, base: true, timeout: 300 },
  'e2e-chat-frames': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-chat-image': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-chat': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-chat-mermaid': { service: 'preview', antd: true, testFile: true, base: true, timeout: 300, video: '/tmp/wangke-mermaid-test.mp4' },
  // mdui 迁移基建验收（React 19 生效 / 46 个自定义元素已注册 / 设计令牌可用 / 未污染 antd 界面）。
  // 本档验不了「React 版本」与「中文语言包」两项（生产构建拿不到模块句柄），
  // 需要时手动补跑 dev 档：BASE_URL=http://localhost:5173 node scripts/e2e-mdui-adapter.mjs
  'e2e-mdui-adapter': { service: 'preview', antd: false, base: true, timeout: 120 },
  // 阶段 1 起新增：设置页写作技能列表 + 新建对话框交互（不依赖 antd 选择器，全部 data-testid）
  'e2e-settings-skills': { service: 'preview', antd: false, base: true, timeout: 180 },
  'e2e-danmaku': { service: 'preview', antd: true, key: 'optional', testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-handout-edit': { service: 'preview', antd: true, base: true, timeout: 300 },
  'e2e-handout': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-import-insecure': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-import': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  // 首页自身交互（分组 / 移动 / 折叠 / 两步删除 / 拖拽）—— 既有脚本只把首页当跳板，没覆盖这些
  'e2e-library': { service: 'preview', antd: false, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-mobile': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-player-enhance': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-quiz': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-resume': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-smoke': { service: 'preview', antd: true, key: true, testFile: true, timeout: 600, video: '/tmp/wangke-test.mp4' },
  'e2e-storage-card': { service: 'preview', antd: true, timeout: 300 },
  'motion-components-test': { service: 'preview', antd: false, timeout: 120 },
  'motion-smoke': { service: 'preview', antd: true, timeout: 120 },

  // ── dev(5173)：从 node_modules 重编译，当前已是 React 19，非升级前基线 ──
  'debug-player': { service: 'dev', antd: true, key: true, testFile: true, diagnostic: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'debug-transcribe': { service: 'dev', antd: true, key: true, testFile: true, diagnostic: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-frames-hires': { service: 'dev', antd: false, timeout: 300 },
  'e2e-live-subs': { service: 'dev', antd: true, testFile: true, timeout: 300, video: '/tmp/e2e-live.mp4' },
  'e2e-preview-fonts': { service: 'dev', antd: true, timeout: 300 },
  // 只能跑 dev：守的是 StrictMode 双调用引发的并发竞态，生产构建不触发（见脚本头注释）
  'e2e-skills-dedupe': { service: 'dev', antd: false, timeout: 120 },
  // 只能跑 dev：动态取色那段要往 IndexedDB 种封面帧，得拿应用同一份 Dexie 实例
  'e2e-material-you': { service: 'dev', antd: false, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'probe': { service: 'dev', antd: false, diagnostic: true, timeout: 120 },
  'probe-mermaid': { service: 'dev', antd: false, diagnostic: true, timeout: 120, skip: '缺失 public/probe-mermaid.html，页面 404，无法加载' },
};

// ───────────────────────────── 参数解析 ─────────────────────────────
const argv = process.argv.slice(2);
const withKey = argv.includes('--with-key');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const filterArg = argv.find((a) => a.startsWith('--filter='));
const onlySet = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)) : null;
const filterRe = filterArg ? new RegExp(filterArg.slice('--filter='.length)) : null;

// ───────────────────────────── 工具函数 ─────────────────────────────
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(true); });
  });
}

async function waitForPort(port, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await portFree(port))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 找一个现成的测试视频，没有就用 ffmpeg 造一个
function resolveVideo(preferred) {
  const candidates = [preferred, '/tmp/wangke-test.mp4', '/tmp/e2e-live.mp4', '/tmp/wangke-mermaid-test.mp4']
    .filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  // 兜底：ffmpeg 造 40s 测试视频
  const made = '/tmp/wangke-test.mp4';
  console.log(`  [video] 无现成测试视频，用 ffmpeg 生成 ${made}`);
  const r = spawnSyncSafe('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-duration', '40',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-duration', '40', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', made]);
  if (r !== 0) { console.error('  [video] ffmpeg 生成失败'); return null; }
  return made;
}

function spawnSyncSafe(cmd, args) {
  const p = spawn(cmd, args, { stdio: 'ignore' });
  return new Promise((resolve) => p.on('exit', (c) => resolve(c ?? 0)));
}

// 启动服务；若端口已占用则复用，否则启动并返回子进程（需本脚本负责关闭）
async function ensureService(service) {
  if (service === 'none') return null;
  const port = service === 'preview' ? 4173 : 5173;
  if (!(await portFree(port))) {
    console.log(`  [svc] 端口 ${port} 已占用，复用现有 ${service} 服务`);
    return { port, child: null, reused: true };
  }
  console.log(`  [svc] 启动 ${service} 服务（端口 ${port}）…`);
  const child = spawn('npm', ['run', service], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const ok = await waitForPort(port);
  if (!ok) {
    console.error(`  [svc] ${service} 在 120s 内未就绪，中止`);
    try { child.kill('SIGTERM'); } catch {}
    throw new Error(`${service} 启动超时`);
  }
  console.log(`  [svc] ${service} 已就绪`);
  return { port, child, reused: false };
}

function stopService(svc) {
  if (svc && svc.child) {
    try { svc.child.kill('SIGTERM'); } catch {}
    console.log(`  [svc] 已关闭自起的 ${svc.child ? '服务' : ''}`);
  }
}

// 运行单个脚本，返回 { status, durationMs, exitCode, tail }
function runScript(name, meta, svc) {
  return new Promise((resolve) => {
    const file = join(__dirname, `${name}.mjs`);
    const env = { ...process.env };
    if (meta.testFile) {
      const v = resolveVideo(meta.video);
      if (v) env.TEST_FILE = v; else { resolve({ status: 'skipped', durationMs: 0, exitCode: null, tail: ['无可用测试视频且 ffmpeg 生成失败'] }); return; }
    }
    if (svc && !svc.reused && meta.base) env.BASE_URL = `http://localhost:${svc.port}`;
    else if (svc && meta.base) env.BASE_URL = `http://localhost:${svc.port}`;

    const child = spawn('node', [file], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timeoutMs = (meta.timeout || 300) * 1000;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      const tail = out.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-20);
      resolve({ status: 'failed', durationMs: timeoutMs, exitCode: 'timeout', tail: [...tail, `⏱ 超时（>${meta.timeout}s）被强制终止`] });
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const lines = out.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      const tail = lines.slice(-20);
      let status;
      if (signal === 'SIGKILL') status = 'failed';
      else if (code === 0) status = 'passed';
      else status = 'failed';
      resolve({ status, durationMs: 0, exitCode: code ?? signal, tail });
    });
  });
}

// 记录耗时
function withTiming(p) {
  const t0 = Date.now();
  return p.then((r) => ({ ...r, durationMs: Date.now() - t0 }));
}

// ───────────────────────────── 主流程 ─────────────────────────────
const allNames = Object.keys(META);
const selected = allNames.filter((name) => {
  const meta = META[name];
  if (onlySet && !onlySet.has(name)) return false;
  if (filterRe && !filterRe.test(name)) return false;
  if (meta.skip) return false; // 整脚本跳过
  if (!withKey && meta.key === true) return false; // 无 key 档跳过硬依赖 key 的
  return true;
});

// 按服务分三批：none → preview → dev（同一时间只起一个服务）
const batches = [
  { service: 'none', names: selected.filter((n) => META[n].service === 'none') },
  { service: 'preview', names: selected.filter((n) => META[n].service === 'preview') },
  { service: 'dev', names: selected.filter((n) => META[n].service === 'dev') },
];

const results = [];
const skipped = allNames
  .filter((n) => META[n].skip)
  .map((n) => ({ name: n, status: 'skipped', reason: META[n].skip }));

console.log(`\n=== e2e-all 编排开始（withKey=${withKey}）===`);
console.log(`选中 ${selected.length} 个脚本，跳过（损坏/需key）${skipped.length + allNames.filter((n) => !withKey && META[n].key === true && !META[n].skip).length} 个\n`);

let activeSvc = null;
try {
  for (const batch of batches) {
    if (batch.names.length === 0) continue;
    activeSvc = await ensureService(batch.service);
    for (const name of batch.names) {
      const meta = META[name];
      process.stdout.write(`▶ ${name} [${batch.service}] … `);
      const r = await withTiming(runScript(name, meta, activeSvc));
      const dur = (r.durationMs / 1000).toFixed(1);
      const tag = r.status === 'passed' ? '✅' : '❌';
      console.log(`${tag} ${r.status} (${dur}s, exit=${r.exitCode ?? '-'})`);
      results.push({ name, service: batch.service, antd: meta.antd, diagnostic: !!meta.diagnostic, key: meta.key || false, status: r.status, durationMs: r.durationMs, exitCode: r.exitCode, tail: r.tail });
    }
    stopService(activeSvc);
    activeSvc = null;
  }
} finally {
  if (activeSvc) stopService(activeSvc);
}

// 把因「需 key」跳过的也记进结果
for (const n of allNames) {
  const meta = META[n];
  if (!withKey && meta.key === true && !meta.skip && !results.find((r) => r.name === n)) {
    results.push({ name: n, service: meta.service, antd: meta.antd, diagnostic: !!meta.diagnostic, key: true, status: 'skipped', reason: '无 SF_KEY（无 key 档跳过）', durationMs: 0, exitCode: null, tail: [] });
  }
}
for (const s of skipped) {
  results.push({ name: s.name, service: META[s.name].service, antd: META[s.name].antd, diagnostic: !!META[s.name].diagnostic, key: META[s.name].key || false, status: 'skipped', reason: s.reason, durationMs: 0, exitCode: null, tail: [] });
}

// ───────────────────────────── 汇总与落盘 ─────────────────────────────
const passed = results.filter((r) => r.status === 'passed').length;
const failed = results.filter((r) => r.status === 'failed').length;
const skippedN = results.filter((r) => r.status === 'skipped').length;
const total = results.length;
const passRate = total ? ((passed / total) * 100).toFixed(1) : '0.0';

console.log(`\n=== 汇总：${passed} 通过 / ${failed} 失败 / ${skippedN} 跳过（共 ${total}，通过率 ${passRate}%）===\n`);

const reportJson = {
  generatedAt: new Date().toISOString(),
  withKey,
  react18BaselineVia: 'preview(4173)=dist(React18); dev(5173)=node_modules(React19, 非升级前基线)',
  summary: { passed, failed, skipped: skippedN, total, passRate: Number(passRate) },
  results,
};
writeFileSync(join(CACHE_DIR, 'e2e-report.json'), JSON.stringify(reportJson, null, 2), 'utf8');

// 人读 markdown
const md = [
  `# e2e 基线运行报告`,
  ``,
  `- 生成时间：${reportJson.generatedAt}`,
  `- 档位：--with-key=${withKey}`,
  `- React18 基线来源：preview(4173) 读取 dist（React18 构建）；dev(5173) 由 node_modules 重编译（当前已是 React19，**非升级前基线**）`,
  `- 汇总：**${passed} 通过 / ${failed} 失败 / ${skippedN} 跳过**（共 ${total}，通过率 ${passRate}%）`,
  ``,
  `## 结果明细`,
  ``,
  `| 脚本 | 服务 | antd依赖 | 诊断 | 状态 | 耗时 | 退出码 | 备注 |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...results.map((r) => `| ${r.name} | ${r.service} | ${r.antd ? '是' : '否'} | ${r.diagnostic ? '是' : '否'} | ${r.status} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.exitCode ?? '-'} | ${r.reason || ''} |`),
  ``,
  `## 失败脚本关键输出（末 20 行）`,
  ``,
  ...results.filter((r) => r.status === 'failed').flatMap((r) => [
    `### ${r.name}（${r.service}, exit=${r.exitCode ?? '-'}）`,
    '```',
    ...(r.tail || []),
    '```',
    '',
  ]),
  `> 注：诊断脚本（debug-*/probe-*）总以 0 退出，状态仅供参考；其输出中的 pageerror/console.error 不代表断言失败。`,
  '',
].join('\n');
writeFileSync(join(CACHE_DIR, 'e2e-report.md'), md, 'utf8');
console.log(`报告已写入：scripts/.cache/e2e-report.json / e2e-report.md`);

process.exit(failed > 0 ? 1 : 0);
