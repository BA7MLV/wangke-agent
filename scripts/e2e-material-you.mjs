/* eslint-disable no-console */
// Material You 保真度的回归套件：字体 / 深浅主题 / Material Symbols 图标 / 动态取色。
//
// 为什么必须有这么一条：这四样**全部是静默失败**的形态 ——
//   · 图标元素漏注册 → 渲染成空标签，不报错、不进控制台、tsc 也过（Web Components 的典型故障）；
//   · 主题类的色板没生效 → 页面照旧是浅色，功能测试全绿也发现不了；
//   · 字体没加载 → 悄悄回退成系统字体，肉眼在宽屏上都不一定看出来；
//   · 动态取色失败被刻意吞掉（取色失败绝不能影响播放）→ 没有断言就永远不知道它没生效。
// 实测踩过第 4 条的变形：hook 用 RefObject 读一次 `.current`，而目标元素比数据晚挂上，
// 于是全程无报错、配色就是不生效（见 src/ui/theme.ts 的注释）。
//
// **只能跑 dev(5173)**：动态取色那段要往 IndexedDB 里种一帧封面，需要拿到应用同一份 Dexie 实例
// （dev 下 `import('/src/store/db.ts')` 可以，生产构建里该模块已打包、拿不到句柄）。
//
// 用法：node scripts/e2e-material-you.mjs   （需先 npm run dev）
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-test.mp4';

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

// 相对亮度：用于「深色下确实变暗、文字确实是浅色」这类断言，避免依赖具体色值
const LUM = `(c) => { const [r,g,b] = (c.match(/[\\d.]+/g) || [0,0,0]).map(Number); return 0.2126*r + 0.7152*g + 0.0722*b; }`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 250));
});

console.log('=== Material You 保真度（字体 / 主题 / 图标 / 动态取色）===');

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// ── 1. 字体：Roboto 已加载（拉丁/数字），中文回退系统字体 ────────────────────
const font = await page.evaluate(() => ({
  stack: getComputedStyle(document.body).fontFamily,
  loaded: [...document.fonts].filter((f) => /Roboto/i.test(f.family)).map((f) => `${f.family}/${f.weight}/${f.status}`),
}));
check(/Roboto/.test(font.stack), '正文字体栈以 Roboto 开头');
check(
  font.loaded.length > 0 && font.loaded.every((f) => f.includes('loaded')),
  `Roboto 已加载（${font.loaded.join(', ') || '无'}）`,
);

// ── 2. 主题：三个档位都要真的换色板 ─────────────────────────────────────────
const themeCase = async (theme) => {
  await page.evaluate((t) => {
    const raw = JSON.parse(localStorage.getItem('wangke-settings') ?? '{"state":{},"version":1}');
    raw.state = { ...raw.state, theme: t };
    localStorage.setItem('wangke-settings', JSON.stringify(raw));
  }, theme);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  return page.evaluate(
    (lumSrc) => {
      const lum = eval(`(${lumSrc})`);
      const cs = getComputedStyle(document.getElementById('root'));
      return {
        cls: [...document.documentElement.classList].find((c) => c.startsWith('mdui-theme-')),
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        bgLum: lum(cs.backgroundColor),
        textLum: lum(cs.color),
      };
    },
    LUM,
  );
};
const light = await themeCase('light');
check(light.cls === 'mdui-theme-light' && light.bgLum > 200, `浅色主题：底色亮度 ${Math.round(light.bgLum)}`);
check(light.textLum < 80, `浅色主题：正文是深色（亮度 ${Math.round(light.textLum)}）`);

const dark = await themeCase('dark');
check(dark.cls === 'mdui-theme-dark' && dark.bgLum < 60, `深色主题：底色亮度 ${Math.round(dark.bgLum)}`);
check(dark.textLum > 150, `深色主题：正文是浅色（亮度 ${Math.round(dark.textLum)}）`);
check(dark.colorScheme === 'dark', '深色下 color-scheme 同步为 dark（原生滚动条/控件跟随）');
await page.screenshot({ path: 'e2e-shots/mdyou-dark-library.png' });

await themeCase('auto');

