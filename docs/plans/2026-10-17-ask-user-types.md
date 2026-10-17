# 提问卡归属与多类型作答

状态：已实现。替代 2026-10-16 设计中提问卡的交互约定。

## 消息归属

- 问题和可操作卡片放在助手消息内，输入区不再承载问题卡。
- 作答后问题保留为只读记录，答案以用户消息展示，随后助手继续。
- 等待时显示「等待你的回答」，自由输入仍可回答当前问题。

## 协议

`ask_user.type` 支持 `single`（默认）、`multiple`、`text`、`confirm`。
选择题提供 2–5 个 `{ id, label }`；兼容旧调用和旧记录中的字符串选项。
多选支持 `minSelections` / `maxSelections`，勾选后明确提交。
文本题无需候选。确认题使用稳定的 `confirm` / `decline` ID，按钮文案可指定。

`allowCustom` 控制用自由回答替代选项；补充说明与替代回答是独立操作。
`allowSkip` 默认关闭，打开时提供显式跳过入口。

答案保存为 `ask.answer`：status、mode、selectedIds、selectedLabels、text、note。
status 区分 answered / declined / skipped / cancelled；中断等待返回 cancelled。
`ask.picked` 保留可读摘要以兼容历史记录与已有导出消费者。
模型收到结构化工具结果；界面上的答案行不重复插入当前工具循环。
恢复路径与实时路径共用答案校验与工具结果序列化。

## 验证

- `node scripts/test-course-chat-tools.mjs`：类型、数量边界、稳定 ID、文本和状态语义。
- `BASE_URL=http://localhost:5178 node scripts/e2e-course-chat-cards.mjs`：消息归属、单选、自定义、手机布局、多选刷新恢复及持久化、文本、拒绝和跳过。
