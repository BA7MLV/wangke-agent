/* eslint-disable no-console */
// 设置页页脚的「构建信息」：断言「构建期注入 → 真实产物 → DOM」这条链路是通的。
//
// 为什么单独一个脚本、不并进 e2e-settings-skills：验证对象不同。那个脚本测的是
// Skills 的对话框交互（开/存/拦/关）；这个测的是**构建期注入链路** ——
// 单测只能测纯函数，测不出 define 配没配对、类型声明对不对、注入值有没有真的进产物。
//
// ⚠️ 跑的是**当前 dist/**（e2e-all.mjs 不碰构建）。改了注入逻辑后必须先 npm run build。
//    若「commit 与 git HEAD 一致」红了，八成是 dist 陈旧而不是功能坏了 —— 提示里写清楚了。
//
// 用法：npm run preview &（4173）→ node scripts/e2e-build-info.mjs
//      改打 dev：BASE_URL=http://localhost:5173 node scripts/e2e-build-info.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:4173';
const IS_DEV = /:5173\b/.test(BASE);

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

console.log(`=== 设置页构建信息（${IS_DEV ? 'dev 5173' : 'preview 4173'}）===`);

const info = page.locator('[data-testid="build-info"]');
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
await info.waitFor({ state: 'visible', timeout: 15000 });
const text = (await info.innerText()).trim();
console.log(`   文案：${text}`);

// ── 1. 存在且非空 ─────────────────────────────────────────────────────────
check(text.length > 0, '页脚文案非空（注入丢了会退化成「未知版本」，不是空白）');

// ── 2. 格式：注入链路通到了 DOM ───────────────────────────────────────────
if (IS_DEV) {
  check(/^v\S+ · 开发模式$/.test(text), 'dev 下显示「开发模式」，不展示配置加载时刻');
} else {
  check(
    /^v\S+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}( · [0-9a-f]{7,40})?$/.test(text),
    '生产文案形如「v版本 · YYYY-MM-DD HH:mm · commit」',
  );
}

// ── 3. 位置：真的在设置页最底下 ───────────────────────────────────────────
// 需求就是「最底下」，所以按几何断言而不是按 DOM 顺序 ——
// 顺序对了但被别的东西盖住/挤到上面，同样是没做到。
const skills = await page.locator('[data-testid="card-skills"]').boundingBox();
const footer = await info.boundingBox();
check(
  !!skills && !!footer && footer.y > skills.y + skills.height,
  '位于最后一张卡片（写作技能）下方',
);

// ── 4. 时间是构建期常量，不是运行时取的 ───────────────────────────────────
if (!IS_DEV) {
  const timeText = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)?.[0] ?? '';
  const assetsDir = path.join(root, 'dist/assets');
  let inlined = false;
  if (timeText && existsSync(assetsDir)) {
    for (const f of readdirSync(assetsDir)) {
      if (!f.endsWith('.js')) continue;
      if (readFileSync(path.join(assetsDir, f), 'utf8').includes(timeText)) {
        inlined = true;
        break;
      }
    }
  }
  // 这条抓的是「误用运行时 new Date()」这个最危险的写法：那种实现下
  // 产物里根本不存在这个时间字面量（值是运行时算出来的）。
  check(inlined, `构建时间以字面量形式内联在产物里（${timeText}）`);
}

await page.reload({ waitUntil: 'networkidle' });
await info.waitFor({ state: 'visible', timeout: 15000 });
const textAfter = (await info.innerText()).trim();
// 兜底断言：运行时取值的话跨分钟会变。局限是必须跨到下一分钟才暴露，
// 所以它不承担主判断，真正的判据是上面那条「产物里有字面量」。
check(textAfter === text, '重新加载后文案不变');

// ── 5. commit 与仓库一致（抓 dist 陈旧）────────────────────────────────────
if (!IS_DEV) {
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const shown = text.split(' · ')[2] ?? '';
  check(
    shown === head,
    shown === head
      ? `commit 与仓库 HEAD 一致（${head}）`
      : `commit 不一致：页面 ${shown || '(未显示)'} / 仓库 ${head}` +
          ' —— dist 是旧构建，先 npm run build 再跑',
  );
}

check(errors.length === 0, errors.length ? `控制台有报错：${errors[0]}` : '无控制台报错');

// ── 6. dev 档额外核对：注入值本身（版本 / 时间格式 / commit）────────────────
// dev 下 vite 把 define 的值「定义为全局」而不是静态替换（与 build 是两条路径），
// 所以这里能直接读到注入的原始值 —— 正好补上 dev 档验不到产物字面量的缺口。
// ⚠️ 这依赖 vite 的实现细节：若它哪天改成 dev 也静态替换，全局就没了。
//    因此「读不到」只提示、不判红，免得把 vite 的行为变化当成功能回归。
if (IS_DEV) {
  const injected = await page.evaluate(() => globalThis.__BUILD_INFO__ ?? null);
  if (!injected) {
    console.log('   - 跳过注入值核对：dev 下未暴露 __BUILD_INFO__ 全局（vite 行为变化，非回归）');
  } else {
    const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    check(injected.version === pkgVersion, `注入版本号来自 package.json（${injected.version}）`);
    check(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(injected.time),
      `注入时间格式正确（${injected.time}）`,
    );
    check(injected.commit === head, `注入 commit 与仓库 HEAD 一致（${head}）`);
  }
}

// 截图前先滚到页脚：全页截图里这一行在最底部，缩略后根本看不清，
// 留着当证据等于没留。滚动后截视口，图小且重点明确。
await info.scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(root, 'e2e-shots/build-info.png') });
await browser.close();

console.log(failed ? `\n${failed} 项失败\n` : '\n全部通过\n');
process.exit(failed ? 1 : 0);
