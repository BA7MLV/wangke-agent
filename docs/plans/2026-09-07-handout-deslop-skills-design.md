# 讲义去 AI 腔 + Skill 挂载系统设计文档

日期：2026-09-07
状态：已确认，实施中

## 1. 背景

讲义生成未达到公文水平，AI 腔重（"首先…随后…最后"流水账、评价性套话、Markdown 星号泄漏进 DOCX、版式非 A4 公文规范）。同时希望网站支持 Skill 挂载，让写作规范成为可管理、可注入的资产。

## 2. 诊断结论（修复范围 A+B+C）

- **A 提示词层**：空角色断言、无负面清单、分节缺全局上下文、硬字数指标诱导凑字。
- **B 解析层**：DOCX 生成前无 Markdown 清洗，`**（一）**` 导致标题层级塌陷。
- **C 版式层**：缺 A4 页面、公文页边距（上3.7/下3.5/左2.8/右2.6 cm）、页码；结构硬编码"课程概述/课程内容详解"，不来自大纲。

## 3. Skill 系统

- **格式**：Agent Skills 规范子集——单 `.md` 文件，YAML frontmatter（`name`/`description`）+ 正文。frontmatter 解析自写，零新依赖。
- **存储**：Dexie version(2) 新增 `skills` 表：`{ id, name, description, body, enabled, builtin, updatedAt }`；首次启动 seed 内置「公文讲义写作」skill。
- **UI**：设置页「写作技能」卡片：列表/启用开关/导入 .md（多选）/新建/编辑/删除/内置重置。内置 skill 编辑后自动存为副本，保留重置基准。
- **注入**：仅作用于讲义生成；启用中的 skill 正文拼接（总预算 6000 字）注入 outline 与 section 提示词。

## 4. 提示词重写要点

- outline/section 增加 skillBlock 参数；section 补传课程标题 + 总概述。
- 概述禁止流水账与评价性套话；篇幅改"按内容需要，一般 200~500 字"。
- 输出契约显式化：纯文本、禁止 Markdown 符号、`[图:mm:ss]` 配图标记。

## 5. DOCX 版式要点

- `cleanModelText()`：去 `**`/`__`/`##`/反引号/引用符后再做层级匹配；`*`/`•` 归入条目。
- A4 + GB/T 9704 页边距；页脚页码居中「— 1 —」（宋体四号）。
- 结构：大标题 → 概述段（公文开头）→ 大纲章节直接作「一、二、三…」一级标题；图注去时间戳（回查走问答）。

## 6. 文件清单

新建：`src/skills/{types,builtin,store}.ts`、`src/components/SkillsCard.tsx`
修改：`src/store/db.ts`、`src/pages/Settings.tsx`、`src/harness/prompts.ts`、`src/pipelines/handout.ts`、`src/handout/docx.ts`、`README.md`

验证：`npm run build`；真实生成效果用 `scripts/e2e-handout.mjs`（需 API Key）。

---

## 7. 渐进式披露扩展（2026-09-07 追加，已确认）

用户要求：学科类 skill（数学/编程等），同时作用于讲义与问答；支持目录结构。

- **三级披露**：
  - 问答（有 agent 循环）：Level 1 元数据清单进系统提示词 → Level 2 `use_skill(name)` 工具加载正文（返回附带 references 列表）→ Level 3 `read_skill_reference(name, path)` 按需读参考文档。
  - 讲义（确定性流水线）：Level 1 元数据进「路由」调用（课程名+字幕片段 → 选用名单，一次小调用）→ Level 2 只注入选中正文；Level 3 不适用（单次调用无法边写边查）。
  - 手动覆盖：视频级 `skillOverride: { pin, drop }`（HandoutPanel「技能」Popover，自动/必用/排除三态）；路由失败兜底为全部启用。
- **目录结构**：zip 包上传（iPad「文件」App 可压缩文件夹），fflate 解压；只取 `SKILL.md` + `references/*.md|txt`（scripts/assets 在浏览器无使用场景，忽略）。
- **存储**：Dexie version(4) 新增 `skillRefs` 表（skillId + path + body）；`HandoutRow.usedSkills` 记录每次生成选用的技能名；删除技能级联删 refs。
- **作用域**：不加 appliesTo 字段，按规范由 description 驱动路由/ agent 自主选择。

