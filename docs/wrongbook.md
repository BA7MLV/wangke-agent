# /wrongbook.md：普通 Markdown 资料

错题本没有独立页面、独立入口或专用 LLM 工具。文件出现在资料列表中，双击后使用普通 Markdown 阅读器和编辑器；解析、分块和检索复用普通 Markdown 流程。

## 工具

复用现有 `read`、`grep`、`edit`，也适用于其他 Markdown 资料：

```json
{"path":"/wrongbook.md"}
```

`read` 默认读取根目录 `.md` 文件原文（含注释），以行号返回，`offset` 从 0 起，`limit` 分页。已有资料也可使用 `/courses/{id}/material` 并传 `raw=true`。普通正文读取仍以段落为单位。

```json
{"path":"/wrongbook.md","query":"^## .*","regex":true}
```

`grep` 默认关键词搜索；Markdown 原文支持 `regex=true`，逐行匹配，`flags` 可用 `i/m/s/u`。

```json
{"path":"/wrongbook.md","create":true,"content":"# 错题本\n\n"}
```

`edit` 可创建尚不存在的根目录 `.md` 文件，不覆盖已有资料。以下为正则修改示例：

```json
{"path":"/wrongbook.md","edits":[{"old_string":"^状态：复习中$","new_string":"状态：已掌握","regex":true,"replace_all":true}]}
```

- 不传 `regex` 时复用既有精确匹配逻辑。
- `new_string=""` 删除匹配内容；匹配相邻正文并在替换文本中追加内容即可插入。
- 正则支持多行内容；`new_string` 按字面文本插入，不展开捕获组。
- 默认要求唯一命中，多处需要 `replace_all=true`。
- 无匹配、无效正则、零宽匹配和重叠编辑拒绝写入。
- 无需先打开编辑面。当前编辑面已开放时，普通课程路径的精确编辑仍保留既有高亮和撤销行为。
- 写文件时检查读取快照，防止覆盖并发更新，并在同一事务中重建普通 Markdown 检索块。

## 现有自动收录

已有课程/资料四选一题卡仍自动保存错答和作答时间，并用 `ts-fsrs` 更新已有调度参数。正文是可读题目、解析和记录表格，内部参数在注释中。自动收录更新时保留区域外的用户笔记；若手动修改导致自动收录需要的结构不完整，会明确报保存失败，不覆盖文件。

**普通 Markdown 编辑和工具增删改不要求该结构**，可自由修改、删除整题或重写为普通笔记。旧版 JSON 围栏仅做兼容迁移，不再提供专门的导入、导出、筛选或复习页。复习通过现有聊天和工具处理；不允许模型凭空编造 FSRS 参数。

文件保存在应用的浏览器本地资料存储中，不是宿主机路径；没有新增跨设备同步。当前不包含 PDF 整卷抽题、OCR、多选或判断题。

## 验证

- `node scripts/test-resource-tools.mjs`
- `npm run test:wrongbook`
- `node scripts/test-material-md.mjs`
- 开启 Vite 后：`node scripts/e2e-wrongbook.mjs`（独立浏览器上下文）。
