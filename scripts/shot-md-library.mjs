/* eslint-disable no-console */
// 在真实库页里导入多个 .md，截封面卡片所在区域，人眼确认排版与配色在列表里的观感。
// 用法：BASE_URL=http://localhost:5174 node scripts/shot-md-library.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const OUT = path.resolve('e2e-shots/md-covers');
const TMP = path.resolve('e2e-shots/md-covers/notes');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const NOTES = [
  ['线性代数第三章.md', '# 线性代数第三章：特征值与特征向量\n\n设 $A$ 是一个 $n \\times n$ 的方阵。如果存在一个非零向量 $v$，使得 $Av=\\lambda v$，那么 $\\lambda$ 就是 $A$ 的一个特征值。\n'],
  ['Spring Boot 实战.md', '# Spring Boot 实战：自动装配的原理\n\n`@SpringBootApplication` 其实是三个注解的组合，真正干活的是 `@EnableAutoConfiguration`，它读的是 `META-INF/spring.factories`。\n'],
  ['考试周复习.md', '没有标题的笔记也能出封面，标题会回落文件名，下面这段正文就是预览文字，用来检查版面。\n'],
  ['operating-systems.md', '# Operating Systems: Three Easy Pieces\n\nVirtualization is the foundation: the OS abstracts physical hardware into a clean interface, and applications are written against that interface instead of the machine.\n'],
  ['速查表.md', '# 速查表\n\n- 封面队列**串行**，并发 1\n- 失败不写 `coverState`\n- 哈希派色相，白字固定低明度\n'],
];

for (const [name, body] of NOTES) fs.writeFileSync(path.join(TMP, name), body);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('页面异常：', e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="import-input"]', { timeout: 20000 });

await page.setInputFiles('input[type="file"]', NOTES.map(([n]) => path.join(TMP, n)));
for (const [name] of NOTES) {
  const stem = name.replace(/\.md$/, '');
  await page.waitForSelector(`[data-testid="video-item"]:has-text("${stem}")`, { timeout: 30000 });
}
// 等封面队列把五张都画完
await page.waitForFunction(
  () => {
    const rows = [...document.querySelectorAll('[data-testid="video-item"]')];
    return rows.length >= 5 && rows.every((r) => r.querySelector('[data-testid="video-thumb"] img')?.naturalWidth > 0);
  },
  { timeout: 30000 },
);
await page.waitForTimeout(600);
await page.locator('[data-testid="import-input"]').locator('xpath=ancestor::*[contains(@class,"library")][1]').screenshot({ path: path.join(OUT, 'library.png') }).catch(async () => {
  await page.screenshot({ path: path.join(OUT, 'library.png') });
});
console.log(`-> ${path.join(OUT, 'library.png')}`);
await browser.close();