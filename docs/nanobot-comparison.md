# nanobot 0.3.5 与当前 Bot 对比

核对日期：2026-10-27。nanobot 一侧依据用户指定版本的文档；当前项目一侧依据 `apps/api/src/agent/runner.ts`、`agent/model.ts`、`projects/tools.ts`、`mcp/` 和 `src/pages/BotWorkspace.tsx`。这是功能与实现对照，未进行性能或回答质量基准测试。

| 方面 | nanobot 0.3.5 值得借鉴的能力 | 当前 Bot | 建议 |
| --- | --- | --- | --- |
| 模型故障恢复 | 命名 Preset + 有顺序的 fallbackModels；处理可重试故障、限流与 Provider 不可用 | 每次执行选择账号主模型；请求失败结束任务，没有跨 Provider 回退链 | 优先：错误分类、有限重试、显式备用模型；回退时按更小上下文预算处理 |
| 长对话与长期记忆 | Consolidator 摘要归档；Dream 整理 SOUL/USER/MEMORY；Git 追踪与恢复 | 按模型 token 预算压缩并保留可恢复 checkpoint；Bot 记忆支持来源、版本、stale、墓碑和默认开启的后台偏好整理 | 继续借鉴 Dream 的去重、合并、替代和项目状态整理；保留当前的来源校验、事务和权限边界 |
| 自动化 | 一次性、固定间隔、Cron/时区；本地 Trigger；Heartbeat；任务列表与日历 | 已有持久化 wait、wake_at、后台执行与重启恢复；没有完整的周期任务和触发器管理 | 优先：在已有持久任务上增加 Cron、暂停/恢复、执行历史与目标会话绑定 |
| 多 Agent 协作 | 独立 Topic 上下文；read_session/list_sessions/send_session_message；并排对话与 Fork | 有 Bot 档案、独立项目会话、共享文件和授权；未提供 Agent 间委派与结果回传工具 | 后续：增加明确的子任务归属、取消传播和结果回传；同一系统提示中拼入多个角色不等于多 Agent 协作 |
| 执行可观测性 | 工具活动、文件 Diff、上下文占用、逐轮 token/耗时及可用的缓存命中数据 | 已有进度消息、持久 run_steps、审批和任务状态；缺少统一的逐轮 token 与上下文用量视图 | 优先：复用现有活动消息组件，增加结构化工具结果、耗时与用量 |
| 渠道接入 | WebUI/CLI/TUI，以及 Telegram、Discord、Slack、飞书、微信、Email 等聊天渠道与配置向导 | 主要是网页 Bot；服务端 Bot 路径中未见通用聊天渠道适配层 | 按需求：先统一入站消息、身份、会话和回复目标，再实现最需要的渠道 |
| 扩展生态 | Apps 统一管理 Agent Plugin、CLI App、MCP；Skills 支持 Marketplace 发现 | 已有 Skills 和 MCP 管理、OAuth、会话范围选择；项目 Bot 当前使用项目工具而不加载 MCP catalog | 后续：优先统一现有入口及项目内工具选择，再考虑插件安装与分发 |
| 长期目标 | /goal 让工作跨多个轮次推进，配合常驻 Gateway 和自动化 | 已有多步骤执行、步骤预算、等待唤醒与浏览器关闭后继续执行 | 后续：补充目标状态、完成条件和用户可见的暂停/继续，而不是重做后台执行器 |

## 当前值得保留的基础

- SQLite 持久任务、执行步骤和审批结果；进程中断后不会直接重放可能已有副作用的命令。
- 项目授权、文件修订检查、沙盒执行租约和多账号隔离，适合当前部署形态。
- 课程资料、讲义、字幕、卡片等学习工作流，以及现有 UI 和云同步。

综合建议：先借鉴**模型回退、上下文压缩、可管理的自动化、执行用量视图**。直接整体替换 Bot 运行时并没有从这些文档中得到充分依据。

## Provider 与模型设置的参考边界

- [models.dev](https://models.dev) 的 `/api.json` 提供 Provider 与模型能力；目录条目不代表当前账号的实际调用授权。
- [Pi models.generated.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.generated.ts) 当前是按 Provider 汇总的生成索引，引用各 Provider 的模型模块。借鉴其 Provider + model ID 组织方式；本项目直接拉取 models.dev，并保留用户能力覆盖。
- 云端模型页复用 `ModelsModule`、`ProviderPresets`、`ModelLibrary` 和模型能力组件。差异集中在内存编辑草稿与服务端保存适配层。

## nanobot 来源

- [介绍](https://nanobot.wiki/cn/docs/0.3.5/getting-started/nanobot-overview)
- [模型回退](https://nanobot.wiki/cn/docs/0.3.5/guides/configure-model-fallback)
- [记忆](https://nanobot.wiki/cn/docs/0.3.5/use-nanobot/memory)
- [自动化](https://nanobot.wiki/cn/docs/0.3.5/use-nanobot/automations)（本地 Trigger 不等于内置公网 Webhook 服务）
- [WebUI](https://nanobot.wiki/cn/docs/0.3.5/getting-started/webui)
- [持续长任务](https://nanobot.wiki/cn/docs/0.3.5/guides/long-running-ai-agent)
