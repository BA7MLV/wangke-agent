# 任务执行架构（第一阶段）

```text
Fastify API
    ↓
SQLite 持久化任务调度（单实例）
    ├─ Node：模型调用、文本生成、纯文本材料解析
    ├─ FFmpeg 子进程：视频封面
    └─ Chromium：网页渲染及尚未迁移的兼容链路
```

队列仍使用 `cloud_tasks`，不新增 Redis 或外部队列服务。现有提交、查询、进度、取消、审批接口保持不变。
任务查询结果新增可选的 `executor` 字段，值为 `node`、`media` 或 `browser`；历史任务在未执行前可能没有该字段。
这是逐步迁移，**当前还不是所有非渲染任务都已去除 Chromium**。

## 当前分流

| 任务 | 执行器 |
| --- | --- |
| `modelOnce` 单次模型请求（Chat / Responses / Anthropic） | Node |
| `cards`、`comments`、`danmaku` | Node |
| `handoutEdit` 讲义单块 AI 改写 | Node |
| `material` Markdown / Word 正文解析 | Node |
| `cover` 视频封面（优先复用已有课件帧） | FFmpeg 子进程 |
| `cover` 材料封面 | Chromium 兼容执行器 |
| `material` PDF / HTML 解析 | Chromium 兼容执行器 |
| `chat`、`qa`、`transcribe`、`handout`、`artifactEdit` | Chromium 兼容执行器，待后续迁移 |
| Bot 工作空间 | 原有 Node `BotRunner`；命令仍交给独立 Docker 沙盒 |

普通聊天/课程问答包含交互提问、审批、资料编辑和图形渲染，后续需要逐步拆出共享执行核心，不能通过缩减工具列表来替代迁移。
转写仍保留原有 WebCodecs + VAD 分段及检查点，尚未改成 FFmpeg 音频流水线；完整讲义也尚未迁移。

## 数据与运行边界

- 调度器是唯一的队列状态管理者。Node 执行器在 API 进程内运行；媒体计算在子进程运行，目前不是独立 worker 集群。
- Node 执行器直接读写账号隔离的服务端数据，不启动页面、不使用 IndexedDB，也不依赖前端 `dist`。
- 原生材料解析限制源文件为 128 MiB、Word 解压正文为 32 MiB，超限明确报错，不影响原文件；避免直接在 API 进程内无界读入/解压。
- 文本任务与浏览器模式共用模型协议客户端、提示词、生成与清洗算法，避免维护两套生成规则。
- 模型地址和凭据只从服务器保存的配置读取，不接受任务输入提供的 URL / Key，不跟随重定向。
- 记录替换通过同一 SQLite 事务提交，取消后不再提交生成结果；文件必须是本账号的服务器文件索引引用。
- FFmpeg 不通过 shell 执行，不继承模型凭据；限制输入协议和格式、输出大小、线程数和运行时长。媒体子进程不是可供 Agent 执行任意命令的沙盒。
- 视频封面使用 FFmpeg 代表帧采样并输出最长边不超过 480 像素的 PNG；不保证与原浏览器评分算法选择同一帧。
- 失败的 Node / 媒体任务不会自动切到 Chromium 重做，避免重复模型费用和副作用。
- 默认计算并发仍由 `CLOUD_CONCURRENCY` 控制（1–4，默认 2），不同执行器共用此上限；同一课程/会话串行执行。
- 取消会中止模型 HTTP 请求或终止媒体子进程。服务器重启后运行中任务标记为 `interrupted`，需明确重试；排队任务继续执行。
- `BotRunner` 的定时唤醒及重启恢复策略不变，与云端流水线调度分开管理。

## 部署

Docker 镜像现在同时安装 FFmpeg 和 Chromium。因为仍有兼容链路，**暂时不能删除 Chromium 安装步骤**。
在本机直接运行 Node 时，需要安装系统 FFmpeg，或把 `FFMPEG_PATH` 设置为可执行文件路径。

```sh
npm run build
npm start
```

`npm run build:api` 会编译 API，并将无浏览器依赖的共享代码打包为 `dist-api/apps/api/runtime/node.mjs`。
构建会检查 Node bundle 没有引入浏览器数据库、前端状态或组件。开发 API 使用原生执行器前也应先运行 `npm run build:api`。

仅使用已迁移功能时，可以设置 `CLOUD_BROWSER_DISABLED=1`（Compose 支持同名环境变量）。
需要兼容执行器的任务会明确失败，而不是悄悄启动浏览器。这不是“全部功能的无 Chromium 模式”。
原来的 `CLOUD_WORKER_DISABLED=1` 仍表示禁用整个云端任务调度，不只禁用浏览器。

```sh
npm run test:tasks  # 需要 FFmpeg；不需要 Chromium、前端构建或真实模型凭据
```

测试覆盖三种模型协议、共享文本生成、账号隔离、Markdown/Word 解析、取消、重启恢复、失败不回退、真实视频封面及媒体进程超时/输出限制。
