#!/usr/bin/env python3
"""
生成 e2e 用的确定性中文 PDF fixture：scripts/fixtures/sample-zh.pdf

为什么要专门造一份，而不是随便找个 PDF 提交进仓库：

1. **确定性**：e2e 要断言「检索命中第 2 页」「划词落到第 3 页」，内容必须每页都认识；
   手边的真实教材换成另一本就全挂了。
2. **刻意不内嵌字体**：中文用 reportlab 内置的 `STSong-Light`（Adobe 标准 CJK 字体，
   非内嵌），这种 PDF 的 CMap 必须由 pdf.js 从 `cMapUrl` 现取 —— 也就是说这份 fixture
   会真实地**验证 `/pdfjs/cmaps/` 这条链路**。如果 vite 插件没把 cmaps 供出来，
   这份 PDF 会渲染成空白，e2e 立刻炸，而不是等到线上某个用户的教材打不开。
3. **带书签目录**：用来验证阅读器的目录导航与「章节 → unitLabel」的 section 归属。

运行（一次性，产物提交进仓库）：
    python3 scripts/fixtures/make-pdf.py

依赖：reportlab（见 README 测试一节）。
"""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent / "sample-zh.pdf"
OUT_SCANNED = Path(__file__).resolve().parent / "sample-scanned.pdf"

# STSong-Light 是 reportlab 内置的 CJK 字体名，**不嵌入字体文件**，靠 CMap 映射。
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

FONT = "STSong-Light"
PAGE_W, PAGE_H = A4
MARGIN = 72


def title(c, text, y):
    c.setFont(FONT, 20)
    c.drawString(MARGIN, y, text)
    return y - 40


def heading(c, text, y):
    c.setFont(FONT, 15)
    c.drawString(MARGIN, y, text)
    return y - 28


def body(c, lines, y, size=11.5, leading=22):
    c.setFont(FONT, size)
    for line in lines:
        c.drawString(MARGIN, y, line)
        y -= leading
    return y


def build():
    c = canvas.Canvas(str(OUT), pagesize=A4, invariant=1)
    c.setTitle("线性代数讲义（fixture）")
    c.setAuthor("wangke e2e fixture")
    c.setSubject("用于网课学习助手阅读材料链路的自动化测试")

    # ── 第 1 页：封面 + 概述 ──────────────────────────────────────────────
    y = title(c, "线性代数讲义", PAGE_H - MARGIN - 40)
    y = body(
        c,
        [
            "本讲义用于自动化测试，每页内容固定且互相区分。",
            "",
            "第一页讲的是向量空间的基本概念。向量空间由一组向量与两种运算构成，",
            "这两种运算分别是向量加法与标量乘法，它们必须满足八条公理。",
            "判断一个集合是否构成向量空间，只需逐条核验这八条公理。",
        ],
        y,
    )
    c.bookmarkPage("p1")
    c.addOutlineEntry("线性代数讲义", "p1", level=0)
    c.showPage()

    # ── 第 2 页：矩阵的秩（含关键句，供检索断言） ────────────────────────
    y = heading(c, "第二章 矩阵的秩", PAGE_H - MARGIN - 40)
    y = body(
        c,
        [
            "矩阵的秩等于其行向量组的极大线性无关组所含向量的个数。",
            "这个定义与列向量组的秩是相等的，这条结论称为行秩等于列秩。",
            "",
            "求秩的常用方法是初等行变换：把矩阵化为阶梯形矩阵，",
            "阶梯形矩阵中非零行的行数就是原矩阵的秩。",
        ],
        y,
    )
    # 一张三线表：验证表格也能被抽成文本单元
    y -= 10
    c.setFont(FONT, 11.5)
    c.drawString(MARGIN, y, "矩阵               秩             是否可逆")
    y -= 20
    c.drawString(MARGIN, y, "二阶单位阵          2               可逆")
    y -= 20
    c.drawString(MARGIN, y, "零矩阵              0               不可逆")
    c.bookmarkPage("p2")
    c.addOutlineEntry("第二章 矩阵的秩", "p2", level=0)
    c.showPage()

    # ── 第 3 页：可逆矩阵（供划词/框选提问定位） ──────────────────────────
    y = heading(c, "2.1 可逆矩阵", PAGE_H - MARGIN - 40)
    y = body(
        c,
        [
            "设 A 为 n 阶方阵，若存在 n 阶方阵 B 使得 AB 等于 BA 等于单位阵，",
            "则称 A 是可逆矩阵，并称 B 是 A 的逆矩阵。",
            "",
            "方阵可逆的充分必要条件是它的行列式不等于零。",
            "可逆矩阵的行列式非零，这一条也是判断可逆最常用的方法。",
        ],
        y,
    )
    c.bookmarkPage("p3")
    c.addOutlineEntry("2.1 可逆矩阵", "p3", level=0)
    c.showPage()

    c.save()


def build_scanned():
    """
    假扫描件：有页面、有图形，**一个字都没有**（没有文本层）。

    用途：验证「没有文本层 → 不建索引 + 明确提示只能划词/框选」这条分支。
    真实的扫描件就是这样的 —— getTextContent() 返回空，而不是报错，
    所以这条路径必须显式判定并告知用户，否则会被当成「问答坏了」。
    画几根线是刻意的：让页面看起来有内容，避免测试因为「空白页」而碰巧通过。
    """
    c = canvas.Canvas(str(OUT_SCANNED), pagesize=A4, invariant=1)
    c.setTitle("扫描件 fixture（无文本层）")
    for page in range(1, 3):
        # 用矩形与线条模拟「扫描进来的图」，没有任何 drawString
        c.setStrokeColorRGB(0.2, 0.2, 0.2)
        c.setLineWidth(1.5)
        c.rect(MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN, stroke=1, fill=0)
        for i in range(12):
            y = PAGE_H - MARGIN - 60 - i * 40
            c.line(MARGIN + 24, y, PAGE_W - MARGIN - 24 - (i % 3) * 60, y)
        c.showPage()
    c.save()


if __name__ == "__main__":
    build()
    build_scanned()
    print(f"已生成 {OUT}（{OUT.stat().st_size} 字节，3 页，非内嵌 STSong-Light + 书签）")
    print(f"已生成 {OUT_SCANNED}（{OUT_SCANNED.stat().st_size} 字节，2 页，无文本层）")
