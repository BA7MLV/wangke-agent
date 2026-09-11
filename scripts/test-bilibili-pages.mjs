// 多分 P 策略的纯逻辑单测（默认勾选 / 命名 / 合计），Node 直跑。
// 用法：node scripts/test-bilibili-pages.mjs

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-bili-pages-${Date.now()}.mjs`);
execSync(
  `node_modules/.bin/esbuild src/bilibili/pages.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);
const { defaultPagesFor, pageVideoTitle, pageLabel, selectedDuration, resolveSelectedPages, formatTotalDuration } =
  await import(tmp);

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

const page = (n, part = '', duration = 600) => ({ page: n, cid: 1000 + n, part, duration });
const single = [page(1, '正片', 3600)];
const three = [page(1, '绪论'), page(2, '第二章'), page(3, '第三章')];
const course = Array.from({ length: 94 }, (_, i) => page(i + 1, `第 ${i + 1} 讲`, 2000));
const big = Array.from({ length: 20 }, (_, i) => page(i + 1, `P${i + 1}`, 1800));

console.log('defaultPagesFor');
eq(defaultPagesFor(single, null), [1], '单 P → 勾它');
eq(defaultPagesFor(three, null), [1, 2, 3], '≤3 P → 全勾');
eq(defaultPagesFor(course, null), [1], '94 P → 只勾第一 P（防手滑）');
eq(defaultPagesFor(course, 7), [7], 'URL 带 ?p=7 → 只勾 P7');
eq(defaultPagesFor(course, 999), [1], '?p=999 不存在 → 退回第一 P');
eq(defaultPagesFor([], 3), [], '空列表不炸');
eq(defaultPagesFor(three, 2), [2], 'URL 指定优先于「全勾」');

console.log('pageVideoTitle');
eq(pageVideoTitle('线性代数', single, 1), '线性代数', '单 P 不带后缀');
eq(pageVideoTitle('线性代数', three, 2), '线性代数 P2 第二章', '多 P 带序号 + 分 P 名');
eq(pageVideoTitle('线性代数', course, 3), '线性代数 P3 第 3 讲', '多 P 命名');
eq(pageVideoTitle('线性代数', [page(1, ''), page(2, '')], 2), '线性代数 P2', '分 P 名为空时只带序号');

console.log('pageLabel');
eq(pageLabel(page(2, '1.1 二三阶行列式')), 'P2 1.1 二三阶行列式', '带名');
eq(pageLabel(page(4, '  ')), 'P4', '空名');

console.log('selectedDuration / resolveSelectedPages');
eq(selectedDuration(course, [1, 3]), 4000, '两集合计');
eq(selectedDuration(course, []), 0, '没选 → 0');
eq(selectedDuration(three, [1, 2, 3, 99]), 1800, '忽略不存在的序号');
eq(resolveSelectedPages(three, [3, 1]).map((p) => p.page), [1, 3], '按序号升序取回');
eq(resolveSelectedPages(big, [5, 2]).map((p) => p.page), [2, 5], '顺序与勾选顺序无关');

console.log('formatTotalDuration');
eq(formatTotalDuration(201), '3 分 21 秒', '分钟级');
eq(formatTotalDuration(45), '45 秒', '秒级');
eq(formatTotalDuration(3600), '1.0 小时', '整小时');
eq(formatTotalDuration(57.89 * 3600), '57.9 小时', '整门课');

fs.rmSync(tmp, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
