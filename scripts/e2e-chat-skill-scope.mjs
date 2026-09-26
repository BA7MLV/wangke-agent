/* eslint-disable no-console */
// E2E：问答面板的「技能范围」限定（会话级白名单）
//   1. 问答面板出现「技能范围」按钮，默认是不限定态
//   2. 打开对话框 → 取消勾选一个技能 → 落库为白名单、按钮转限定态
//   3. 刷新页面后限定仍在（验证真的持久化，而不是只活在内存 state 里）
//   4. 「全选」→ 归一化回「不限定」（字段被删掉，而不是存一份全部 id 的快照）
//   5. 「新开会话」→ 范围归位（它是会话的属性，不该跟着面板走）
//
// 不调真实 API（不注入可用 key）：本脚本只覆盖 UI 与持久化。
// 「白名单在工具层真的拦得住 use_skill」由 test-qa-skill-scope.mjs 覆盖
// （测 isSkillAllowed 的判定），两者分工不重叠。
//
// 用法：node scripts/e2e-chat-skill-scope.mjs
//   BASE_URL 默认 http://localhost:5173；TEST_FILE 不传时用 ffmpeg 现造样片
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-skill-scope-test.mp4';

if (!existsSync(TEST_FILE)) {
  console.log(`0. 生成测试样片 ${TEST_FILE}`);
  execFileSync(
    'ffmpeg',
    [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', TEST_FILE,
    ],
    { stdio: 'ignore' },
  );
}

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));

/**
 * 直接读 IndexedDB 的会话行 —— 这是「到底存了什么」的唯一硬事实。
 *
 * 用原生 IDB 而不是 import 源码模块：这样 dev 与 preview 两档都能跑
 * （preview 下没有 /src/*.ts 可 import）。顺便也绕开了 Dexie 实例，
 * 读到的是落库后的真实结构。
 */
const readSessions = () =>
  page.evaluate(async () => {
    const req = indexedDB.open('wangke');
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
    const tx = db.transaction('chatSessions', 'readonly');
    const all = await new Promise((res, rej) => {
      const q = tx.objectStore('chatSessions').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = rej;
    });
    db.close();
    // 「字段不存在」与「值为 undefined」读出来都是 undefined，故用 in 判断字段在不在
    return all.map((r) => ({ id: r.id, has: 'skillIds' in r, skillIds: r.skillIds }));
  });

const limitedAttr = () => page.getAttribute('[data-testid="skill-picker"]', 'data-limited');

/** 从库里取刚导入的视频 id */
const readVideoId = () =>
  page.evaluate(async () => {
    const req = indexedDB.open('wangke');
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
    const all = await new Promise((res, rej) => {
      const q = db.transaction('videos', 'readonly').objectStore('videos').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = rej;
    });
    db.close();
    return all[0]?.id ?? null;
  });

/**
 * 播种一条字幕 + 一条向量。
 *
 * 为什么必须播种：**没有字幕时问答面板只渲染占位符**（「请先在字幕页生成字幕」），
 * 工具条整个不出现，技能按钮自然也不在。走真实转写要 ASR key，本脚本刻意不依赖它。
 *
 * 为什么**不再播向量**：2026-09-24 检索改为词法（BM25）后，「建索引」那一步已经不存在了，
 * `indexReady` 只看「有没有 status=1 且带 text 的字幕段」（见 ChatPanel 的初始化 effect）；
 * v13 也已把 `embeddings` 表删掉，原来那段播种现在会直接抛
 * `NotFoundError: One of the specified object stores was not found`。
 */
