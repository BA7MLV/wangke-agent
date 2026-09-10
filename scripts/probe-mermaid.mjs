/* eslint-disable no-console */
// 一次性探针：验证 XMarkdown + MermaidBlock 的渲染链路（正常 / 失败 / 未闭合 / 非 mermaid 代码块）
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5174';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });

await page.goto(`${BASE}/probe-mermaid.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

const report = await page.evaluate(() => {
  const out = {};
  for (const box of document.querySelectorAll('.box')) {
    const label = box.getAttribute('data-probe');
    const block = box.querySelector('[data-testid="mermaid-block"]');
    const svg = box.querySelector('[data-testid="mermaid-canvas"] svg');
    out[label] = {
      phase: block?.getAttribute('data-phase') ?? null,
      hasSvg: !!svg,
      svgText: svg ? (svg.textContent || '').replace(/\s+/g, ' ').slice(0, 160) : null,
      // foreignObject 里有 HTML 标签说明中文换行走的是 htmlLabels 分支
      hasForeignObject: !!box.querySelector('foreignObject'),
      preWrapped: !!box.querySelector('pre > [data-testid="mermaid-block"]'),
      err: box.querySelector('[data-testid="mermaid-error"]')?.textContent?.slice(0, 120) ?? null,
      pending: !!box.querySelector('[data-testid="mermaid-pending"]'),
      sourceShown: !!box.querySelector('[data-testid="mermaid-source"]'),
    };
  }
  return out;
});
console.log(JSON.stringify(report, null, 2));
await page.screenshot({ path: 'e2e-shots/probe-mermaid.png', fullPage: true });
await browser.close();
