# 资源文件夹与 Bot 工作区

## 使用方式

1. 登录后进入「资源」，新建文件夹会立刻创建服务端真实目录，不需要先创建项目或选择 Bot。离线浏览器模式继续使用本地资料库，不代表服务端目录。
2. 顶层文件夹是独立的权限／沙盒范围。通过「文件夹设置」授权 Bot，再从「BOT 聊天」创建会话；多条会话共享该文件夹的真实文件，会话历史独立。
3. 子文件夹是范围内的真实目录。支持上传、下载、新建文本、重命名、拖动移动、文本编辑（1 MiB 上限）及删除文件／空目录。顶层范围不能拖入其他文件夹，避免隐式改变授权。
4. Markdown、PDF、Word、HTML 和视频自动关联课程索引；阅读器读取磁盘原文件，Markdown 编辑也写回同一文件。Bot／机器直接创建或修改的文件会在目录刷新时显示；当前目录每 5 秒刷新，Markdown 阅读器也会定期更新。未浏览目录不做全盘后台扫描。
5. 「更多操作 → 导入课程 / B 站视频」保留原课程导入、时长探测和字幕流程，导入结果进入当前真实目录。普通「上传文件」也允许其他文件格式。搜索限定当前目录名称。
6. 文件夹授权可为读取、读写、管理或未授权；管理权限额外允许 Bot 从独立会话重命名文件夹。文件夹可归档／恢复，归档不删除文件。文件删除后保留学习记录和会话，缺失文件的学习记录仍可从原目录打开。
7. `/system` 系统文件入口保持独立。旧 `/projects` 和项目文件链接重定向到资源页面；没有第二套项目导航或活动文件副本。

## 固定身份与目录

创建时生成 UUID，持久保存到 SQLite `projects.id`。物理目录只由此 ID 推导：

```text
DATA_DIR/
  db/wangke.sqlite
  files/projects/<project-id>/
```

自定义 `FILES_DIR` 时以该目录为准。Compose 默认映射到宿主机 `${WANGKE_HOST_DATA_DIR}/files/projects/<project-id>`，沙盒中显示为 `/workspace`。显示名称不参与路径构造；改名、归档、API 重启和更换执行容器不更换 ID 或目录。

界面中的文件夹就是 Bot 工作区的入口。内部仍保留 `projects.id` 和兼容 API 名称，只用于稳定身份、授权和现有会话关联，不再表示另一套资源实体。`folders`、`videos` 和 `courseFiles` 是目录／学习索引，`resource_roots`、`resource_folders`、`resource_files` 将它们映射到物理文件。重命名、移动会同步这些映射；同范围内的机器文件改名通过 inode 保留课程 ID。机器直接重命名整个目录时，重新浏览会建立该路径的目录索引。

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
GET            /resources?projectId=&path=&archived=false
POST           /resources/folders               { name }
POST           /resources/move                  { projectId, path, targetProjectId, target, revision }
GET            /resources/courses/:id            支持 Range
POST           /resources/courses/:id/text       { text, expected }
```

文本写入参数为 `{ text, expectedRevision }`：创建传 `null`，覆盖传上次读取返回的 revision，冲突返回 409。项目 PATCH 允许 `name`、`instructions`、`policy`、`archived`，不接受 ID/路径修改。

阅读器 Markdown 保存传完整原文快照 `expected` 做比较后写入；并发 Bot／页面修改返回 409，不覆盖新内容，编辑器保留草稿。目录／文件移动沿用 revision 校验、同名保护、路径安全和运行任务互斥。HTML 等课程原文件按附件返回，不能当作应用页面执行。

## 旧数据与备份

迁移 14 增加项目、BOT 授权、执行租约，以及会话的项目/BOT 归属与归档字段。已有 BOT 会话保留原记录/历史，根据原参与者补入主要 BOT。原独立会话继续使用 `wangke-workspace-<thread-id>` volume；不会静默复制或搬迁旧 volume，也不将旧会话强行改为项目会话。

资源迁移按用户惰性执行，首次访问资源时将旧虚拟文件夹按层级转换为真实目录，旧课程文件复制一次。原 blob 保留为非活动备份，不使用硬链接；之后界面和 Bot 都读取目录内文件，删除不会从备份自动复活。旧课程 ID、原有工作区目录、会话和授权不变。迁移后仍兼容旧资料夹名称／层级与课程名称／位置更新，并落实为真实目录／文件移动；顶层权限范围不可嵌套。迁移、重命名或移动遇到文件冲突会报错，不覆盖其他内容。实际部署前应先备份，当前测试仅使用隔离临时账户数据。

服务端解析／封面任务同样读取真实文件，并固定文件描述符传给子进程，不会重新打开可被替换的工作区路径。旧 worker 的 Markdown 写入同步到真实文件后清除活动 blob 引用；旧“删除源文件”操作按最近文件 revision 删除磁盘文件，遇到并发修改报冲突。删除请求只消费一次，不影响 Bot 之后重新创建的同名文件。

应用备份包含 `files/projects` 中的常规文件。现有备份脚本拒绝符号链接，恢复拒绝嵌套压缩包；有 venv/node_modules 等内容时应使用能正确保留这些文件类型的独立文件系统备份。备份前停止 API 和 broker。旧独立会话的 Docker volumes 仍需单独备份。

验证命令及 Docker 挂载环境变量见 [运行时部署](agent-runtime.md)。

资源专项验证：`npm run test:resources`、`npm run test:resources:e2e`。后者覆盖桌面／手机、真实 mkdir／上传／课程导入、机器直接创建文件、Markdown 阅读／保存／索引／并发保护、返回原目录、B 站入口及旧链接。截图保存在 `test-results/resource-folders`。

兼容边缘验证：`npx tsx scripts/test-resource-compat.mjs`，覆盖原生解析／封面、固定描述符与符号链接替换、worker 写回、旧删除／并发保护／文件重建、移动索引预检及视频扩展名。
