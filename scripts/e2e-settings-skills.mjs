/* eslint-disable no-console */
// 设置页「写作技能」：列表渲染 + 新建对话框的开 / 存 / 拦 / 关。
//
// 为什么单独一个脚本：这一块是阶段 1 里最容易出隐蔽缺陷的地方 ——
//   1. mdui-list-item 的 `slot="headline"` 并不存在（官方 JSX 注释写错了），
//      内容会被静默丢弃、整行只剩按钮（实测踩到过）；
//   2. mdui-dialog 的 open 是受控的，但它自己响应 Esc / 点遮罩时只会把 open 属性拿掉，
//      React 的 state 不知道 → 不同步就会「关掉又自己弹回」。
// 这两类问题构建和类型检查都抓不到，只能在真实浏览器里点。
//
// 用法：node scripts/e2e-settings-skills.mjs   （需先 npm run preview）
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 250));
});

const dialog = page.locator('[data-testid="skill-dialog"]');
const rows = page.locator('[data-testid="skill-row"]');
const isOpen = () => dialog.evaluate((el) => el.hasAttribute('open'));

console.log('=== 设置页写作技能（阶段 1 交互）===');

await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="card-skills"] [data-testid="skill-row"]', { timeout: 15000 });

// ── 1. 列表渲染：每行都要有名字（回归 slot="headline" 那个坑） ──────────────
const listText = await page.locator('[data-testid="card-skills"]').innerText();
const hasBuiltin = listText.includes('公文讲义写作');
const rowCount = await rows.count();
check(rowCount > 0, `技能列表有 ${rowCount} 行`);
check(hasBuiltin, '行内渲染出技能名（不是只有按钮）');
check(
  (await page.locator('[data-testid="skill-toggle"]').count()) === rowCount,
  '每行都有启用开关',
);
check(
  (await page.locator('[data-testid="skill-edit"]').count()) === rowCount,
  '每行都有查看/编辑按钮',
);

// ── 2. 新建对话框：打开 ──────────────────────────────────────────────────
await page.click('[data-testid="btn-skill-new"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="skill-dialog"]')?.hasAttribute('open'),
  { timeout: 5000 },
);
check(await isOpen(), '点「新建」打开对话框');
check(await page.locator('[data-testid="skill-name"] input').count() === 1, '名称为单行输入');
check(await page.locator('[data-testid="skill-body"] textarea').count() === 1, '正文为多行文本域');

// ── 3. 名称为空时不允许保存 ──────────────────────────────────────────────
const before = await rows.count();
await page.click('[data-testid="skill-save"]');
await page.waitForTimeout(400);
check(await isOpen(), '名称为空时保存被拦下（对话框保持打开）');
check((await rows.count()) === before, '名称为空时未新增行');

// ── 4. Esc 关闭，且不会自己弹回（受控 open + closed 同步） ────────────────
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
check(!(await isOpen()), 'Esc 可关闭对话框');
await page.waitForTimeout(900);
check(!(await isOpen()), '关闭后不会自己弹回来（closed 事件已同步回 React state）');

// ── 5. 正常保存 ─────────────────────────────────────────────────────────
const NAME = 'E2E 冒烟技能';
await page.click('[data-testid="btn-skill-new"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="skill-dialog"]')?.hasAttribute('open'),
  { timeout: 5000 },
);
await page.locator('[data-testid="skill-name"] input').fill(NAME);
await page.locator('[data-testid="skill-body"] textarea').fill('用于端到端冒烟测试的技能正文。');
await page.click('[data-testid="skill-save"]');
await page.waitForTimeout(900);
check(!(await isOpen()), '保存后对话框关闭');
check((await rows.count()) === before + 1, `保存后新增一行（${before} → ${await rows.count()}）`);
check(
  (await page.locator('[data-testid="card-skills"]').innerText()).includes(NAME),
  '新技能出现在列表里',
);

// ── 6. 打开后取消，不新增 ────────────────────────────────────────────────
await page.click('[data-testid="btn-skill-new"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="skill-dialog"]')?.hasAttribute('open'),
  { timeout: 5000 },
);
await page.locator('[data-testid="skill-name"] input').fill('不该被保存的技能');
await page.click('[data-testid="skill-cancel"]');
await page.waitForTimeout(700);
check(!(await isOpen()), '点「取消」关闭对话框');
check((await rows.count()) === before + 1, '取消后没有新增行');

await page.screenshot({ path: 'e2e-shots/settings-skills.png' });

console.log(errors.length ? `[console errors]\n${errors.join('\n')}` : '无 console/page 错误');
await browser.close();
console.log(failed === 0 ? '\n✅ 设置页写作技能交互通过' : `\n❌ 有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
