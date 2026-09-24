/* eslint-disable no-console */
// 思考题弹幕链路：生成（真实 API，可选）→ 自右向左飘屏 → 开关持久化 → seek 重发
// 用法：
//   SF_KEY=sk-... TEST_FILE=/path/to/video.mp4 node scripts/e2e-danmaku.mjs   # 全链路（含 LLM 生成）
//   TEST_FILE=/path/to/video.mp4 node scripts/e2e-danmaku.mjs                  # 仅飘屏/开关/seek（种子数据，无 API）
// 需先 npm run preview（默认 4173，被占用时用 BASE_URL 指到别处）
import { chromium } from 'playwright';

const API_KEY = process.env.SF_KEY;
const TEST_FILE = process.env.TEST_FILE;
const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
if (!TEST_FILE) { console.error('需要 TEST_FILE'); process.exit(1); }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));

const fail = (msg) => { console.error(`❌ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`   ✓ ${msg}`);

if (API_KEY) {
  await page.addInitScript((key) => {
    localStorage.setItem('wangke-settings', JSON.stringify({
      state: { apiKey: key, baseUrl: 'https://api.siliconflow.cn/v1', llmModel: 'deepseek-ai/DeepSeek-V4-Flash' },
      version: 0,
    }));
  }, API_KEY);
}

console.log('1. 打开首页并导入测试视频');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });

// 直接读 IndexedDB 拿 videoId，并种子字幕（6 分钟讲课内容，供弹幕生成/飘屏用）
const videoId = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('wangke'); q.onsuccess = () => res(q.result); q.onerror = rej; });
  const all = await new Promise((res, rej) => { const q = db.transaction('videos', 'readonly').objectStore('videos').getAll(); q.onsuccess = () => res(q.result); q.onerror = rej; });
  return all[all.length - 1].id;
});
ok(`videoId = ${videoId}`);

// 种子字幕：一段关于「曝光三要素」的摄影课 transcript（每 ~10s 一条，共 6 分钟）
const TRANSCRIPT = [
  ['0:05', '今天我们讲摄影里最基础也最重要的概念：曝光三要素。'],
  ['0:18', '曝光三要素分别是光圈、快门速度和感光度，也就是 ISO。'],
  ['0:35', '光圈是镜头里控制进光量的开口，用 f 值表示。'],
  ['0:50', '注意，f 值越小，光圈开口越大，进光量反而越多。'],
  ['1:08', '大光圈还有一个效果：景深变浅，背景会虚化。'],
  ['1:25', '快门速度是感光元件暴露在光线下的时间。'],
  ['1:40', '快门越快，越能凝固运动的物体，但进光量会减少。'],
  ['1:58', '拍流水时，慢门能拉出丝绢般的效果。'],
  ['2:15', 'ISO 是感光度，数值越高，画面越亮。'],
  ['2:30', '但提高 ISO 的代价是噪点变多，画质下降。'],
  ['2:50', '这三者互相制衡，改变任何一个，都要用另外两个补偿。'],
  ['3:10', '这就是曝光三角：光圈、快门、ISO 共同决定最终曝光量。'],
  ['3:32', '举个例子：光圈开大一档，快门就要加快一档，或者 ISO 降低一档。'],
  ['3:55', '所以曝光补偿的本质，是在三者之间做取舍。'],
  ['4:20', '拍人像时优先大光圈，因为我们要浅景深突出主体。'],
  ['4:45', '拍运动场景优先保证快门速度，宁可提高 ISO 牺牲一点画质。'],
  ['5:10', '风光摄影则相反：小光圈大景深，ISO 尽量低，快门交给三脚架。'],
  ['5:35', '理解了曝光三角，你就理解了相机所有曝光模式的设计逻辑。'],
].map(([t, text], i) => {
  const [m, s] = t.split(':').map(Number);
  const start = m * 60 + s;
  return { videoId, idx: i, start, end: start + 8, text, status: 1 };
});

await page.evaluate(async (rows) => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('wangke'); q.onsuccess = () => res(q.result); q.onerror = rej; });
  await new Promise((res, rej) => { const tx = db.transaction('segments', 'readwrite'); tx.objectStore('segments').clear(); tx.oncomplete = res; tx.onerror = rej; });
  await new Promise((res, rej) => {
    const tx = db.transaction('segments', 'readwrite');
    const store = tx.objectStore('segments');
    for (const r of rows) store.add(r);
    tx.oncomplete = res; tx.onerror = rej;
  });
}, TRANSCRIPT);
ok('已种子 18 条字幕（6 分钟摄影课）');

console.log('2. 进入播放页，等视频就绪，切到「弹幕」页');
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });
await page.waitForFunction(
  () => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.duration > 0; },
  { timeout: 15000 },
);
await page.click('[data-testid="panel-tab-dm"]');
await page.waitForSelector('[data-testid="dm-generate"]', { timeout: 10000 });
ok('弹幕 Tab 已出现，生成按钮可用');

if (API_KEY) {
  console.log('3. 点击「生成弹幕」（真实 API），等列表出条目');
  await page.click('[data-testid="dm-generate"]');
  const deadline = Date.now() + 120000;
  let count = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    count = await page.locator('[role="tabpanel"]:visible .sub-item').count();
    const paneText = await page.locator('[role="tabpanel"]:visible').innerText();
    console.log('  …', paneText.replace(/\n/g, ' | ').slice(0, 120));
    if (count > 0 || paneText.includes('失败') || paneText.includes('没有挖出')) break;
  }
  if (count === 0) fail('生成结束后弹幕列表仍为空');
  else {
    ok(`生成 ${count} 条思考题弹幕`);
    const rows = await page.evaluate(async (vid) => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open('wangke'); q.onsuccess = () => res(q.result); q.onerror = rej; });
      const all = await new Promise((res, rej) => { const q = db.transaction('danmakus', 'readonly').objectStore('danmakus').getAll(); q.onsuccess = () => res(q.result); q.onerror = rej; });
      return all.filter((d) => d.videoId === vid).map((d) => ({ time: d.time, len: d.text.length }));
    }, videoId);
    if (rows.some((r) => r.time < 0 || r.time > 380)) fail(`存在越界时间戳：${JSON.stringify(rows)}`);
    if (rows.some((r) => r.len > 60)) fail('存在超长弹幕（>60 字）');
    ok(`落库校验通过：${JSON.stringify(rows.slice(0, 5))}${rows.length > 5 ? ' …' : ''}`);
  }
} else {
  console.log('3. 无 SF_KEY，跳过 LLM 生成，直接种子 3 条弹幕测飘屏');
  await page.evaluate(async (vid) => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('wangke'); q.onsuccess = () => res(q.result); q.onerror = rej; });
    await new Promise((res, rej) => {
      const tx = db.transaction('danmakus', 'readwrite');
      const store = tx.objectStore('danmakus');
      store.add({ videoId: vid, time: 3, text: 'f 值越小光圈越大，这个反直觉的对应关系怎么记？' });
      store.add({ videoId: vid, time: 8, text: '拍好动的孩子时，三要素里应该优先保哪一个？' });
      store.add({ videoId: vid, time: 400, text: '曝光三角的取舍思路能用到录音增益调节上吗？' });
      tx.oncomplete = res; tx.onerror = rej;
    });
  }, videoId);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('video', { timeout: 15000 });
  await page.click('[data-testid="panel-tab-dm"]');
  // 弹幕面板是切到该 Tab 才挂载的，列表要等面板挂载后的一次 IndexedDB 读取落定
  await page.waitForTimeout(800);
  const count = await page.locator('[role="tabpanel"]:visible .sub-item').count();
  if (count !== 3) fail(`弹幕列表应有 3 条，实际 ${count}`);
  else ok('3 条种子弹幕已入列表');
}

console.log('4. 弹幕列表点击跳转：点第 2 条，播放器跳到对应时间');
const items = page.locator('[role="tabpanel"]:visible .sub-item');
const secondTime = await page.evaluate(async (vid) => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('wangke'); q.onsuccess = () => res(q.result); q.onerror = rej; });
  const all = await new Promise((res, rej) => { const q = db.transaction('danmakus', 'readonly').objectStore('danmakus').getAll(); q.onsuccess = () => res(q.result); q.onerror = rej; });
  return all.filter((d) => d.videoId === vid).sort((a, b) => a.time - b.time).map((d) => d.time);
}, videoId);
if (secondTime.length >= 2) {
  await items.nth(1).click();
  await page.waitForTimeout(400);
  const ct = await page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
  if (Math.abs(ct - secondTime[1]) > 1.5) fail(`点击跳转应到 ${secondTime[1]}s，实际 ${ct.toFixed(1)}s`);
  else ok(`点击跳转 ${ct.toFixed(1)}s ≈ ${secondTime[1]}s`);
}

console.log('5. 飘屏验证：seek 到第一条弹幕前 2s 播放，弹幕应自右向左飘过');
const firstTime = secondTime[0] ?? 3;
await page.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = Math.max(0, t - 2); v.play(); }, firstTime);
const dmItem = page.locator('.dm-item');
const shown = await dmItem.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
if (!shown) fail(`播放到 ${firstTime}s 时应飘出弹幕`);
else {
  ok(`弹幕已飘出：「${(await dmItem.innerText()).replace(/\n/g, ' ')}」`);
  // 同屏最多 1 条
  if ((await page.locator('.dm-item').count()) !== 1) fail('同屏弹幕应只有 1 条');
  const boxOk = await dmItem.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const host = document.querySelector('[data-media-player]').getBoundingClientRect();
    return r.top > host.top && r.top < host.top + host.height * 0.3;
  });
  if (!boxOk) fail('弹幕应出现在画面上部 30% 区域');
  else ok('弹幕位于画面顶部区域');

  // 方向：隔一段时间采两次左边界，必须单调向左。这是这个用例唯一的「方向」断言 ——
  // 位置与消失都测不出方向，原地弹出同样能全绿（这正是之前没能拦住回归的原因）。
  await page.waitForTimeout(1200);
  const x1 = await dmItem.evaluate((el) => el.getBoundingClientRect().left);
  await page.waitForTimeout(1200);
  const x2 = await dmItem.evaluate((el) => el.getBoundingClientRect().left);
  if (!(x2 < x1)) fail(`弹幕应从右向左飘：测得 left ${x1.toFixed(1)} → ${x2.toFixed(1)}`);
  else ok(`自右向左飘动（left ${x1.toFixed(1)} → ${x2.toFixed(1)}）`);

  await page.screenshot({ path: 'e2e-shots/danmaku-scroll.png' });
  // 动画播完自动消失。时长按恒定线速度算（7~16s），不写死睡眠时长
  const gone = await dmItem.waitFor({ state: 'detached', timeout: 25000 }).then(() => true).catch(() => false);
  if (!gone) fail('弹幕应在飘出画面后自动消失');
  else ok('弹幕已自动消失');
}

console.log('6. seek 回退重发：拖回第一条之前，弹幕应再次弹出');
// 带上 play()：上一步是等弹幕飘完才往下走的，此时视频多半已经播到结尾，只 seek 不回放
// 就一直停在原地、永远到不了弹幕的时间点（真实用户拖回去也是接着看的）
await page.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = Math.max(0, t - 1.5); v.play(); }, firstTime);
const reshown = await dmItem.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
if (!reshown) fail('seek 回退后弹幕应重新弹出');
else ok('seek 回退后弹幕重发正常');

// 控制栏 idle 会自动隐藏：先移入播放器唤醒（真实用户同理）。
// 先挪出去再挪进来 —— reload 之后鼠标可能仍停在播放器原位上，同坐标的 mousemove
// 不一定会重算 :hover，控制栏就一直是 visibility:hidden，点不到按钮。
const wakeControls = async () => {
  const box = await page.locator('[data-media-player]').boundingBox();
  await page.mouse.move(1, 1);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.waitForTimeout(300);
};

console.log('7. 控制栏开关：关闭后弹幕不再弹出，刷新后保持关闭');
await wakeControls();
await page.locator('.dm-toggle-btn').click();
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings') ?? '{}'));
if (stored?.state?.danmakuEnabled !== false) fail('localStorage 应持久化 danmakuEnabled=false');
else ok('开关已持久化（关）');
await page.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = Math.max(0, t - 1.5); }, firstTime);
await page.waitForTimeout(Math.min(6000, (firstTime + 3) * 1000));
if ((await page.locator('.dm-item').count()) !== 0) fail('关闭开关后不应再弹出弹幕');
else ok('关闭后弹幕不再弹出');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('video', { timeout: 15000 });
const storedAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings') ?? '{}'));
if (storedAfter?.state?.danmakuEnabled !== false) fail('刷新后开关应保持关闭');
else ok('刷新后开关保持关闭');
// 恢复开启，避免影响其他 e2e。开关本身在上面已经验过（点得到、且持久化正确），
// 这一步只是收尾：刷新后能不能唤醒控制栏依赖 hover 时序，headless 下偶发点不到，
// 点不到就直接把设置改回去，不让收尾把一条断言全绿的用例判红。
await wakeControls();
const restored = await page.locator('.dm-toggle-btn').click({ timeout: 5000 }).then(() => true).catch(() => false);
if (!restored) {
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('wangke-settings') ?? '{}');
    raw.state = { ...raw.state, danmakuEnabled: true };
    localStorage.setItem('wangke-settings', JSON.stringify(raw));
  });
}
ok(`已恢复开启（${restored ? '点击控制栏开关' : '直接改设置 · 控制栏没唤醒'}）`);

await browser.close();
if (process.exitCode) process.exit(process.exitCode);
console.log(`✅ 弹幕链路通过：${API_KEY ? 'LLM 生成 + ' : ''}列表跳转 / 自右向左飘屏 / seek 重发 / 开关持久化 全部正常`);
