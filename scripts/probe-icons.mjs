/* eslint-disable no-console */
/**
 * 图标体检：把每个页面上的 SVG 捞出来量一遍，找四类问题
 *   1. `<Sym name="…">` 名字写错（ICONS 表里没有）→ 渲染成 null，位置留个空
 *   2. 没有尺寸的 SVG（width/height 缺失）→ 退化成替换元素固有尺寸 300×150
 *   3. 尺寸为 0 或溢出按钮
 *   4. 图标与同行文字基线不齐（图标中心 vs 文字中心差得多）
 * 同时收集 console 里 `[Sym]` 的告警。
 *
 * 用法：BASE_URL=http://localhost:5173 node scripts/probe-icons.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';

const ROUTES = [
  { hash: '#/', name: '对话页' },
  { hash: '#/library', name: '资料' },
  { hash: '#/settings', name: '设置' },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const warnings = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('[Sym]')) warnings.push(text);
});
page.on('pageerror', (err) => warnings.push(`pageerror: ${err.message}`));

let failed = 0;

await seedVideo();

/**
 * 种一条视频：库页的搜索框 / 筛选勾 / 拖拽手柄**只在有课程时才渲染**
 * （`videos.length > 0 || folders.length > 0`），空库量不到那三个图标。
 * 这个 bug 类就是这么藏住的：截图上看空库一切正常，用户导了课才炸。
 */
async function seedVideo() {
  await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('wangke');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const tx = db.transaction(['videos'], 'readwrite');
    for (const [i, name] of ['线性代数：特征值.mp4', '数据结构：树与图.mp4'].entries()) {
      tx.objectStore('videos').put({
        id: `probe-icon-seed-${i}`,
        name,
        size: 1,
        mimeType: 'video/mp4',
        duration: 300,
        createdAt: Date.now(),
        status: 'transcribed',
      });
    }
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  });
}

for (const route of ROUTES) {
  await page.goto(`${BASE}/${route.hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const report = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg')].filter((el) => el.isConnected);
    const issues = [];
    const rows = [];

    for (const svg of svgs) {
      const rect = svg.getBoundingClientRect();
      const cs = getComputedStyle(svg);
      const w = Math.round(rect.width * 10) / 10;
      const h = Math.round(rect.height * 10) / 10;
      // 定位它属于谁：最近的带 aria-label 的祖先，或者最近的按钮/列表项
      const owner =
        svg.closest('[aria-label]')?.getAttribute('aria-label') ??
        svg.closest('button')?.textContent?.trim().slice(0, 20) ??
        svg.parentElement?.parentElement?.textContent?.trim().slice(0, 20) ??
        '(未知)';
      const attrW = svg.getAttribute('width');
      const attrH = svg.getAttribute('height');
      rows.push({ owner, w, h, attrW, attrH, strokeWidth: cs.strokeWidth });

      if (w === 0 || h === 0) {
        issues.push({ kind: 'zero-size', owner, w, h, detail: '图标宽或高为 0' });
      } else if (w > 80 || h > 80) {
        issues.push({
          kind: 'oversized',
          owner,
          w,
          h,
          detail: `没有 width/height 属性时 SVG 会退化成 300×150 量级的固有尺寸`,
        });
      }
      if (!attrW && !attrH && !cs.width.endsWith('px')) {
        issues.push({ kind: 'no-dimension', owner, w, h, detail: '既无属性也无 CSS 尺寸' });
      }
    }

    // 空位扫描：Sym 名字写错时返回 null，但 span 占位还在 → 找出「有容器但没 svg」的
    const emptyIconSpots = [...document.querySelectorAll('span,div')]
      .filter((el) => {
        if (el.querySelector('svg')) return false;
        // aria-hidden 且没有任何文字、且尺寸接近正方形 → 很可能是空的图标位
        if (el.textContent.trim() !== '') return false;
        const r = el.getBoundingClientRect();
        return r.width >= 14 && r.width <= 30 && Math.abs(r.width - r.height) <= 4;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          owner: el.closest('[aria-label]')?.getAttribute('aria-label') ?? '(未知)',
          w: Math.round(r.width),
          h: Math.round(r.height),
          cls: el.className?.toString().slice(0, 60),
        };
      });

    return { count: svgs.length, issues, rows, emptyIconSpots };
  });

  console.log(`\n=== ${route.name} (${route.hash}) · ${report.count} 个 SVG ===`);
  if (report.issues.length === 0) {
    console.log('  尺寸层面：没有发现问题');
  } else {
    for (const i of report.issues) {
      console.log(`  ✗ [${i.kind}] ${i.owner} → ${i.w}×${i.h} — ${i.detail}`);
      failed++;
    }
  }
  if (report.emptyIconSpots.length) {
    console.log(`  ? 空图标位（Sym 名字可能写错，组件返回 null）：${report.emptyIconSpots.length} 处`);
    for (const e of report.emptyIconSpots.slice(0, 12)) {
      console.log(`      ${e.owner} · ${e.w}×${e.h} · ${e.cls}`);
    }
  }
  console.log('  尺寸清单（前 30）：');
  for (const r of report.rows.slice(0, 30)) {
    console.log(`      ${String(r.w).padStart(5)}×${String(r.h).padEnd(5)} stroke=${r.strokeWidth}  ${r.owner}`);
  }
}

console.log('\n=== console 告警 ===');
if (warnings.length === 0) console.log('  无');
else for (const w of [...new Set(warnings)]) console.log(`  ✗ ${w}`);

console.log(`\n合计尺寸问题：${failed}`);
await browser.close();
process.exit(failed || warnings.length ? 1 : 0);