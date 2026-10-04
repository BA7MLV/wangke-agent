# Markdown 阅读材料的封面（标题卡）设计

- 状态：**已实现并回归**
- 日期：2026-10-04
- 需求：导入的 `.md` 也能有封面。库页不该再出现「只有文档图标」的卡片
- 前作：`2026-09-17-cover-design.md` §6.2 把「Word 材料没有封面」列为已知取舍，本次只解 md

## 1. 问题：链路早就准备好了，只差 `pickMaterialCover` 认一下格式

封面 v10 起就是**派生资源**：独立 `covers` 表（主键 `videos.id`）、串行队列、导入即入队、
启动回填、读取端四级降级。这套东西对 md 全部适用 —— `Library.tsx` 的 `importMaterial`
本来就对所有材料调 `enqueueCover(id)`，`useThumb` 有封面就画封面。

真正缺的是一处：`pipelines/cover.ts` 的 `pickMaterialCover()` 里只有

```ts
if (row.materialFormat !== 'pdf') return null;
```

于是 md / docx / html 一律 `return null` → `coverState: 'done'`，卡片上永远是
`<mdui-sym-description />`。前作 §6.2 给的理由是「硬要生成就得自己排版一张标题卡
（canvas fillText + CJK 换行），收益不高且容易做得难看」—— 这条理由对 **Word** 成立
（样式千差万别，没有稳定可取的标题），对 **Markdown 不成立**（有干净的标题层级和开头一段话）。

## 2. 为什么不渲染真实首屏

第一直觉是「把 md 渲染进离屏 DOM，`SVG foreignObject` 光栅化出图」，即所见即所得。否决理由：

1. `foreignObject` 光栅化对 webfont 支持很差，CJK 很可能整块丢字形；
2. 文档里的外部图片会**污染 canvas**，`toBlob` 直接抛 `SecurityError`（本项目的
   `html.ts` 净化策略会摘掉大部分 `src`，但封面生成不走那条路）；
3. 要脱离 React 树再跑一遍 `XMarkdown`。

失败模式既难预测又难复现，而收益只是「图里长得更像原文」。改成老老实实**排一张标题卡**：
纯 canvas、无新依赖、不联网、不可能失败，几十毫秒出一张。

## 3. 设计

### 3.1 封面长什么样

480×270（16:9，铺满 `.video-row__thumb` 的通栏，不留 PDF 那样的竖版黑边）：

```
┌────────────────────────────────┐
│  线性代数第三章：特征值与特征向量   │  白字 32px 600，最多 2 行
│  ─────                          │  36×2 白色 45% 分隔线
│  设 A 是一个 n × n 的方阵。如果…    │  白字 74% 15px，最多 3 行
└────────────────────────────────┘
```

底色是**标题哈希派出的色相**（黄金角步进，`hueOfTitle`），固定 `hsl(h 42% 30%)` →
`hsl(h+22 38% 22%)` 的斜向渐变，外加左上柔光与右下同色系浅色圆。

三个刻意的取舍：

| 决定 | 理由 |
| --- | --- |
| 16:9 铺满，不留黑边 | PDF 是竖版 A4，塞进通栏会留两条黑边；标题卡没有「原始版面」这回事。圆角也不用自己画 —— `.video-row__thumb` 自带 `overflow: hidden` + `border-radius` |
| 底色按标题哈希 | 库页一屏几十张，颜色全一样等于没有封面 |
| 固定低明度 + 白字 | `.video-row__duration`（右下角「N 段」徽标）是 `rgb(0 0 0 / 0.78)` 底白字，只有深底保证它在任何封面上都读得清 |
| 整块垂直居中 | 标题一行还是两行、有无预览，版面都不会偏上或偏下 |

### 3.2 三个坑

1. **CJK 折行**：中文正文没有空格，按空格折行会一个断点都没有，`measureText` 只能整段
   塞进一行然后裁掉右半边。`tokenize()` 按「CJK 逐字 / 拉丁词整体 / 空白压成单空格」
   三类切 token。空格**必须**作为 token 保留 —— 早期版本漏了它，渲染出
   `DistributedSystems:` 这种黏在一起的词。
2. **字体栈要显式列 CJK**：canvas 的 `font` 不吃 CSS 变量，`-apple-system` 之外必须把
   `PingFang SC` / `Microsoft YaHei` 等逐个列出，否则中文掉到默认衬线体上。
   画之前 `await document.fonts.ready`，否则量不准宽度、换行会跟着系统字体走。
3. **预览文案的来源**：见 §3.3。

### 3.3 取文案：`mdCoverText` 直接用 `piecesOf`

`mdCoverText(src)` 返回 `{ title, preview }`，**直接调 `piecesOf`**（与阅读器、
`extractMdUnits` 同一套切块规则），不另写解析。

踩过一次弯路：最初想复用 `extractMdUnits` 的产物再「剥掉开头的标题行」。行不通 ——
它把标题并进正文，产物是 `标题\n\n正文`，多个标题时是 `甲\n\n乙\n\n正文`，而**标题在
产物里已经和正文长得一模一样**，拆回去必然出错（第一版漏掉第二个标题，第二版按空行切
也只剥得掉第一个）。`pieces` 里标题与正文是两个独立条目，各拿各的。

