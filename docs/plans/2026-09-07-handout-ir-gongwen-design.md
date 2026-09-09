# 讲义生成升级：结构化 IR + 公文版式 Skill 体系设计文档

日期：2026-09-07
状态：已实施（build 绿；IR 22/22、渲染 20/20、提示词 6/6、内置 skill 9/9、高清抽帧 e2e 6/6；真实 API 回归待 SF_KEY）

## 1. 背景与诊断

当前讲义生成（`src/pipelines/handout.ts` → `src/handout/docx.ts`）方向正确（Agent Skills 渐进式披露、GB/T 9704 版式常量、去 AI 腔负面清单），但有三块硬差距：

- **A 架构**：模型输出纯文本，DOCX 层靠正则猜层级（`parseContentToParagraphs`），模型输出格式稍有偏差排版即塌陷。
- **B 资产**：排版规则硬编码在代码里，skill 只能管语体；内置 skill 只有负面清单，缺 workflow、范文、自检清单、参考文档。
- **C 公文细节**：页码居中（国标要求单右双左）；首行缩进用 640 缇近似而非 OOXML `firstLineChars`；不支持表格（三线表）；无封面/目录/页眉/成文日期/孤行控制；图注不带章节号。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 改造范围 | 方案 B：结构化 IR，skill 分层为语体+版式策略；不做多版式主题（YAGNI） |
| 文档结构 | 封面 + 目录页 + 页眉 + 严格公文版式正文 |
| 目录实现 | TOC 域 + `updateFields`（Word/WPS 打开自动填页码）；应用内 docx-preview 预览目录处显示提示小字 |
| 缩进 | 补丁注入 `firstLineChars=200`（自定义 XmlComponent），替代 640 缇近似 |

docx@8.5.0 能力已验证：`TableOfContents` ✓、`settings.updateFields` ✓、`settings.evenAndOddHeaders` ✓、`widowControl` ✓；`firstLineChars` 未暴露，需补丁。

## 3. 总体架构与 IR 契约

流水线：抽帧 → VL 理解 → 分块摘要 → 大纲（JSON，不变）→ 分节写作输出 **IR JSON 块数组** → 渲染器 → DOCX。

```ts
type Block =
  | { type: 'lead'; text: string }                              // 节首主旨段（每节第一个块，必须）
  | { type: 'para'; text: string }                              // 正文段
  | { type: 'h2'; text: string }                                // 「（一）」级小节标题
  | { type: 'list'; ordered: boolean; items: string[] }         // 「1.」或「●」
  | { type: 'table'; header: string[]; rows: string[][] }       // 三线表
  | { type: 'figure'; ts: number; caption?: string }            // 配图
  | { type: 'note'; text: string }                              // 提示/注意（楷体小段）
```

- 排版样式 100% 由渲染器决定；「一、」「（一）」「1.」编号全部由渲染器自动生成，模型不写编号。
- `figure.ts` 从该节 VL 帧清单中选择；渲染器校验必须在节时间范围内，非法丢弃（不再"找最近"）。
- 兜底：`extractJson` + 手写校验失败 → 重试一次 → 再失败整节退化为单 `para` 块，任何情况不阻塞生成。
- 校验规则：块类型白名单；字符串字段非空；table 行列数一致；figure.ts 范围。

## 4. Skill 资产规划

内置 skill 集（初始 4 个，后扩至 6 个：公文讲义写作 / 公文版式规格 / 数学 / 编程 / 公考行测 / 公考申论），全部为标准 SKILL.md 文件（frontmatter + 正文），Vite `?raw` 导入，与用户导入的 .md 同构。

1. **公文讲义写作**（扩充现有）：保留语体负面清单；新增四步写作 workflow（定主旨→搭结构→行文→自检）、交前自检清单（10 条）、一整节范文（IR JSON + 说明）、常见病句对照表。
2. **公文版式规格**（新增）：块使用策略——h2 名词性短语、每节 2~4 个 h2；table 仅用于真实数据对比、列数 ≤4；figure 每节 0~3 张、放首次提及处之后；note 全篇最多 2 处。`references/` 放人类可读的 GB/T 9704 样式表（不注入提示词，供查阅）。
3. **数学讲义写作**、4. **编程讲义写作**：学科样例，各带 references。

**关键分工（防止用户改崩流水线）**：
- JSON schema 硬契约（字段名、块类型枚举）→ 硬编码在提示词模板，永远生效。
- 语体 + 块使用策略 → skill，可编辑可禁用；禁用后流水线照常运行，仅丢失风格指导。

