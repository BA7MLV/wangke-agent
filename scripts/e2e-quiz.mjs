/* eslint-disable no-console */
// E2E：出题题卡链路（present_quiz 工具 → 题卡渲染 → 点选判分 → 作答状态持久化）
import { chromium } from 'playwright';

const API_KEY = process.env.SF_KEY;
const TEST_FILE = process.env.TEST_FILE;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
page.on('response', (r) => { if (r.status() >= 400) console.log('[HTTP', r.status() + ']', r.url().slice(0, 100)); });

await page.addInitScript((key) => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: { apiKey: key, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra', llmModel: 'deepseek-ai/DeepSeek-V4-Flash', visionModel: 'Qwen/Qwen3-VL-32B-Instruct' },
    version: 0,
  }));
}, API_KEY);

await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 15000 });
await page.click('[data-testid="btn-play"]');
await page.waitForSelector('video', { timeout: 15000 });

console.log('1. 生成字幕');
await page.click('[data-testid="subs-generate"]');
let deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  const t = await page.locator('.side-pane').innerText();
  if (t.includes('进程') || t.includes('失败')) break;
}

console.log('2. 切到问答页，等待索引自动建立');
await page.click('[data-testid="panel-tab-chat"]');
deadline = Date.now() + 120000;
let indexOk = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  const placeholder = await page.locator('.side-pane textarea').getAttribute('placeholder').catch(() => null);
  if (placeholder && placeholder.includes('输入问题')) { indexOk = true; break; }
}
console.log('  索引就绪:', indexOk);

let pass = false;
if (indexOk) {
  // 落库是回答完成的确定性信号（rowId 在落库后才挂上，作答回写依赖它）
  const countAi = () => page.evaluate(async () => {
    const req = indexedDB.open('wangke');
    const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
    const tx = db.transaction('chats', 'readonly');
    const all = await new Promise((res, rej) => { const q = tx.objectStore('chats').getAll(); q.onsuccess = () => res(q.result); q.onerror = rej; });
    db.close();
    return all.filter((r) => r.role === 'assistant').length;
  });
  const aiBefore = await countAi();

  console.log('3. 点击出题按钮');
  await page.click('[data-testid="quiz-btn"]');

  console.log('4. 等待题卡出现（agent 检索 + 出题）');
  const card = page.locator('[data-testid="quiz-card"]');
  try {
    await card.waitFor({ timeout: 180000 });
    console.log('  题卡已出现');
    const optionCount = await card.locator('button').count();
    console.log('  选项按钮数:', optionCount);

    // 等最终回答落库（rowId 挂上后再作答，回写才会生效）
    deadline = Date.now() + 60000;
    while (Date.now() < deadline && (await countAi()) <= aiBefore) await page.waitForTimeout(1000);
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'e2e-shots/9-quiz-card.png', fullPage: true });

    console.log('5. 作答第 1 题');
    await card.locator('button').first().click();
    await page.waitForTimeout(500);
    const judged = await card.innerText();
    const judgedOk = judged.includes('回答正确') || judged.includes('正确答案');
    console.log('  判分与解析出现:', judgedOk);
    await page.screenshot({ path: 'e2e-shots/10-quiz-judged.png', fullPage: true });

    console.log('6. 刷新页面，验证作答状态持久化');
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('[data-testid="btn-play"]');
    await page.waitForSelector('video', { timeout: 15000 });
    await page.click('[data-testid="panel-tab-chat"]');
    await page.waitForSelector('[data-testid="quiz-card"]', { timeout: 15000 });
    const restored = await page.locator('[data-testid="quiz-card"]').innerText();
    const persisted = restored.includes('回答正确') || restored.includes('正确答案');
    console.log('  刷新后作答状态保留:', persisted);

    pass = judgedOk && persisted && optionCount >= 4;
  } catch (e) {
    console.log('  题卡未出现:', String(e).slice(0, 200));
    await page.screenshot({ path: 'e2e-shots/9-quiz-fail.png', fullPage: true });
  }
}

console.log(pass ? '✅ 出题题卡 E2E 通过' : '⚠️ 出题题卡 E2E 未通过');
await browser.close();
process.exit(pass ? 0 : 3);