- `title` 取**全文首个标题、不要求是 H1**（只从 H2 起的导出文档很常见，拿 H2 远比回落
  文件名贴切）。没有则返回 `null` 而非空串 —— 调用方据此决定用不用文件名，空串会被
  误当成「有标题但排不出来」。`frontmatter` 里的 `title:` 不算数（阅读器也不显示它）。
- `preview` 取**首个正文条目**并 `flattenMd()` 压成一行：剥掉链接/图片、列表项、引用、
  行内标题、粗体斜体、行内代码、**行内公式的 `$`**。围栏首行剥掉但**围栏正文保留**
  （`print(1)` 本身就是有用的预览信息）。

标题与预览的位置未必挨着（正文开头没有标题、标题出现在第二段的文档很常见），所以扫
一遍 `pieces` 不 `break`。

### 3.4 链路接入

| 位置 | 改动 |
| --- | --- |
| `materials/md.ts` | 新增纯函数 `mdCoverText`（沿用该文件「不依赖 DOM、供 node 直测」的约束） |
| `media/textCover.ts` | 新增 `paintTextCover` / `hueOfTitle` |
| `pipelines/cover.ts` | `pickMaterialCover` 按格式分派：`md` → 标题卡（`material-title`），`pdf` → 首页（`material-page`），其余 → null |
| `pipelines/coverQueue.ts` | 回填特判，见 §3.5 |
| 队列 / 读取端 / DB | **不动** |

`CoverRow.source` 的 `'material-title'` 是 v10 就预留好的枚举值（`db.ts:153`），
**DB 不升版本**。

标题与文件名都空（空文档）时 `pickMdCover` 返回 null，保留文档图标 —— 那张卡上确实
无字可排，画个纯色块反而更糟。

### 3.5 历史 md 的回填

前作 §6.2 里 md 是被标成 `done` 的，于是 `backfillCovers()` 第 80 行会跳过它们。
判据改成「`covers` 里没有它」而不是「`coverState` 不是 done」：

```ts
if (have.has(row.id)) continue;
if (row.coverState === 'skipped') continue;
if (row.coverState === 'done' && row.materialFormat !== 'md') continue;
```

跑两次的代价是零（`ensureCover` 见到已有封面立刻返回），因此**不必写迁移、不必升版本**。
入口 `App.tsx` 的启动回填是现成的 —— 用户下次打开应用，历史 md 自动补上。

### 3.6 一个被证伪的假设

中途怀疑过 `hash * 137.508 % 360` 的色相分布太挤（实测 20 个真实标题最小间隔 0.7°，
四篇挤在 25° 内），于是换成整数黄金角 + murmur finalizer + 高位比特，试了四个方案。

**蒙特卡洛（每方案 3000 组、每组 25 个标题）证明四个方案的平均最小间隔全是 0.6°。**
360 个色相槽里塞 20~40 个标题（一个库的实际量级），鸽笼原理下随机最小间隔的期望就是
`360 / n²`。也就是说「有几篇颜色接近」是必然的，不是哈希的锅，回退到最简版本。

真要拉开差距只能换维度（掺标题长度、给相邻色相加明度差），而那是在优化一个用户根本不会
注意的指标 —— 卡片上区分度的主要来源是标题文字本身。

## 4. 验证

`scripts/test-material-md.mjs`（19 passed，纯逻辑、无需起服务）新增 9 条，覆盖：典型取文案、
setext 标题、无标题回落、H2 起、frontmatter 不算数、行内标记剥离、行内公式 `$` 与货币
`$5` 的区分、连续两行标题、空文档。

`scripts/e2e-md-covers.mjs`（7 项全绿）：导入即有封面、16:9 铺满 480×270、小图档位
< 80KB、`source=material-title` + `dominantColor` 合规 + `covers` 只有一行、历史 md 被回填
重新排队、刷新后仍在、删除不留孤儿行。

`scripts/e2e-covers.mjs`（原有 10 项）回归全绿 —— PDF 与视频路径没被碰坏。

可视化：`scripts/shot-md-covers.mjs`（8 个 case 的排版网格）、
`scripts/shot-md-library.mjs`（真实库页五张卡片）。

用法：`npm run dev &` → `BASE_URL=http://localhost:5174 node scripts/e2e-md-covers.mjs`

## 5. 已知未做 / 取舍

1. **docx / html 仍无封面**，保留文档图标。Word 样式千差万别、没有稳定可取的标题；
   HTML 要处理 iframe 与远程资源。这两条要各自单开一笔。
2. **标题卡是合成的**，不是文档真实首屏。换来的是确定性（不联网、不可能失败、
   CJK 不丢字形），代价是它长得都一个样 —— 靠哈希色相区分。
3. **无手选封面入口**。`source: 'user'` 仍在类型与优先级里预留着，UI 未做（同前作 §6.1）。
4. **预览只取首段**。长文档的第二段内容不会出现在封面上。