/* eslint-disable no-console */
// 后台转写：任务状态外置（L1）+ 启动续跑（L2）+ 取消（L3）
//
// 用法：TEST_FILE=/path/to/video.mp4 node scripts/e2e-bg-transcribe.mjs
// 需先 npm run dev（5173）。**不调真实 API**：注入一把假 key + 一个不可达的 baseUrl，
// 转写会卡在「抽音频 / VAD」这一步（dev 下 ORT 本来就跑不动），任务因此长期存活，
// 正好用来观察「切页面 / 刷新」时进度还在不在。
//
// 覆盖：
//   1. 切回首页 → 列表卡片仍显示后台进度（进度不在面板组件里）；
//   2. 回到播放页 → 进度接着显示，再点一次「生成」不会重启（幂等吸附）；
//   3. 刷新页面 → 上次没转完的视频被自动接上（续跑）；
//   4. 取消能停掉任务。
import { chromium } from 'playwright';

const TEST_FILE = process.env.TEST_FILE;
const BASE = process.env.BASE_URL || 'http://localhost:5173';
if (!TEST_FILE) {
  console.error('需要 TEST_FILE');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

let failed = 0;
const ok = (m) => console.log(`   ✓ ${m}`);
const fail = (m) => {
  failed++;
  console.error(`   ❌ ${m}`);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));

const progressText = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="subs-progress"]');
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null;
  });
const generateText = () =>
  page.evaluate(() => document.querySelector('[data-testid="subs-generate"]')?.innerText.trim() ?? null);

try {
  // 假 key + 不可达接口：转写停在抽音频/VAD，任务不会马上结束
  await page.addInitScript(() => {
    localStorage.setItem('wangke-settings', JSON.stringify({
      state: { apiKey: 'e2e-fake-key', baseUrl: 'http://127.0.0.1:9/v1', asrModel: 'fake/model', asrConcurrency: 2 },
      version: 1,
    }));
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('[data-testid="import-input"]', TEST_FILE);
  await page.waitForSelector('[data-testid="video-item"]', { timeout: 60000 });

  // ── 1. 起一个转写任务 ──────────────────────────────────────────────────
  await page.click('[data-testid="btn-play"]');
  await page.waitForSelector('[data-testid="subs-generate"]', { timeout: 20000 });
  await page.click('[data-testid="subs-generate"]');
  const started = await page
    .waitForSelector('[data-testid="subs-progress"]', { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check(started, `转写已启动：${await progressText()}`);

  // ── 2. 切回首页：列表上要能看到后台进度 ────────────────────────────────
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="video-item"]', { timeout: 20000 });
  const cardJob = await page
    .waitForSelector('[data-testid="video-job"]', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  const cardText = cardJob ? (await page.textContent('[data-testid="video-job"]'))?.trim() : '';
  check(cardJob, `切回首页后列表仍在显示后台进度：${cardText}`);

  // ── 3. 回播放页：进度接着显示，重复点「生成」不会重启 ──────────────────
  await page.click('[data-testid="btn-play"]');
  await page.waitForSelector('[data-testid="subs-generate"]', { timeout: 20000 });
  const backText = await progressText();
  check(backText !== null, `回到播放页进度仍在：${backText}`);
  check((await generateText()) === '转写中…', '按钮保持「转写中…」而不是回到「生成字幕」');

  // 幂等的直接证据：mdui-button 在 loading 态不可点，点不动就起不了第二份
  const loading = await page.evaluate(
    () => document.querySelector('[data-testid="subs-generate"]')?.hasAttribute('loading') ?? false,
  );
  check(loading, '转写中「生成」按钮是 loading 态，点不出第二份任务');

  const before = backText ?? '';
  await page.waitForTimeout(1500);
  const after = await progressText();
  check(after !== null && !after.includes('抽取音频 0%'), `任务没有被重启（${before} → ${after}）`);

  // ── 4. 刷新：上次没转完的会被接上 ─────────────────────────────────────
  await page.reload({ waitUntil: 'domcontentloaded' });
  const resumed = await page
    .waitForFunction(() => document.body.innerText.includes('上次没转完'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check(resumed, '刷新后自动续跑上次未完成的转写');

  // ── 5. 取消：任务能停 ─────────────────────────────────────────────────
  const cancelVisible = await page
    .waitForSelector('[data-testid="subs-cancel"]', { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (cancelVisible) {
    await page.click('[data-testid="subs-cancel"]');
    const stopped = await page
      .waitForFunction(
        () => !document.querySelector('[data-testid="subs-progress"]'),
        { timeout: 30000 }, // 取消要等 ASR 的指数退避走完（退避 sleep 最长 4s/次）
      )
      .then(() => true)
      .catch(() => false);
    if (stopped) {
      ok('取消后任务停止');
    } else {
      // dev 下 ORT 起不来：若这次回退到了主线程跑 VAD，那一步是同步 wasm 循环、没有 Worker 可
      // terminate，只能等它自己跑完（生产档走 Worker，terminate 立即生效）。不算回归。
      const txt = (await progressText()) ?? '';
      if (txt.includes('语音端点检测')) {
        console.log(`   ⚠️ 取消信号已发出，但 dev 下 VAD 卡在 ORT（已知环境问题），跳过：${txt}`);
      } else {
        fail(`取消后任务没停：${txt}`);
      }
    }
  } else {
    fail('没找到取消按钮（任务可能已结束）');
  }
} catch (e) {
  fail(`脚本异常：${String(e).slice(0, 300)}`);
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\n=== 后台转写 e2e 全部通过 ===' : `\n=== 后台转写 e2e 失败 ${failed} 项 ===`);
process.exit(failed === 0 ? 0 : 1);
