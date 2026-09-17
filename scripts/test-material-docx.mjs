#!/usr/bin/env node
/**
 * Word（.docx）文本抽取的单元测试（无需 API key / 无需起服务）。
 * 运行：node scripts/test-material-docx.mjs
 *
 * 覆盖两层：① 纯 XML → 单元（主要逻辑）② 真 zip → 单元（走 fflate 解包与错误分支）。
 */
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import {
  decodeXmlEntities,
  extractDocxUnitsFromXml,
  readDocxUnits,
  isDocxFile,
  looksLikeLegacyDoc,
  DOCX_MIME,
} from '../src/materials/docx.ts';

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
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

// ---------- 实体解码 ----------

test('命名实体与数字实体都能还原', () => {
  assert.equal(decodeXmlEntities('A &amp; B'), 'A & B');
  assert.equal(decodeXmlEntities('&lt;div&gt;'), '<div>');
  assert.equal(decodeXmlEntities('&quot;x&quot;'), '"x"');
  assert.equal(decodeXmlEntities('&#x4e2d;'), '中');
  assert.equal(decodeXmlEntities('&#20013;'), '中');
  assert.equal(decodeXmlEntities('&nbsp;'), '\u00a0');
});

test('不认识的实体原样保留（不要吞掉正文）', () => {
  assert.equal(decodeXmlEntities('a &foo; b'), 'a &foo; b');
  assert.equal(decodeXmlEntities('100&#xZZ;%'), '100&#xZZ;%');
});

// ---------- 文件类型识别 ----------

test('docx 识别', () => {
  assert.equal(isDocxFile({ name: '讲义.DOCX', type: '' }), true);
  assert.equal(isDocxFile({ name: 'a.doc', type: DOCX_MIME }), true);
  assert.equal(isDocxFile({ name: 'a.pdf', type: 'application/pdf' }), false);
});

test('OLE 魔数识别旧版 .doc', () => {
  assert.equal(looksLikeLegacyDoc(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), true);
  assert.equal(looksLikeLegacyDoc(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), false);
});

// ---------- XML → 单元 ----------

