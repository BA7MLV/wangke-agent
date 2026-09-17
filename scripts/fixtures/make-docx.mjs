#!/usr/bin/env node
/**
 * 生成 e2e 用的两个确定性 Word fixture：
 *
 * - `sample.docx`      正常讲义：两级标题 / 正文 / 表格，10 个段落单元
 * - `sample-empty.docx` 只有图片、**没有任何文字**：用于验证「解析不出正文」这条分支
 *
 * 为什么用 `docx` 库现造，而不是手写 zip：
 * .docx 要能同时被 **我们的抽取器**（`materials/docx.ts`）和 **docx-preview 渲染器** 接受，
 * 需要一整套 OOXML 骨架（[Content_Types].xml / _rels / styles.xml / document.xml）。
 * 手写极容易做出「我们抽得出来、docx-preview 渲染不出来」的假 fixture，
 * 那样测出来的绿是假的。`docx` 本来就是项目依赖（讲义生成用），产物是标准 OOXML。
 *
 * `sample.docx` 的内容刻意对齐 sample-zh.pdf（同 3 个章节、同类关键句），
 * 这样 PDF 与 Word 两条链路的 e2e 断言可以长得一样，差异只在「页」与「段」。
 *
 * `sample-empty.docx` 为什么是「图片」而不是「空段落」：真实世界里用户导入的
 * 「没有正文的 Word」几乎都是**内容被贴成图片**（截图排版、扫描导出）的那种，
 * 而不是一个真的空文档。用图片才测得到「有内容、但一个字都抽不出来」这条路径。
 *
 * 运行（一次性，产物提交进仓库）：
 *   node scripts/fixtures/make-docx.mjs
 *
 * ⚠️ **不是字节可复现的**：`docx` 会把当前时间写进 `docProps/core.xml`，
 * 所以重新生成会得到一个内容相同、哈希不同的文件（与两个 PDF fixture 不同，
 * 那两个用 reportlab 的 `canvas(invariant=1)` 固定了创建时间，重复生成字节一致）。
 * 因此**不要在无关的改动里顺手重跑本脚本** —— 会带进一个没有意义的二进制 diff。
 * 只有确实要改 fixture 内容时才跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'sample.docx');
const OUT_EMPTY = path.join(HERE, 'sample-empty.docx');

const p = (text) => new Paragraph({ children: [new TextRun(text)] });
const h = (text, level = HeadingLevel.HEADING_1) => new Paragraph({ text, heading: level });

const doc = new Document({
  title: '线性代数讲义（Word fixture）',
  description: '用于网课学习助手阅读材料链路的自动化测试',
  sections: [
    {
      children: [
        h('线性代数讲义'),
        p('本讲义用于自动化测试，每段内容固定且互相区分。'),
        p('第一段讲的是向量空间的基本概念。向量空间由一组向量与两种运算构成，这两种运算分别是向量加法与标量乘法。'),

        h('第二章 矩阵的秩'),
        p('矩阵的秩等于其行向量组的极大线性无关组所含向量的个数。'),
        p('这个定义与列向量组的秩是相等的，这条结论称为行秩等于列秩。'),
        // 表格：验证「整表一个单元、行内单元格用 | 分隔」
        new Table({
          rows: [
            new TableRow({
              children: [new TableCell({ children: [p('矩阵')] }), new TableCell({ children: [p('秩')] })],
            }),
            new TableRow({
              children: [new TableCell({ children: [p('二阶单位阵')] }), new TableCell({ children: [p('2')] })],
            }),
            new TableRow({
              children: [new TableCell({ children: [p('零矩阵')] }), new TableCell({ children: [p('0')] })],
            }),
          ],
        }),

        h('2.1 可逆矩阵', HeadingLevel.HEADING_2),
        p('设 A 为 n 阶方阵，若存在 n 阶方阵 B 使得 AB 等于 BA 等于单位阵，则称 A 是可逆矩阵。'),
        p('方阵可逆的充分必要条件是它的行列式不等于零。'),
      ],
    },
  ],
});

/** 1×1 透明 PNG：体积最小、字节确定，不引入外部资源文件 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const emptyDoc = new Document({
  title: '只有图片的 Word fixture',
  description: '用于验证材料「解析不出正文」这条分支',
  sections: [
    {
      children: [
        new Paragraph({
          children: [
            new ImageRun({
              type: 'png',
              data: PNG_1X1,
              transformation: { width: 120, height: 120 },
            }),
          ],
        }),
      ],
    },
  ],
});

const buf = await Packer.toBuffer(doc);
fs.writeFileSync(OUT, buf);
console.log(`已生成 ${OUT}（${buf.length} 字节，含两级标题 / 正文 / 表格）`);

const emptyBuf = await Packer.toBuffer(emptyDoc);
fs.writeFileSync(OUT_EMPTY, emptyBuf);
console.log(`已生成 ${OUT_EMPTY}（${emptyBuf.length} 字节，只有一张图片、无任何文字）`);

