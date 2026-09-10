/* eslint-disable no-console */
// 阶段 0 验收：React 19 + mdui 基建在**真实浏览器**里确实生效、且没有污染既有界面。
//
// 为什么需要这个脚本（而不是只跑 tsc/build）：
//   - 「组件忘了注册」在 Web Components 里是**静默失败**——标签渲染成空白，不报错、不进控制台。
//     46 个自定义元素是否全部注册，只能在页面里问 customElements。
//   - mdui.css 是全局样式表，它给 :root 挂了 MD3 令牌（含 color / background-color / color-scheme）。
//     迁移期它与 antd 并存，必须守住「不改变现有界面观感」这条线。
//   - React 版本光看 package.json 不算数：react 与 react-dom 版本不一致会在启动时直接抛错。
//
// 用法：
//   node scripts/e2e-mdui-adapter.mjs                     # 默认 preview(4173)，生产构建
//   BASE_URL=http://localhost:5173 node scripts/e2e-mdui-adapter.mjs   # dev（多验两项：React 版本、mdui 语言包）
//
// 无需 API key、无需测试视频。preview 档需先 `npm run preview`。
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const isDev = /:5173\b/.test(BASE);
const root = new URL('..', import.meta.url).pathname;

// 期望注册的自定义元素清单：直接取 mdui 的 Custom Elements Manifest，不手抄
const manifest = JSON.parse(readFileSync(root + 'node_modules/mdui/custom-elements.json', 'utf8'));
const expectedTags = manifest.modules
  .flatMap((m) => m.declarations || [])
  .filter((d) => d.tagName)
  .map((d) => d.tagName)
  .sort();

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
});