const seedSubtitle = (videoId) =>
  page.evaluate(async (vid) => {
    const req = indexedDB.open('wangke');
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
    // 等事务 complete 再 close：在事务还挂着时 close 会把它 abort 掉
    await new Promise((res, rej) => {
      const tx = db.transaction('segments', 'readwrite');
      tx.objectStore('segments').add({
        videoId: vid,
        idx: 0,
        start: 0,
        end: 6,
        text: '这是一段用于端到端测试的字幕内容，主题是问答技能范围限定。',
        status: 1,
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, videoId);

console.log('1. 导入测试视频并播种字幕');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
const videoId = await readVideoId();
if (!videoId) {
  console.error('未取到 videoId，导入失败');
  await browser.close();
  process.exit(1);
}
await seedSubtitle(videoId);
ok(`已播种字幕（videoId=${videoId}）`);

console.log('2. 进入问答面板');
await page.click('[data-testid="video-item"]');
await page.waitForSelector('video', { timeout: 15000 });
await page.click('[data-testid="panel-tab-chat"]');
await page.waitForSelector('[data-testid="skill-picker"]', { timeout: 15000 });
ok('问答面板出现「技能范围」按钮');

console.log('3. 默认态：不限定');
await page.waitForTimeout(800); // 等 ChatPanel 建出首个会话并加载完 skillIds
check((await limitedAttr()) === null, '按钮处于「不限定」态');
const s0 = await readSessions();
check(s0.length >= 1, `已建出会话（${s0.length} 个）`);
check(
  s0.every((r) => !r.has),
  '新会话没有 skillIds 字段（未限定 = 字段不存在，而不是空数组）',
);

console.log('4. 取消勾选一个技能 → 进入限定');
await page.click('[data-testid="skill-picker"]');
await page.waitForSelector('[data-testid="skill-scope-item"]', { timeout: 10000 });
const total = await page.locator('[data-testid="skill-scope-item"]').count();
check(total > 0, `对话框列出 ${total} 个启用技能`);
const allChecked = await page.$$eval('[data-testid="skill-scope-item"]', (els) =>
  els.every((e) => e.checked),
);
check(allChecked, '未限定时默认全部勾选');

await page.locator('[data-testid="skill-scope-item"]').first().click();
await page.waitForTimeout(400);
const s1 = await readSessions();
const limitedRow = s1.find((r) => r.has);
check(
  Array.isArray(limitedRow?.skillIds) && limitedRow.skillIds.length === total - 1,
  `白名单落库为 ${total - 1} 项（实为 ${limitedRow?.skillIds?.length ?? '无'}）`,
);

await page.click('[data-testid="skill-picker-done"]');
await page.waitForTimeout(300);
check((await limitedAttr()) === '1', '按钮转为「限定」态');

console.log('5. 刷新页面：限定必须还在');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="panel-tab-chat"]', { timeout: 15000 });
await page.click('[data-testid="panel-tab-chat"]');
await page.waitForSelector('[data-testid="skill-picker"]', { timeout: 15000 });
await page.waitForTimeout(800);
check((await limitedAttr()) === '1', '刷新后仍是「限定」态（持久化生效）');
const s2 = await readSessions();
check(s2.some((r) => r.has), '刷新后库里仍存着白名单');

console.log('6. 全选 → 归一化回「不限定」');
await page.click('[data-testid="skill-picker"]');
await page.waitForSelector('[data-testid="skill-picker-all"]', { timeout: 10000 });
await page.click('[data-testid="skill-picker-all"]');
await page.waitForTimeout(400);
const s3 = await readSessions();
check(
  s3.every((r) => !r.has),
  '「全选」后字段被删除（不限定），而不是存一份全部 id 的快照',
);

console.log('7. 新开会话 → 范围归位');
await page.locator('[data-testid="skill-scope-item"]').first().click();
await page.waitForTimeout(400);
await page.click('[data-testid="skill-picker-done"]');
await page.waitForTimeout(300);
check((await limitedAttr()) === '1', '重新进入「限定」态');
await page.click('[data-testid="chat-new-session"]');
await page.waitForTimeout(800);
check((await limitedAttr()) === null, '新开会话后归位为「不限定」');
const s4 = await readSessions();
// 只断言「比之前多」，不写死数量：dev 档下 React StrictMode 会把 ChatPanel 的建会话
// effect 跑两遍，库里可能出现 2 个初始会话（既有行为，与技能范围无关，见设计文档「已知未做」）
check(s4.length > s3.length, `新开会话后会话数 ${s3.length} → ${s4.length}`);
check(
  s4.some((r) => r.has) && s4.some((r) => !r.has),
  '旧会话保留白名单、新会话不带（范围是会话属性，不是面板属性）',
);

console.log(errors.length ? `[page errors]\n${errors.join('\n')}` : '无 page 错误');
await browser.close();
console.log(failed === 0 ? '\n✅ 问答技能范围限定通过' : `\n❌ 有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