注入预算：总 6000 字不变；每次注入 = 写作 + 版式 + 路由选中的学科 skill，预计 3000~4500 字。

## 5. 渲染层公文版式规格

| 元素 | 规格 |
|---|---|
| 封面 | 标题二号小标宋居中（回行词义完整）；课程名、成文日期三号楷体居中；不编页码 |
| 目录页 | 「目　录」小二黑体居中；条目三号仿宋、点线前导符、页码右对齐（TOC 域 + updateFields） |
| 页眉 | 讲义标题，五号宋体居中，下加细线（版记线风格） |
| 页码 | GB/T 9704：四号宋体阿拉伯数字、左右一字线；单页居右空一字、双页居左空一字（`evenAndOddHeaders` + 奇偶两套页脚） |
| 正文 | 仿宋_GB2312 三号、固定行距 28 磅、首行缩进 2 字符（firstLineChars=200 补丁）、孤行控制 |
| 标题 | 一级「一、」黑体三号；二级「（一）」楷体三号；编号渲染器生成 |
| 三线表 | 顶/底线 1.5 磅、栏目线 0.5 磅；表内五号仿宋；表题「表 2-1 ×××」小四黑体居中 |
| 插图 | 宽不超过版心；图注「图 2-1 ×××」小四楷体居中，编号带章节号 |
| note | 楷体_GB2312 三号，前后空行 |
| 西文/数字 | 一律 Times New Roman |

页面：A4 + 上 3.7 / 下 3.5 / 左 2.8 / 右 2.6 cm（沿用）。

## 6. 流水线改动、文件清单与验证

**提示词**：`PROMPTS.section` 重写为 IR JSON 契约（schema 硬编码）；节首必须 lead 块；`max_tokens` 2000→3000。`outline` 基本不动。

**文件清单**：
- 新建：`src/handout/{ir,styles,render}.ts`、`src/skills/builtin/`（4 个 SKILL.md + 2 个 references）、`scripts/render-handout-fixture.mjs`
- 修改：`src/harness/prompts.ts`、`src/pipelines/handout.ts`（解析+校验+重试）、`src/handout/docx.ts`（只留组装）、`src/skills/builtin.ts`（改 `?raw` 加载）、`README.md`
- 不动：skills 存储/路由/UI；旧讲义记录存成品 blob，无需迁移

**验证**：
1. `npm run build`（tsc 类型关）
2. `scripts/render-handout-fixture.mjs`：固定 IR 假数据生成 sample.docx（esbuild 打包 + node 执行，不依赖 API），解包 docx 断言 XML 属性（firstLineChars、奇偶页脚、三线表边框、行距）
3. `scripts/e2e-handout.mjs` 真实 API 回归（需 API Key）

## 7. 追加：插图双轨抽帧（2026-09-07 实施）

- **问题**：讲义插图复用 VL 识图帧（640px/JPEG q0.75），进文档显示宽 560px ≈ 110 DPI，屏幕/打印均糊。
- **方案**：VL 轨不变（省 token）；写作完成后按 `collectFigureTimestamps` 收集实际引用的 ts，`extractFramesAt`（1600px 封顶/q0.92）定点重抽替换，约 274 DPI。失败回退 VL 帧，不阻塞。
- **顺带修复**：VL 帧 ts 为浮点（如 1.2s），模型 figure.time 经 mm:ss 截断为整数秒，渲染 `Map.get` 失配丢图——images 表 key 统一 `Math.floor(f.ts)`。
- **验证**：`scripts/e2e-frames-hires.mjs`（playwright + dev server，无需 API key）断言分辨率/体积/ts 对齐，6/6 通过。

## 8. 追加：TOC 域占位内容（2026-09-07 实施）

- **问题**：目录用 TOC 域实现，域结果为空——docx-preview / Quick Look / Pages 等不执行域的查看器里目录页空白，仅 Word/WPS 打开更新域后可见。
- **方案**：域结果缓存（Word 自身保存 docx 的做法）——`postProcessDocx` 在 TOC 域 `separate..end` 之间注入占位段落：章节清单（仿宋三号、首行缩进 2 字符）+ 灰色小字提示「页码将在 Word / WPS 中打开后自动生成」。占位文本经 XML 转义；结构不匹配时静默降级。
- **效果**：任何查看器目录可见；Word/WPS 打开更新域后占位被带页码的真目录替换，提示行随之消失。
