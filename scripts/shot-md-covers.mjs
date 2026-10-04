/* eslint-disable no-console */
// 一次性可视化检查：把 md 封面标题卡在真实浏览器里画出来存盘，人眼过一遍排版。
// 用法：BASE_URL=http://localhost:5174 node scripts/shot-md-covers.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const OUT = path.resolve('e2e-shots/md-covers');
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  ['01-典型', '# 线性代数第三章：特征值与特征向量\n\n设 $A$ 是一个 $n \\times n$ 的方阵。如果存在一个非零向量 $v$，使得 $Av = \\lambda v$ 成立，那么我们称 $\\lambda$ 是矩阵 $A$ 的一个**特征值**。\n'],
  ['02-无标题回落文件名', '这是一段没有任何标题的笔记开头，用来检查标题槽空着的时候版面会不会歪。后面还有第二段。\n\n第二段正文。\n'],
  ['03-超长英文标题断词', '# Distributed Systems: Consensus Algorithms and Failure Detection in Practice\n\nShort body.\n'],
  ['04-超长中文标题', '# 概率论与数理统计第七章：极限定理、依概率收敛与中心极限定理的证明与应用\n\n正文。\n'],
  ['05-只有标题无正文', '# 只有标题没有正文\n'],
  ['06-空文档', ''],
  ['07-英文正文', '# Release Notes v2\n\nWe refactored the cover pipeline to decouple it from the handout job, so importing a video no longer waits on frame extraction.\n'],
  ['08-列表与代码开头', '# 速查表\n\n- `pickCoverFrame` 只采开头 120 秒\n- **亮度带**是硬门槛\n- 清晰度只在候选间归一化\n'],
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
page.on('pageerror', (e) => console.error('页面异常：', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });

const shots = await page.evaluate(async (cases) => {
  const { paintTextCover, hueOfTitle } = await import('/src/media/textCover.ts');
  const { mdCoverText } = await import('/src/materials/md.ts');
  await document.fonts.ready;
  const wrap = document.createElement('div');
  wrap.id = 'shotwrap';
  wrap.style.cssText =
    'position:absolute;top:0;left:0;right:0;z-index:99999;background:#1b1b1f;padding:20px;display:grid;grid-template-columns:repeat(2,1fr);gap:16px';
  document.body.appendChild(wrap);
  const out = [];
  for (const [label, src] of cases) {
    const { title, preview } = mdCoverText(src);
    const heading = title ?? 'fallback-name.md';
    const { blob, width, height } = await paintTextCover({ title: heading, preview });
    const fig = document.createElement('figure');
    fig.style.margin = '0';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.style.cssText = 'width:100%;display:block;border-radius:8px';
    const cap = document.createElement('figcaption');
    cap.style.cssText = 'color:#ccc;font:12px monospace;padding:4px 0';
    cap.textContent = `${label} · ${width}x${height} · ${(blob.size / 1024).toFixed(1)}KB · ${blob.type} · hue=${hueOfTitle(heading).toFixed(1)}`;
    fig.append(img, cap);
    wrap.appendChild(fig);
    out.push({ label, size: blob.size, type: blob.type, title: String(title), preview: preview.slice(0, 50) });
  }
  return out;
}, CASES);

await page.waitForTimeout(500);
await page.locator('#shotwrap').screenshot({ path: path.join(OUT, 'grid.png') });
console.table(shots);
console.log(`-> ${path.join(OUT, 'grid.png')}`);
await browser.close();