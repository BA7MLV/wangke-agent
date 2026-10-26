# 项目工作区

## 使用方式

1. 登录后进入「项目」，新建项目。默认授予当前账号第一个可用 BOT 读写权限；可在项目设置中调整。
2. 项目中创建多个会话，每条会话选择一个获授权的 BOT。会话历史独立，共享项目指令和工作区文件。
3. 「项目文件」支持上传、下载、创建文件夹、文本编辑（1 MiB 上限）及删除文件/空文件夹。「资料」根目录中的项目文件夹打开同一份工作区。
4. BOT 独立聊天按 BOT 分组。项目授权可为读取、读写、管理或未授权；管理权限目前额外提供独立 BOT 会话中的项目重命名能力。
5. 会话可重命名、归档、恢复；无未完成任务时可删除。项目可改名、归档、恢复，归档不删除文件。

## 固定身份与目录

创建时生成 UUID，持久保存到 SQLite `projects.id`。物理目录只由此 ID 推导：

```text
DATA_DIR/
  db/wangke.sqlite
  files/projects/<project-id>/
```

自定义 `FILES_DIR` 时以该目录为准。Compose 默认映射到宿主机 `${WANGKE_HOST_DATA_DIR}/files/projects/<project-id>`，沙盒中显示为 `/workspace`。显示名称不参与路径构造；改名、归档、API 重启和更换执行容器不更换 ID 或目录。

项目文件夹是后端工作区的入口，不是旧资料库 `folders` 表的副本。旧资料不会自动成为项目共享资料；需上传到项目文件。项目文件目前也不自动加入旧课程资料索引。

## 权限与一致性

- 用户只能管理自己拥有的项目；BOT 每次文件/命令调用重新校验该项目授权。
- 项目会话的 `project_id` 创建后不可迁移。文件工具不接受模型指定的其他项目 ID，shell 由后端注入项目 ID。
- 读取授权禁止写入和 shell；读写/管理授权仍受全局 read/write/remove/shell 策略及项目 shell/network 策略约束。审批绑定持久化工具参数，执行前再次校验权限。
- 项目会话不继承全局 MCP 连接器，也不能通过项目管理工具越出当前项目。独立 BOT 只能列出自己已获授权的项目，重命名还需要管理授权。
- 同项目运行任务串行，不同项目按 `BOT_CONCURRENCY` 并发。等待审批/定时唤醒时释放运行槽；继续执行时重新校验文件 revision 与授权。
- 浏览器写入与运行中的项目任务互斥，返回 409 `project_busy`；上传先写入不挂载到沙盒的暂存目录，提交时再次检查项目状态和锁。
- shell 执行登记持久化租约。取消/重启后，只有 broker 确认旧容器已移除才释放租约；broker 不可达时保留锁并重试，避免旧命令与新写入重叠。
- Linux 文件访问逐层使用 `O_NOFOLLOW` 和固定目录描述符；路径穿越、符号链接、硬链接和特殊文件不能通过文件 API 访问。macOS 开发环境使用检查路径，并禁止沙盒运行期间的文件 API 访问。
- 当前为单 API/runtime + SQLite 部署；没有跨实例调度锁、磁盘配额或项目文件语义检索。

## API

所有接口位于 `/api/v1`，使用现有 Cookie/Bearer 鉴权与 Origin 检查。

```text
GET/POST       /projects
GET/PATCH      /projects/:id
PUT            /projects/:id/agents/:agentId     { role: read|write|manage|null }
GET            /projects/:id/files?path=
GET/PUT        /projects/:id/text?path=notes.md
GET            /projects/:id/download?path=notes.md
POST           /projects/:id/uploads?path=lecture.pdf  application/octet-stream
POST           /projects/:id/directories?path=notes
DELETE         /projects/:id/files?path=notes.md&revision=...
GET            /threads?projectId=...&agentId=...
POST           /threads                        { mode: bot, projectId?, agentId?, title? }
PATCH          /threads/:id                    { title?, archived? }
DELETE         /threads/:id
```

文本写入参数为 `{ text, expectedRevision }`：创建传 `null`，覆盖传上次读取返回的 revision，冲突返回 409。项目 PATCH 允许 `name`、`instructions`、`policy`、`archived`，不接受 ID/路径修改。

## 旧数据与备份

迁移 14 增加项目、BOT 授权、执行租约，以及会话的项目/BOT 归属与归档字段。已有 BOT 会话保留原记录/历史，根据原参与者补入主要 BOT。原独立会话继续使用 `wangke-workspace-<thread-id>` volume；不会静默复制或搬迁旧 volume，也不将旧会话强行改为项目会话。

应用备份包含 `files/projects` 中的常规文件。现有备份脚本拒绝符号链接，恢复拒绝嵌套压缩包；有 venv/node_modules 等内容时应使用能正确保留这些文件类型的独立文件系统备份。备份前停止 API 和 broker。旧独立会话的 Docker volumes 仍需单独备份。

验证命令及 Docker 挂载环境变量见 [运行时部署](agent-runtime.md)。