console.log(`=== 阶段 0 验收（${BASE}，${isDev ? 'dev' : 'preview'} 档）===`);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// ── 1. 启动健康 ──────────────────────────────────────────────────────────
console.log('\n1. 应用启动');
const rootChildren = await page.evaluate(() => document.getElementById('root')?.childElementCount ?? 0);
check(rootChildren > 0, `#root 已挂载内容（子元素 ${rootChildren} 个）`);
// antd 弃用警告等属于既有噪声（基线里 e2e-preview-fonts 就是被它误判成红的），这里排除掉
const realConsoleErrors = consoleErrors.filter((t) => !/antd|Warning: \[antd/.test(t));
check(pageErrors.length === 0, `无 pageerror${pageErrors.length ? `：${pageErrors.join(' | ')}` : ''}`);
check(realConsoleErrors.length === 0, `无非 antd 类 console.error${realConsoleErrors.length ? `：${realConsoleErrors.join(' | ')}` : ''}`);

// ── 2. React 版本 ───────────────────────────────────────────────────────
console.log('\n2. React 版本');
if (isDev) {
  // dev 下可以直接 import 应用的同一份 react 模块实例（与项目里取 Dexie 实例同一手法）
  const version = await page.evaluate(async () => {
    const m = await import('/@id/react');
    return (m.default && m.default.version) || m.version || null;
  });
  check(version === '19.3.0', `React ${version}（期望 19.3.0）`);
} else {
  // 生产构建里拿不到模块句柄，改为断言产物内含 React 19 的版本标记
  const entry = await page.evaluate(async () => {
    const src = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')).find((s) => s && s.includes('/assets/index-'));
    if (!src) return null;
    return await (await fetch(src)).text();
  });
  check(!!entry, '找得到入口 bundle');
  check(!!entry && /version="19\.3\.0"/.test(entry), '入口 bundle 含 React 19 版本标记（version="19.3.0"）');
}

// ── 3. mdui 自定义元素注册 ───────────────────────────────────────────────
console.log('\n3. mdui 组件注册');
const unregistered = await page.evaluate((tags) => tags.filter((t) => !customElements.get(t)), expectedTags);
check(
  unregistered.length === 0,
  `${expectedTags.length} 个 mdui 自定义元素全部已注册${unregistered.length ? `，未注册：${unregistered.join(', ')}` : ''}`,
);

// ── 4. mdui.css 生效（设计令牌可用） ─────────────────────────────────────
console.log('\n4. mdui 设计令牌');
const tokens = await page.evaluate(() => {
  const s = getComputedStyle(document.documentElement);
  const names = [
    '--mdui-color-primary',
    '--mdui-color-surface',
    '--mdui-color-on-surface',
    '--mdui-shape-corner-large',
    '--mdui-elevation-level1',
    '--mdui-typescale-body-medium-size',
  ];
  return Object.fromEntries(names.map((n) => [n, s.getPropertyValue(n).trim()]));
});
const missingTokens = Object.entries(tokens).filter(([, v]) => !v).map(([k]) => k);
check(missingTokens.length === 0, `核心令牌全部有值${missingTokens.length ? `，缺失：${missingTokens.join(', ')}` : ''}`);
// 颜色令牌是 "R,G,B" 三元组形式，与 mdui 的 rgb(var(--x)) 用法保持一致
check(typeof tokens['--mdui-color-primary'] === 'string' && /^\d+,\d+,\d+$/.test(tokens['--mdui-color-primary']), '--mdui-color-primary 是 R,G,B 三元组');

// ── 5. 应用外壳：令牌底色 / Roboto / 主题切换（迁移期关键回归点） ──────────
console.log('\n5. 应用外壳（MD3 令牌底色 / 字体 / 深浅主题）');
const shell = await page.evaluate(() => {
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const token = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const rootEl = document.getElementById('root');
  const page = document.querySelector('.page');
  return {
    htmlFontSize: cs(document.documentElement)?.fontSize,
    rootBg: cs(rootEl)?.backgroundColor,
    bgToken: token('--mdui-color-background'),
    fontFamily: cs(document.body)?.fontFamily ?? '',
    themeClass: [...document.documentElement.classList].find((c) => c.startsWith('mdui-theme-')) ?? null,
    pageHeight: cs(page)?.height,
    // antd 已卸载（阶段 5）：这条从「两库并存互不污染」变成「确认真的删干净了」
    antdNodeCount: document.querySelectorAll('[class*="ant-"]').length,
  };
});
check(shell.htmlFontSize === '16px', `html 字号未被改动（${shell.htmlFontSize}）`);
const expectBg = `rgb(${shell.bgToken.split(',').join(', ')})`;
check(shell.rootBg === expectBg, `#root 底色走 MD3 令牌 --mdui-color-background（${shell.rootBg}）`);
check(/Roboto/.test(shell.fontFamily), `正文用 Roboto（中文字形回退系统字体）`);
check(!!shell.themeClass, `主题类已挂到 <html>（${shell.themeClass}）`);
check(shell.antdNodeCount === 0, `antd 已完全移除（残留 ${shell.antdNodeCount} 个 .ant- 节点）`);
// .page 的高度链：theme.css 用 height:100% 接通 #root → 断了会导致整页随内容滚动
check(!!shell.pageHeight && shell.pageHeight !== '0px' && shell.pageHeight !== 'auto', `.page 高度链未断（${shell.pageHeight}）`);

// 深浅主题：直接翻 <html> 上的主题类（mdui 的主题就是这一个类 + mdui.css 的色板），
// 用**相对亮度**判断，避免依赖具体色值。这样 preview / dev 两档都能验。
const themeSwap = await page.evaluate(() => {
  const html = document.documentElement;
  const root = document.getElementById('root');
  const lum = (c) => {
    const [r, g, b] = c.match(/[\d.]+/g).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const prev = [...html.classList].find((c) => c.startsWith('mdui-theme-'));
  const before = getComputedStyle(root).backgroundColor;
  html.classList.remove(prev);
  html.classList.add('mdui-theme-dark');
  const dark = getComputedStyle(root).backgroundColor;
  const darkText = getComputedStyle(root).color;
  html.classList.remove('mdui-theme-dark');
  html.classList.add(prev);
  const restored = getComputedStyle(root).backgroundColor;
  return { beforeLum: lum(before), darkLum: lum(dark), darkTextLum: lum(darkText), restored, before };
});
check(
  themeSwap.darkLum < themeSwap.beforeLum / 2,
  `切到深色后底色明显变暗（亮度 ${Math.round(themeSwap.beforeLum)} → ${Math.round(themeSwap.darkLum)}）`,
);
check(
  themeSwap.darkTextLum > 150,
  `深色下正文是浅色（文字亮度 ${Math.round(themeSwap.darkTextLum)}）`,
);
check(themeSwap.restored === themeSwap.before, '切回后底色复原（主题类没有被永久改坏）');

// ── 6. mdui 语言包（仅 dev 能验） ────────────────────────────────────────
console.log('\n6. mdui 中文语言包');
if (isDev) {
  const locale = await page.evaluate(async () => {
    // 与页面共享同一份模块实例（Vite 会去重），不会二次执行 loadLocale
    const m = await import('/src/ui/mdui.ts');
    return typeof m.getLocale === 'function' ? m.getLocale() : null;
  });
  check(locale === 'zh-cn', `getLocale() 返回 ${locale}（期望 zh-cn）`);
  const localeReady = await page.evaluate(async () => {
    const m = await import('/src/ui/mdui.ts');
    await m.mduiLocaleReady;
    return true;
  });
  check(localeReady, 'mduiLocaleReady 已 resolve（main.tsx 靠它决定何时渲染首帧）');
} else {
  console.log('   – 生产构建下拿不到模块句柄，跳过（与项目里取 Dexie 实例的既有取舍一致）');
}

await page.screenshot({ path: `e2e-shots/mdui-adapter-${isDev ? 'dev' : 'preview'}.png` });
await browser.close();

console.log(`\n=== ${failed === 0 ? '✅ 阶段 0 验收通过' : `❌ 有 ${failed} 项未通过`} ===`);
process.exit(failed === 0 ? 0 : 1);
