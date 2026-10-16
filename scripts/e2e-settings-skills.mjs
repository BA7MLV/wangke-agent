/* eslint-disable no-console */
// 设置页「写作技能」：列表渲染 + 新建对话框的开 / 存 / 拦 / 关。
//
// 为什么单独一个脚本：这一块是阶段 1 里最容易出隐蔽缺陷的地方 ——
//   1. 列表项的 `slot="headline"` 曾经并不存在，内容会被静默丢弃、整行只剩按钮（实测踩到过）；
//   2. 对话框的开合是受控的，但它自己响应 Esc / 点遮罩时若不同步回 state，就会「关掉又自己弹回」。
// 这两类问题构建和类型检查都抓不到，只能在真实浏览器里点。
//
// ⚠️ 「对话框是否打开」看的是**节点在不在 DOM 里**，不再看 `open` 属性：
// 编辑框早就从原生 `<dialog>` 换成 HeroUI 的 `Modal`（`Modal.Root isOpen`），
// RAC 的 DialogTrigger 只在打开时渲染 children —— 节点存在 == 开着，
// 而且节点消失才真的意味着「关干净了」（原生 `<dialog open>` 那种「属性没了但节点还在」
// 的中间态正是这个脚本当初要抓的东西，现在换成「节点没了」来判，更严格）。
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

// ⚠️ 「对话框是否打开」看的是**编辑表单在不在 DOM 里**，不是 `open` 属性、也不是
// `[data-testid="skill-dialog"]` 这个壳：编辑框早就从原生 `<dialog>` 换成 HeroUI 的
// `Modal`，而 RAC 的退场动画会把壳留在 DOM 上一段时间（`data-exiting`），
// 按壳判断会把「已经空了」误读成「还开着」。
const editorForm = page.locator('[data-testid="skill-name"] input');
const rows = page.locator('[data-testid="skill-row"]');
const isOpen = () => editorForm.count().then((n) => n > 0);
/** 等编辑表单真的出现（RAC 异步挂载） */
const waitOpen = () => editorForm.first().waitFor({ state: 'visible', timeout: 8000 });
/** 点一下就走的辅助步骤；元素不在就记一笔失败并跳过，不让整个脚本崩掉 */
async function clickOrSkip(selector, what) {
  if ((await page.locator(selector).count()) === 0) {
    fail(`${what}：找不到 ${selector}`);
    return false;
  }
  await page.locator(selector).first().click();
  return true;
}

console.log('=== 设置页写作技能（阶段 1 交互）===');

// 写作技能在「数据」模块里，而 `#/settings` 只落到默认的「模型」模块 ——
// 必须直接深链过去，否则脚本会一直等一张不存在的卡片。
await page.goto(`${BASE}/#/settings/data`, { waitUntil: 'networkidle' });
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
await waitOpen();
check(await isOpen(), '点「新建」打开对话框');
check((await page.locator('[data-testid="skill-name"] input').count()) === 1, '名称为单行输入');
check((await page.locator('[data-testid="skill-body"] textarea').count()) === 1, '正文为多行文本域');

// ── 3. 名称为空时不允许保存 ──────────────────────────────────────────────
const before = await rows.count();
if (await clickOrSkip('[data-testid="skill-save"]', '空名点保存')) {
  await page.waitForTimeout(500);
  check(await isOpen(), '名称为空时保存被拦下（对话框保持打开）');
  check((await rows.count()) === before, '名称为空时未新增行');
}

// ── 4. Esc 关闭，且不会自己弹回（受控 open + closed 同步） ────────────────
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
check(!(await isOpen()), 'Esc 可关闭对话框');
await page.waitForTimeout(1200);
check(!(await isOpen()), '关闭后不会自己弹回来（closed 事件已同步回 React state）');
check(
  (await page.locator('[data-testid="settings-modal"]').count()) === 1,
  'Esc 只关编辑框，不连带关掉设置面板本身',
);

// ── 5. 正常保存 ─────────────────────────────────────────────────────────
const NAME = 'E2E 冒烟技能';
if (await clickOrSkip('[data-testid="btn-skill-new"]', '再次点新建')) {
  await waitOpen();
  if (await isOpen()) {
    await page.locator('[data-testid="skill-name"] input').fill(NAME);
    await page.locator('[data-testid="skill-body"] textarea').fill('用于端到端冒烟测试的技能正文。');
    if (await clickOrSkip('[data-testid="skill-save"]', '点保存')) {
      await page.waitForTimeout(1200);
      check(!(await isOpen()), '保存后对话框关闭');
      check((await rows.count()) === before + 1, `保存后新增一行（${before} → ${await rows.count()}）`);
      check(
        (await page.locator('[data-testid="card-skills"]').innerText()).includes(NAME),
        '新技能出现在列表里',
      );
    }
  } else {
    fail('再次点「新建」没有打开编辑框');
  }
}

// ── 6. 打开后取消，不新增 ────────────────────────────────────────────────
if (await clickOrSkip('[data-testid="btn-skill-new"]', '第三次点新建')) {
  await waitOpen();
  if (await isOpen()) {
    await page.locator('[data-testid="skill-name"] input').fill('不该被保存的技能');
    if (await clickOrSkip('[data-testid="skill-cancel"]', '点取消')) {
      await page.waitForTimeout(900);
      check(!(await isOpen()), '点「取消」关闭对话框');
      check((await rows.count()) === before + 1, '取消后没有新增行');
    }
  } else {
    fail('第三次点「新建」没有打开编辑框');
  }
}

await page.screenshot({ path: 'e2e-shots/settings-skills.png' });

console.log(errors.length ? `[console errors]\n${errors.join('\n')}` : '无 console/page 错误');
await browser.close();
console.log(failed === 0 ? '\n✅ 设置页写作技能交互通过' : `\n❌ 有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
