# Agent 虚拟资源工具

模型工具集由 `src/harness/resources.ts` 统一注册和路由，底层复用课程与资料库执行器。
旧工具协议仅作为内部实现保留，不再注册给模型；历史工具记录仍可显示。

对外共 8 个工具：`grep`、`read`、`edit`、`present_quiz`、`show_widget`、
`ask_user`、`set_course_context`、`propose_folder_plan`。

- 单课程：grep/read/present_quiz/show_widget；Markdown 编辑面开放时增加 edit。
- 资料库：grep/read/ask_user/set_course_context/propose_folder_plan；空库只注册 read/ask_user。

## 资源地址

路径是 IndexedDB 资源标识，不是操作系统文件路径。动态名称和 ID 使用 URI 编码。

| 路径 | 内容 |
| --- | --- |
| `/courses` | 课程列表；read 支持 status/kind、offset（从 0 起）、limit（最多 50） |
| `/courses/context` | grep 使用当前选中课程；没有固定上下文则搜索全库 |
| `/courses/{id}/info` | 课程详情及正文路径 |
| `/courses/{id}/transcript` | 字幕，range.unit 为 seconds |
| `/courses/{id}/material` | PDF 为 pages，其他材料为 paragraphs |
| `/courses/{id}/frames` | 幻灯片画面清单 |
| `/library/overview` | 学习概览 |
| `/library/folders` | 分类目录 |
| `/skills` | 本次会话可用技能及其路径 |
| `/skills/{name}` | 加载完整技能正文及参考资源路径 |

参考文档按技能正文返回的完整路径读取。单课程入口支持 `/courses/current` 别名，
且禁止访问其他课程或全库资源。grep 的 `/courses` 明确表示全库，不受固定上下文限制；
省略 path 时遵循当前上下文。搜索结果中的 path 可直接传给 read。

```js
grep({ path: '/courses', query: '贝叶斯' })
read({ path: '/courses/example/material', range: { unit: 'pages', start: 3, end: 5 } })
edit({ path: '/courses/current/material', edits: [{ old_string: '原文', new_string: '新文' }] })
```

正文读取范围为闭区间；字幕从 0 秒起，页/段从 1 起。单次最多 600 秒或 20 页/段，
截断时返回续读提示。不传 range 时默认前 60 秒或前 2 页/段。
edit 仍要求精确匹配、仅开放给当前 Markdown，并在执行时重新检查编辑面是否存在。
技能列表、正文与参考文档均遵循会话白名单及启用状态。

验证：`node scripts/test-resource-tools.mjs`（fake IndexedDB，不读取真实用户数据）。
