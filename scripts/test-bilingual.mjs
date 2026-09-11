// 双语字幕合成单测（纯函数，Node 直跑）。
// 用法：node scripts/test-bilingual.mjs

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-bilingual-${Date.now()}.mjs`);
execSync(
  `node_modules/.bin/esbuild src/utils/bilingual.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);
const { mergeBilingual, splitCueLines } = await import(tmp);

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

console.log('mergeBilingual');
{
  // 1:1（B 站自动翻译通常与原文同时间轴）
  const zh = [
    { start: 0, end: 2, text: '大家好' },
    { start: 2, end: 4, text: '今天讲线性代数' },
  ];
  const en = [
    { start: 0, end: 2, text: 'Hello everyone' },
    { start: 2, end: 4, text: 'Today we cover linear algebra' },
  ];
  eq(mergeBilingual(zh, en), [
    { start: 0, end: 2, text: '大家好\nHello everyone' },
    { start: 2, end: 4, text: '今天讲线性代数\nToday we cover linear algebra' },
  ], '1:1 合成两行');
}
{
  // 一条主 cue 对上多条对照 cue → 合并成一行
  const zh = [{ start: 0, end: 6, text: '一句话被切成三段' }];
  const en = [
    { start: 0, end: 2, text: 'one sentence' },
    { start: 2, end: 4, text: 'split into' },
    { start: 4, end: 6, text: 'three parts' },
  ];
  eq(mergeBilingual(zh, en), [
    { start: 0, end: 6, text: '一句话被切成三段\none sentence split into three parts' },
  ], '一对多合并为一行');
}
{
  // 对不上（时间不重叠）→ 保留原文，不硬塞错位翻译
  const zh = [
    { start: 0, end: 2, text: '有翻译' },
    { start: 2, end: 4, text: '没翻译' },
  ];
  const en = [{ start: 0, end: 2, text: 'translated' }];
  eq(mergeBilingual(zh, en), [
    { start: 0, end: 2, text: '有翻译\ntranslated' },
    { start: 2, end: 4, text: '没翻译' },
  ], '无重叠不合成');
}
{
  // 半重叠（首尾相接/交叠）也算配上
  const zh = [{ start: 1, end: 3, text: '甲' }];
  const en = [{ start: 2, end: 5, text: 'B' }];
  eq(mergeBilingual(zh, en)[0].text, '甲\nB', '半重叠视为配对');
  eq(mergeBilingual(zh, [{ start: 3, end: 5, text: 'B' }])[0].text, '甲', '相接（end==start）不算重叠');
}
{
  eq(mergeBilingual([{ start: 0, end: 1, text: '甲' }], []), [{ start: 0, end: 1, text: '甲' }], '无对照轨原样返回');
  eq(mergeBilingual([], [{ start: 0, end: 1, text: 'A' }]), [], '主字幕为空 → 空');
  // 空白对照文本不进第二行
  eq(mergeBilingual([{ start: 0, end: 2, text: '甲' }], [{ start: 0, end: 2, text: '   ' }])[0].text, '甲', '空白对照文本忽略');
}
{
  // 游标不回退：前一条配到很靠后的对照 cue，后面仍能正确配对
  const zh = [
    { start: 0, end: 10, text: '长' },
    { start: 10, end: 12, text: '短' },
  ];
  const en = [
    { start: 1, end: 9, text: 'long' },
    { start: 10, end: 12, text: 'short' },
  ];
  eq(mergeBilingual(zh, en).map((c) => c.text), ['长\nlong', '短\nshort'], '错位区间下仍逐条配对');
}

console.log('splitCueLines');
eq(splitCueLines('中文\nEnglish'), ['中文', 'English'], '两行');
eq(splitCueLines('中文'), ['中文'], '单行');
eq(splitCueLines('中文\n\nEnglish '), ['中文', 'English'], '空行与首尾空白去掉');

fs.rmSync(tmp, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
