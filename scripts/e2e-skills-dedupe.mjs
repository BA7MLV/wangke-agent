/* eslint-disable no-console */
// 内置写作技能的「补齐」必须是幂等的（同名内置只允许一行）。
//
// 为什么单独一个脚本、且**只能跑 dev(5173)**：
//   `ensureBuiltinSkills()` 是「先按名查、查不到就插」，调用点有 4 个且互不感知
//   （设置页 SkillsCard 的 effect、HandoutPanel、ChatPanel、skills/router）。
//   React StrictMode 在 dev 下会把 effect 跑两次 → 两个调用并发进入循环、
//   都在任何一次插入落库之前查完 → 6 个内置技能插成 12 行。
//   **生产构建不触发 StrictMode 双调用，所以这个 bug 在 preview 档下根本不存在**——
//   只跑 preview 的断言是没有牙齿的。实测对照：dev 12 行 / 生产 6 行。
//
// 覆盖两层：
//   1. 页面自身加载（dev StrictMode 双调用）后，内置行不得重复；
//   2. 显式并发调用 3 次（不依赖 StrictMode 时机，确定性复现），不得重复，
//      且不得碰到同名用户副本。
//
// 用法：node scripts/e2e-skills-dedupe.mjs   （需先 npm run dev）
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';

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

console.log('=== 内置写作技能幂等性（dev 档）===');

await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="card-skills"] [data-testid="skill-row"]', { timeout: 20000 });
// 等首屏那轮补齐彻底落库（StrictMode 双调用的第二次也跑完）
await page.waitForTimeout(1500);

// ── 1. 页面自身加载后不得有重复内置行 ──────────────────────────────────────
const afterBoot = await page.evaluate(async () => {
  const { db } = await import('/src/store/db.ts');
  const { BUILTIN_SKILLS } = await import('/src/skills/builtin.ts');
  const builtinRows = (await db.skills.toArray()).filter((r) => !!r.builtin);
  const names = builtinRows.map((r) => r.name);
  return {
    expect: BUILTIN_SKILLS.length,
    actual: builtinRows.length,
    dupes: [...new Set(names.filter((n, i) => names.indexOf(n) !== i))],
    expectedNames: BUILTIN_SKILLS.map((s) => s.name),
    missing: BUILTIN_SKILLS.map((s) => s.name).filter((n) => !names.includes(n)),
  };
});
check(
  afterBoot.actual === afterBoot.expect,
  `页面加载后内置技能 ${afterBoot.actual} 行（应为 ${afterBoot.expect}）`,
);
check(afterBoot.dupes.length === 0, `无重复内置技能（重复：${JSON.stringify(afterBoot.dupes)}）`);
check(afterBoot.missing.length === 0, `内置技能未缺失（缺：${JSON.stringify(afterBoot.missing)}）`);

// ── 2. 显式并发调用：确定性复现（不依赖 StrictMode 时机） ──────────────────
const concurrent = await page.evaluate(async () => {
  const { db } = await import('/src/store/db.ts');
  const { BUILTIN_SKILLS } = await import('/src/skills/builtin.ts');
  const { ensureBuiltinSkills } = await import('/src/skills/store.ts');

  // 清掉内置行，回到「首次启动」的干净状态（用户行保留，后面要验证它不受影响）
  const builtinIds = (await db.skills.toArray()).filter((r) => !!r.builtin).map((r) => r.id);
  await db.skills.bulkDelete(builtinIds);

  // 放一个与内置技能同名的**用户副本**，补齐过程绝不能碰它
  const first = BUILTIN_SKILLS[0];
  const copyId = await db.skills.add({
    name: first.name,
    description: '用户自己改过的副本',
    body: '用户自己改过的正文',
    enabled: 1,
    builtin: 0,
    updatedAt: Date.now(),
  });

  await Promise.all([ensureBuiltinSkills(), ensureBuiltinSkills(), ensureBuiltinSkills()]);

  const rows = await db.skills.toArray();
  const builtinRows = rows.filter((r) => !!r.builtin);
  const names = builtinRows.map((r) => r.name);
  const copy = rows.find((r) => r.id === copyId);
  return {
    expect: BUILTIN_SKILLS.length,
    actual: builtinRows.length,
    dupes: [...new Set(names.filter((n, i) => names.indexOf(n) !== i))],
    copyIntact: copy?.body === '用户自己改过的正文' && copy?.builtin === 0,
  };
});
check(
  concurrent.actual === concurrent.expect,
  `并发调用 3 次后内置技能 ${concurrent.actual} 行（应为 ${concurrent.expect}）`,
);
check(concurrent.dupes.length === 0, `并发调用未产生重复（重复：${JSON.stringify(concurrent.dupes)}）`);
check(concurrent.copyIntact, '同名用户副本未被补齐过程改动');

// ── 3. 补齐后 UI 行数 = 内置数 + 1 个手动技能（新建对话框先不掺和） ────────
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="skill-row"]', { timeout: 20000 });
await page.waitForTimeout(1200);
const uiRows = await page.locator('[data-testid="skill-row"]').count();
check(
  uiRows === concurrent.expect + 1,
  `重载后列表 ${uiRows} 行（应为内置 ${concurrent.expect} + 1 个用户副本）`,
);

console.log(errors.length ? `[page errors]\n${errors.join('\n')}` : '无 page 错误');
await browser.close();
console.log(failed === 0 ? '\n✅ 内置技能补齐幂等性通过' : `\n❌ 有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
