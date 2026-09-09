// parse.ts 单元测试（Node 直跑，无需起服务）
// 用法：node scripts/test-bilibili-parse.mjs
// 注意：tsx 源码用 esbuild 转译后跑，避免依赖完整构建。

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-bilibili-parse-${Date.now()}.mjs`);

// 用 esbuild 把 TS 转成可直跑的 ESM
execSync(
  `node_modules/.bin/esbuild src/bilibili/parse.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);

const { extractBv, extractPage, parseBiliInput, parseBvFromResolved } = await import(tmp);

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
function throws(fn, msgPart, label) {
  try {
    fn();
    failed++;
    console.error(`  FAIL ${label}（应抛错但未抛）`);
  } catch (e) {
    if (String(e.message).includes(msgPart)) {
      passed++;
      console.log(`  ok  ${label}`);
    } else {
      failed++;
      console.error(`  FAIL ${label}\n    错误信息应包含 "${msgPart}"，实际: "${e.message}"`);
    }
  }
}

console.log('extractBv');
eq(extractBv('BV1xx411c7mD'), 'BV1xx411c7mD', '裸 BV');
eq(extractBv('https://www.bilibili.com/video/BV1xx411c7mD'), 'BV1xx411c7mD', '标准链接');
eq(extractBv('看这里 BV1Ab411c7mD 很好'), 'BV1Ab411c7mD', '夹杂文本');
eq(extractBv('av170001'), null, 'av 号不含 BV');
eq(extractBv(''), null, '空串');

console.log('extractPage');
eq(extractPage('https://www.bilibili.com/video/BV1xx411c7mD?p=2'), 2, '?p=2');
eq(extractPage('.../video/BV1xx411c7mD/?spm=xx&p=3&t=1'), 3, '&p=3');
eq(extractPage('BV1xx411c7mD'), 1, '无 p 回退 1');
eq(extractPage('...?p=0'), 1, 'p=0 非法回退 1');
eq(extractPage('...?p=abc'), 1, 'p=abc 非法回退 1');

console.log('parseBiliInput');
eq(parseBiliInput('BV1xx411c7mD'), { bvid: 'BV1xx411c7mD', page: 1, isShort: false }, '裸 BV');
eq(
  parseBiliInput('https://www.bilibili.com/video/BV1xx411c7mD?p=2'),
  { bvid: 'BV1xx411c7mD', page: 2, isShort: false },
  '标准链接带 p',
);
eq(parseBiliInput('bilibili.com/video/BV1xx411c7mD'), { bvid: 'BV1xx411c7mD', page: 1, isShort: false }, '无协议');
{
  const r = parseBiliInput('https://b23.tv/abc123');
  eq(r.isShort, true, 'b23 标记为短链');
  eq(r.shortUrl, 'https://b23.tv/abc123', '短链保留');
}
{
  const r = parseBiliInput('b23.tv/abc123');
  eq(r.shortUrl, 'https://b23.tv/abc123', '短链补协议');
}
throws(() => parseBiliInput(''), '请输入', '空输入抛错');
throws(() => parseBiliInput('https://example.com/foo'), '未识别到 BV', '无 BV 抛错');

console.log('parseBvFromResolved');
eq(parseBvFromResolved('<html><a href="/video/BV1xx411c7mD/">x</a>'), 'BV1xx411c7mD', '从页面提 BV');
throws(() => parseBvFromResolved('<html>nothing</html>'), '未找到 BV', '页面无 BV 抛错');

fs.rmSync(tmp, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