const XML = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 矩阵</w:t></w:r></w:p>
<w:p><w:r><w:t>矩阵 A &amp; 向量 b 的秩</w:t></w:r></w:p>
<w:p/>
<w:p><w:r><w:t>第一行</w:t><w:br/><w:t>第二行</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
<w:tr><w:tc><w:p><w:r><w:t>秩</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>定义</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>最大无关组大小</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>1.1 可逆矩阵</w:t></w:r></w:p>
<w:p><w:r><w:t>若存在可逆矩阵 P，则称 A 可对角化。</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="标题 1"/></w:pPr><w:r><w:t>中文章节</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="2"/></w:pPr><w:r><w:t>数字样式标题</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>普通样式不是标题</w:t></w:r></w:p>
</w:body></w:document>`;

test('段落按顺序抽成单元，空段落不占号', () => {
  const units = extractDocxUnitsFromXml(XML);
  assert.deepEqual(
    units.map((u) => u.unit),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    '空 <w:p/> 应被跳过，序号连续',
  );
  assert.equal(units.length, 9);
  assert.equal(units[0].text, '第一章 矩阵');
  assert.equal(units[1].text, '矩阵 A & 向量 b 的秩', '实体应已还原');
  assert.equal(units[2].text, '第一行\n第二行', '<w:br/> 应变成换行');
});

test('表格整表一个单元，行内单元格用 | 分隔', () => {
  const units = extractDocxUnitsFromXml(XML);
  const tbl = units.find((u) => u.kind === 'table');
  assert.ok(tbl, '应识别出表格');
  assert.equal(tbl.text, '秩 | 定义\n1 | 最大无关组大小');
});

test('<w:tblPr> 不会被误认成表格（前缀陷阱）', () => {
  const units = extractDocxUnitsFromXml(XML);
  assert.equal(units.filter((u) => u.kind === 'table').length, 1);
});

test('三种标题写法都认：Heading1 / 标题 1 / outlineLvl / 纯数字样式', () => {
  const units = extractDocxUnitsFromXml(XML);
  const titles = units.filter((u) => u.kind === 'title').map((u) => u.text);
  assert.deepEqual(titles, ['第一章 矩阵', '1.1 可逆矩阵', '中文章节', '数字样式标题']);
});

test('Normal 样式不算标题', () => {
  const units = extractDocxUnitsFromXml(XML);
  const normal = units.find((u) => u.text === '普通样式不是标题');
  assert.equal(normal.kind, 'body');
});

test('section 跟着最近的标题走', () => {
  const units = extractDocxUnitsFromXml(XML);
  assert.equal(units[1].section, '第一章 矩阵');
  assert.equal(units[2].section, '第一章 矩阵');
  assert.equal(units.find((u) => u.kind === 'table').section, '第一章 矩阵');
  const after = units.find((u) => u.text.startsWith('若存在可逆矩阵'));
  assert.equal(after.section, '1.1 可逆矩阵', '第一个标题之后应切换到新章节');
  assert.equal(units[units.length - 1].section, '数字样式标题');
});

test('标题之前的正文没有 section', () => {
  const xml = '<w:body><w:p><w:r><w:t>前言</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p></w:body>';
  const units = extractDocxUnitsFromXml(xml);
  assert.equal(units[0].section, undefined);
  assert.equal(units[1].section, '第一章');
});

test('没有 w:body 时退化为整篇扫描（容错）', () => {
  const units = extractDocxUnitsFromXml('<w:p><w:r><w:t>孤立段落</w:t></w:r></w:p>');
  assert.equal(units.length, 1);
  assert.equal(units[0].text, '孤立段落');
});

test('空文档返回空数组', () => {
  assert.deepEqual(extractDocxUnitsFromXml('<w:body></w:body>'), []);
  assert.deepEqual(extractDocxUnitsFromXml('<w:body><w:p/><w:p>   </w:p></w:body>'), []);
});

test('表格单元格内多段拼成一行', () => {
  const xml =
    '<w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>上</w:t></w:r></w:p><w:p><w:r><w:t>下</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>';
  const units = extractDocxUnitsFromXml(xml);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, '上 下 | 值');
});

test('制表符保留为 \\t', () => {
  const xml = '<w:body><w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t></w:r></w:p></w:body>';
  assert.equal(extractDocxUnitsFromXml(xml)[0].text, '甲\t乙');
});

// ---------- 真 zip ----------

function makeDocx(xml, extra = {}) {
  return new Blob([
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(xml),
      ...extra,
    }),
  ]);
}

await testAsync('从真 .docx（zip）读出单元', async () => {
  const units = await readDocxUnits(makeDocx(XML));
  assert.equal(units.length, 9);
  assert.equal(units[0].text, '第一章 矩阵');
});

await testAsync('filter 只解 document.xml：带 200KB 图片的包也能正常读', async () => {
  const units = await readDocxUnits(
    makeDocx(XML, { 'word/media/image1.bin': new Uint8Array(200 * 1024).fill(7) }),
  );
  assert.equal(units.length, 9, '大媒体文件不应影响抽取');
});

await testAsync('旧版 .doc（OLE 魔数）→ 给出「另存为 .docx」的可操作提示', async () => {
  const ole = new Uint8Array(64);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await assert.rejects(() => readDocxUnits(new Blob([ole])), /另存为 \.docx/);
});

await testAsync('不是 zip → 报「不是有效的 .docx」', async () => {
  await assert.rejects(() => readDocxUnits(new Blob([strToU8('这不是一个文档')])), /不是有效的 \.docx/);
});

await testAsync('是 zip 但没有 word/document.xml → 报缺文件', async () => {
  const blob = new Blob([zipSync({ 'word/styles.xml': strToU8('<x/>') })]);
  await assert.rejects(() => readDocxUnits(blob), /缺少 word\/document\.xml/);
});

// ---------- 汇总 ----------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