// ── 3. Material Symbols：图标元素必须已注册且真的渲染出 SVG ─────────────────
await page.setInputFiles('[data-testid="import-input"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 40000 });
await page.waitForTimeout(600);

const icons = await page.evaluate(() => {
  const els = [...document.querySelectorAll('*')].filter((e) => e.tagName.toLowerCase().startsWith('mdui-sym-'));
  const visible = els.filter((e) => e.getBoundingClientRect().width > 2);
  return {
    total: els.length,
    tags: [...new Set(els.map((e) => e.tagName.toLowerCase()))].length,
    undefinedTags: [...new Set(els.map((e) => e.tagName.toLowerCase()))].filter((t) => !customElements.get(t)),
    noSvg: visible.filter((e) => !e.shadowRoot?.querySelector('svg path')).length,
    viewBoxes: [...new Set(els.map((e) => e.shadowRoot?.querySelector('svg')?.getAttribute('viewBox')).filter(Boolean))],
    sizes: [...new Set(visible.map((e) => Math.round(e.getBoundingClientRect().width)))],
    // 颜色必须跟随文字色（fill: currentColor）
    colorFollows: visible.every((e) => {
      const svgFill = getComputedStyle(e.shadowRoot.querySelector('svg')).fill;
      return svgFill && svgFill !== 'none';
    }),
  };
});
check(icons.total > 0 && icons.undefinedTags.length === 0, `Material Symbols 全部已注册（用到 ${icons.tags} 种 / ${icons.total} 个）`);
check(icons.noSvg === 0, '每个可见图标都渲染出了 SVG 路径（没有空标签）');
check(icons.viewBoxes.length === 1, `图标 viewBox 统一（${icons.viewBoxes.join(' / ')}）`);
check(icons.colorFollows, '图标颜色走 currentColor（跟随文字色）');

// 底部导航的双态：未选中描边、选中实心（路径必须不同）
const navCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const navPage = await navCtx.newPage();
await navPage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await navPage.waitForTimeout(1200);
const navPairs = await navPage.evaluate(() =>
  [...document.querySelectorAll('mdui-navigation-bar-item')].map((item) => {
    const pick = (slot) => {
      const el = item.querySelector(`[slot="${slot}"] mdui-sym-home, [slot="${slot}"] mdui-sym-settings`);
      return el?.shadowRoot?.querySelector('path')?.getAttribute('d') ?? null;
    };
    return { label: item.innerText.trim(), active: item.hasAttribute('active'), icon: pick('icon'), activeIcon: pick('active-icon') };
  }),
);
check(navPairs.length === 2, '底部导航有 2 项');
check(
  navPairs.every((i) => i.icon && i.activeIcon),
  '每项都同时挂了描边与实心两套图标',
);
check(
  navPairs.some((i) => i.active && i.icon !== i.activeIcon),
  `选中项用的是实心变体（路径与描边不同）`,
);
await navPage.screenshot({ path: 'e2e-shots/mdyou-mobile-nav.png' });
await navCtx.close();

// ── 4. 动态取色：种一帧当封面 → 播放页应换成提取出的主色，且只作用在播放页 ────
const seeded = await page.evaluate(async () => {
  const { db } = await import('/src/store/db.ts');
  const v = await db.videos.orderBy('createdAt').reverse().first();
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 96;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0f7b6c';
  ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = '#ffd166';
  ctx.fillRect(0, 0, 96, 24);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await db.frames.add({ videoId: v.id, ts: 0, blob, kind: 'slide' });
  return { videoId: v.id };
});

await page.goto(`${BASE}/#/player/${seeded.videoId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-media-player]', { timeout: 25000 });
await page.waitForTimeout(2500);

const dyn = await page.evaluate(() => {
  const pageEl = document.querySelector('.page');
  const root = document.documentElement;
  // 注意：getPropertyValue 拿到的三元组带空格（"0, 107, 93"），断言时要去掉
  const read = (el, n) => getComputedStyle(el).getPropertyValue(n).replace(/\s/g, '');
  return {
    rootPrimary: read(root, '--mdui-color-primary'),
    pagePrimary: read(pageEl, '--mdui-color-primary'),
    pageContainer: read(pageEl, '--mdui-color-primary-container'),
  };
});
check(/^\d+,\d+,\d+$/.test(dyn.pagePrimary), `播放页拿到了自己的主色（${dyn.pagePrimary}）`);
check(dyn.pagePrimary !== dyn.rootPrimary, `动态取色只作用在播放页，根元素仍是默认主色（${dyn.rootPrimary}）`);
// #0f7b6c 是青绿，提取出的主色应当「绿 > 红」，借此确认用的确实是封面色而不是默认紫
const [pr, pg, pb] = dyn.pagePrimary.split(',').map(Number);
check(pg > pr && pg > pb, `主色确实来自那张青绿封面（R${pr} G${pg} B${pb}）`);
await page.screenshot({ path: 'e2e-shots/mdyou-dynamic-player.png' });

// 关掉开关 → 回到默认配色（也验证「开关真的接上了」）
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('wangke-settings') ?? '{"state":{},"version":1}');
  raw.state = { ...raw.state, dynamicColor: false };
  localStorage.setItem('wangke-settings', JSON.stringify(raw));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-media-player]', { timeout: 25000 });
await page.waitForTimeout(2000);
const off = await page.evaluate(() => {
  const pageEl = document.querySelector('.page');
  const root = document.documentElement;
  const read = (el, n) => getComputedStyle(el).getPropertyValue(n).trim();
  return { same: read(pageEl, '--mdui-color-primary') === read(root, '--mdui-color-primary') };
});
check(off.same, '关掉「动态取色」后播放页回到默认配色');

console.log(errors.length ? `[console/page errors]\n${errors.join('\n')}` : '无 console/page 错误');
await browser.close();
console.log(failed === 0 ? '\n✅ Material You 保真度全部通过' : `\n❌ 有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
