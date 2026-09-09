#!/usr/bin/env node
/**
 * 讲义 DOCX 渲染 fixture 测试：固定 IR 假数据 → buildHandoutDocx → 解包断言 XML。
 * 不依赖 API；同时输出 scripts/out/handout-fixture.docx 供人工检查。
 * 运行：node scripts/render-handout-fixture.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { buildHandoutDocx } from '../src/handout/docx.ts';

// 1x1 PNG
const PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

const fixture = {
  title: 'Hook 执行时机学习讲义',
  courseName: 'React 进阶第十三讲',
  date: '2026年9月7日',
  summary: '本课程讲授 useEffect 与 useLayoutEffect 的执行时机差异及选择依据。',
  sections: [
    {
      heading: '执行时机',
      blocks: [
        { type: 'lead', text: '本节说明两个 Hook 的执行时机。' },
        { type: 'para', text: 'useEffect 在浏览器绘制完成后异步执行。' },
        { type: 'h2', text: '异步执行' },
        { type: 'list', ordered: true, items: ['订阅数据源', '清理副作用'] },
        { type: 'figure', ts: 125, caption: '执行时机示意' },
        { type: 'note', text: '注意不要在渲染期间调用。' },
      ],
    },
    {
      heading: '对比与选择',
      blocks: [
        { type: 'h2', text: '特性对比' },
        { type: 'list', ordered: false, items: ['是否需要阻塞绘制'] },
        {
          type: 'table',
          caption: '两个 Hook 的特性对比',
          header: ['特性', 'useEffect', 'useLayoutEffect'],
          rows: [
            ['执行时机', '绘制后异步', '绘制前同步'],
            ['适用场景', '数据获取', '读取布局'],
          ],
        },
        { type: 'para', text: '选择依据是是否需要在绘制前完成 DOM 操作。' },
        { type: 'figure', ts: 305 },
      ],
    },
    {
      heading: 'A&B <对比> 章节',
      blocks: [{ type: 'para', text: '特殊字符章节正文。' }],
    },
  ],
  images: new Map([
    [125, { data: PNG, width: 800, height: 450, caption: '执行时机示意' }],
    [305, { data: PNG, width: 800, height: 450, caption: '对比画面' }],
  ]),
};

// ---------- 构建 ----------

let files;
try {
  const blob = await buildHandoutDocx(fixture);
  const buf = new Uint8Array(await blob.arrayBuffer());
  mkdirSync('scripts/out', { recursive: true });
  writeFileSync('scripts/out/handout-fixture.docx', buf);
  files = unzipSync(buf);
} catch (e) {
  console.log(`  FAIL - 构建失败（功能未实现）\n    ${e.message}`);
  console.log(`\n0 passed, 1 failed`);
  process.exit(1);
}

const dec = new TextDecoder();
const xml = (name) => dec.decode(files[name] ?? new Uint8Array());
const docXml = xml('word/document.xml');
const settingsXml = xml('word/settings.xml');
const headerXmls = Object.keys(files).filter((k) => /^word\/header\d+\.xml$/.test(k)).map(xml);
const footerXmls = Object.keys(files).filter((k) => /^word\/footer\d+\.xml$/.test(k)).map(xml);
const allFooters = footerXmls.join('\n');
const allHeaders = headerXmls.join('\n');

// ---------- 页面与全局设置 ----------

test('A4 + GB/T 9704 页边距', () => {
  assert.match(docXml, /w:w="11906"[^/]*w:h="16838"/);
  assert.match(docXml, /w:top="2098"/);
  assert.match(docXml, /w:bottom="1984"/);
  assert.match(docXml, /w:left="1587"/);
  assert.match(docXml, /w:right="1474"/);
});

test('settings 开启单双页码与域自动更新', () => {
  assert.match(settingsXml, /evenAndOddHeaders/);
  assert.match(settingsXml, /updateFields/);
});

test('正文段首行缩进用字符单位 firstLineChars=200（补丁生效）', () => {
  assert.match(docXml, /w:firstLineChars="200"/);
  assert.doesNotMatch(docXml, /w:firstLine="640"/);
});

test('固定行距 28 磅 + 孤行控制', () => {
  assert.match(docXml, /w:line="560" w:lineRule="exact"/);
  assert.match(docXml, /widowControl/);
});

// ---------- 封面 ----------

test('封面：标题二号小标宋、课程名、成文日期', () => {
  assert.match(docXml, /方正小标宋简体/);
  assert.match(docXml, /w:val="44"/); // 二号
  assert.match(docXml, /Hook 执行时机学习讲义/);
  assert.match(docXml, /React 进阶第十三讲/);
  assert.match(docXml, /2026年9月7日/);
});

// ---------- 目录 ----------

test('目录页：「目　录」标题 + TOC 域（收一级标题）', () => {
  assert.match(docXml, /目　录/);
  assert.match(docXml, /w:val="36"/); // 小二
  assert.match(docXml, /\\o &quot;1-1&quot;|\\o "1-1"/);
});

test('TOC 域带占位内容：separate 与 end 之间有章节清单（非 Word 查看器可见）', () => {
  const sdt = docXml.match(/<w:sdtContent>[\s\S]*?<\/w:sdtContent>/)?.[0] ?? '';
  assert.ok(sdt, '应存在 TOC sdt');
  const separateIdx = sdt.indexOf('fldCharType="separate"');
  const endIdx = sdt.indexOf('fldCharType="end"');
  assert.ok(separateIdx > 0 && endIdx > separateIdx, 'separate/end 结构完整');
  const placeholder = sdt.slice(separateIdx, endIdx);
  assert.match(placeholder, /一、执行时机/);
  assert.match(placeholder, /二、对比与选择/);
  assert.match(placeholder, /页码将在/); // 占位内的提示行，Word 更新域后被替换掉
});

test('占位条目文本经过 XML 转义（fixture 第三章节标题含 & < >）', () => {
  const sdt = docXml.match(/<w:sdtContent>[\s\S]*?<\/w:sdtContent>/)?.[0] ?? '';
  assert.match(sdt, /三、A&amp;B &lt;对比&gt;/);
  assert.ok(!/三、A&B/.test(sdt), '未转义的 & 会破坏 XML');
});

test('章节标题带 Heading1 样式（供 TOC 收集）', () => {
  assert.match(docXml, /Heading1/);
});

// ---------- 页眉页脚 ----------

test('页眉：讲义标题五号宋体居中 + 下细线', () => {
  assert.ok(headerXmls.length >= 1, '应至少有一个页眉');
  assert.match(allHeaders, /Hook 执行时机学习讲义/);
  assert.match(allHeaders, /w:val="21"/); // 五号
  assert.match(allHeaders, /宋体/);
  assert.match(allHeaders, /w:pBdr/);
});

test('页码：奇页居右、偶页居左，四号宋体 + 一字线', () => {
  assert.ok(footerXmls.length >= 2, '应有奇偶两套页脚');
  assert.match(allFooters, /PAGE/);
  assert.match(allFooters, /w:jc w:val="right"/);
  assert.match(allFooters, /w:jc w:val="left"/);
  assert.match(allFooters, /—/);
  assert.match(allFooters, /w:val="28"/); // 四号
});

test('正文页码从 1 起编（封面/目录不编页码）', () => {
  assert.match(docXml, /w:pgNumType[^>]*w:start="1"/);
});

// ---------- 正文排版 ----------

test('公文三字体齐备：黑体（一级）/楷体（二级）/仿宋（正文）', () => {
  assert.match(docXml, /黑体/);
  assert.match(docXml, /楷体_GB2312/);
  assert.match(docXml, /仿宋_GB2312/);
  assert.match(docXml, /Times New Roman/);
});

test('一级标题自动编号「一、」「二、」', () => {
  assert.match(docXml, /一、执行时机/);
  assert.match(docXml, /二、对比与选择/);
});

test('二级标题自动编号「（一）」「（二）」且各节独立计数', () => {
  assert.match(docXml, /（一）异步执行/);
  assert.match(docXml, /（一）特性对比/); // 第二节重新从（一）开始
});

test('有序列表自动编号「1. 」、无序列表用「●」', () => {
  assert.match(docXml, /1\. /);
  assert.match(docXml, /● /);
});

test('概述段出现在正文开头', () => {
  assert.match(docXml, /本课程讲授 useEffect/);
});

// ---------- 图与表 ----------

test('插图嵌入且图注带章节号', () => {
  assert.match(docXml, /<w:drawing>/);
  assert.match(docXml, /图 1-1 执行时机示意/);
  assert.match(docXml, /图 2-1 对比画面/); // 无 caption 时回退 VL caption
});

test('三线表：顶/底线 1.5 磅、栏目线 0.5 磅、无竖线', () => {
  assert.match(docXml, /w:sz="12"/); // 1.5pt
  assert.match(docXml, /w:sz="4"/); // 0.5pt
  const tbl = docXml.match(/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/)?.[0] ?? '';
  assert.match(tbl, /w:val="none"|w:val="nil"/);
});

test('表题带章节号：「表 2-1 …」小四黑体居中', () => {
  assert.match(docXml, /表 2-1 两个 Hook 的特性对比/);
  assert.match(docXml, /w:val="24"/); // 小四
});

// ---------- 汇总 ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
console.log('样本已输出：scripts/out/handout-fixture.docx');
