# 资源文件夹与 Bot 工作区

## 使用方式

1. 登录后进入「资源」，新建文件夹会立刻创建服务端真实目录，不需要先创建项目或选择 Bot。离线浏览器模式继续使用本地资料库，不代表服务端目录。
2. 顶层文件夹是独立的权限／沙盒范围。通过「文件夹设置」授权 Bot，再从「BOT 聊天」创建会话；多条会话共享该文件夹的真实文件，会话历史独立。
3. 子文件夹是范围内的真实目录。支持上传、下载、新建文本、重命名、拖动移动、文本编辑（1 MiB 上限）及删除文件／空目录。顶层范围不能拖入其他文件夹，避免隐式改变授权。
4. Markdown、PDF、Word、HTML 和视频自动关联课程索引；阅读器读取磁盘原文件，Markdown 编辑也写回同一文件。Bot／机器直接创建或修改的文件会在目录刷新时显示；当前目录每 5 秒刷新，Markdown 阅读器也会定期更新。未浏览目录不做全盘后台扫描。
5. 「更多操作 → 导入课程 / B 站视频」保留原课程导入、时长探测和字幕流程，导入结果进入当前真实目录。普通「上传文件」也允许其他文件格式。搜索限定当前目录名称。
6. 文件夹授权可为读取、读写、管理或未授权；管理权限额外允许 Bot 从独立会话重命名文件夹。文件夹可归档／恢复，归档不删除文件。文件删除后保留学习记录和会话，缺失文件的学习记录仍可从原目录打开。
7. `/system` 系统文件入口保持独立。旧 `/projects` 和项目文件链接重定向到资源页面；没有第二套项目导航或活动文件副本。

### 聊天中选择项目

主页「选择项目」可选择现有顶层资源文件夹，或直接新建项目；新建时自动生成名为 `项目：项目名` 的资源文件夹，无需先配置 Bot。本地离线模式创建本地资料文件夹，登录后端模式创建真实服务端目录。项目是组织多份资料的文件夹，课程则是其中单份可播放／阅读、带学习索引的资料。

首次发送后上方项目入口自动收起，项目归属保存在会话的 `projectFolderId`，刷新、切换及分支会话仍保留；可从输入栏「＋ → 选择项目」修改。默认课程列表／正文检索使用此文件夹及子文件夹中的资料，不受五门固定课程引用的限制；显式全库检索或指定课程仍可跨项目。新会话不继承上一会话的项目。

资源文件夹的「更多操作 → 文件夹颜色」支持蓝、绿、黄、橙、红、紫、灰。顶层及子文件夹均持久保存颜色，改名、移动和重启不丢失；系统文件夹保持独立灰色。

### 普通 Bot 的默认目录

普通 Web／IM Bot 会话共用当前用户的 `Bot` 文件夹：新接收的附件、导出的文本默认归入这里，`workspace` 文件工具与 shell 的 `/workspace` 指向同一个真实目录。Bot 在开始处理附件前完成归档，无需先打开资源页面。已存在同名文件夹时创建 `Bot (2)` 等独立目录，默认身份由 `bot_workspaces` 保存，不按名称猜测或接管用户目录。

`workspace` 未传 `projectId` 时只访问默认目录，`path=""` 表示 Bot 文件夹；`mkdir` 可以逐层创建任务子目录，`projects create` 也在 Bot 内新建子目录。Bot 可访问当前用户的全部资源项目（归档项目可读但不能修改或执行）；先用 `projects list` 获取准确 ID，再显式传入 `projectId`。查询失败不会自动转到其他目录。返回值携带实际 `projectId` 和相对路径，文件夹改名不改变默认身份。`/system` 通过系统工具和 shell 访问；整个目录的读取、新建、修改和技能安装不用审批，删除仍需审批，详见下节。已有工作区文件通过 `study_upload_file` 登记后发送，不会再在 Bot 顶层生成一份附件副本。

首次建立默认目录时给现有启用 Bot 管理授权，新建 Bot 同样获得该目录授权；Bot 访问用户自己的其他资源项目不依赖逐项目 grant，仍受全局 Bot 策略、项目 shell/network 策略和归档状态约束。默认目录的 shell/network 策略允许沿用全局策略，仍以全局开关和部署设置为准。用户与其他账户的资源继续隔离。从指定文件夹创建的会话也可按准确 projectId 访问同一用户的其他项目。

shell 与文件工具使用相同的用户资源边界，不再因旧的只读 grant 单独拒绝命令。跨项目 shell 按目标项目的 shell/network 策略执行，而非会话默认目录的策略；审批持久保存目标 projectId，重启恢复后仍重新校验该目标的当前策略，不能用旧审批覆盖新禁用。二进制文件通过 `study_upload_file` 的 projectId 选择资源项目，归档项目仍可只读登记文件。

### `/system` 高权限与删除审批

- Bot 可修改当前账户整个 `/system`，包括 `AGENTS.md`、`memory/`、`mcp.json`、`skills/` 及其他自建文件／目录，不涉及其他账户或宿主机系统目录。普通会话与项目会话适用同一规则。
- `read`、`grep`、`skill_load`、`edit` 的创建／追加／替换，以及旧 `study_memory` 的读取／保存直接执行，不因 `read/write=ask` 再次询问，也不要求先信任 Bot。文档修改仍检查 revision，并发编辑会返回冲突。删除文件、目录或记忆始终需要一次性人工审批，信任 Bot 或 `remove=allow` 不能跳过。
- shell 默认将**整个** `/system` 只读挂载，`skills` 不例外。修改、安装技能或新建文件／目录时传 `systemWrite=true`，无需审批，仅该命令获得可写挂载（不因 shell/read/write 的 `ask` 阻塞）；后续命令恢复只读。删除必须同时传 `requiresApproval=true`，运行时也对 `rm/rmdir/unlink`、`find -delete`、`rsync --delete` 及常见 Python／Node 删除调用强制确认。涉及 `/system` 的审批显示全目录写权限及完整命令；普通 shell 审批不隐含此权限。
- **删除检查不是任意脚本的文件系统安全边界**：可写挂载允许程序调用删除 API，无法仅靠命令文本完整识别间接执行、动态拼接或混淆代码。Bot 工具契约要求所有删除主动申请审批，不得伪装成修改；当前不承诺对任意恶意程序实现“可修改但绝不能删除”。
- API 在执行前校验持久化步骤、账户、目标项目、命令、网络和超时；删除／外部影响等需要确认的操作仍校验精确审批。显式 read/write/remove/shell 禁用、目标项目禁用、归档只读及网络限制仍优先，旧审批不覆盖撤权。其他设置／外部工具的审批规则不变。broker 仅接受可信 API 请求，不向公网或命令容器开放。
- 自动记忆整理默认开启；Agent 自行判断值得长期保留的信息，用户只控制 Bot 是否使用长期记忆。整理不逐条审批，不重跑原已完成任务。记忆写入与游标原子提交，重启和重试不重复保存，删除墓碑防止复活。来源变化、关闭整理、取消或当前权限禁用阻止写入。
- 生效需要更新并重启 **API 和 sandbox broker**，不能只改提示词或只发布 Web；不需要数据库迁移。真实挂载验证见 `npm run test:sandbox`。

### Python 执行、文件命名与重名

shell 的初始工作目录是 `/workspace`。Python 相对路径写入这里的真实资源目录，后续命令和重建后的执行容器仍能读取；`/tmp` 仅属于本次容器，结束后不保留。程序自行 `chdir` 后，相对路径以新的工作目录为准。

- Python／shell 直接创建的文件保留程序指定的名字，没有强制任务前缀、时间戳或自动重名编号。`open(path, 'w')`、`Path.write_text` 等可覆盖同名文件；需要禁止覆盖时用独占创建（如 `open(path, 'x')`），并为独立任务建立子目录。文件工具的 revision 保护不拦截程序内部写入。
- `workspace write` 新建传 `expectedRevision=null`，同名文件返回冲突；替换已有文本必须提供最新 revision。页面上传同名文件同样拒绝覆盖。新建文本、附件复制和页面上传使用原子不覆盖安装，不再依赖“先检查不存在、再 rename”的竞态窗口。
- 上传／附件归档保留有意义的原名，统一为 NFC，清理路径分隔符、控制字符、双向文本控制符和不可移植字符，保护 Windows 保留名。名称最多 240 个 UTF-8 字节（扩展名最多 32 字节），截短不破坏中文或 emoji，并为 `name (2).ext` 等冲突后缀预留空间。不会批量重命名既有文件。
- PNG／JPEG／GIF／WebP 上传按实际文件头及图片元数据校验格式（40 MP 上限），修正展示名后缀和 MIME，保留原始字节，不做转码。这是格式校验，不是所有动画帧的完整性验证或恶意内容扫描。合法 `.jpeg`、`.JPG` 等原后缀可保留；其他文件格式不因此获得新增的图片识别能力。
- 没有原名的 IM 图片使用 `微信图片_20261029_a83f102b.png`／`飞书图片_20261029_a83f102b.png`：日期取接收时间的 UTC 日期，短 ID 取稳定操作身份，不使用平台密钥。缺少原名的 Web 图片使用 `图片_日期_短ID.ext`。IM 同一收件记录的附件重试／重启复用已完成的快照，不重复下载或创建 blob。
- `study_upload_file` 为已有工作区文件登记可发送的快照，不改原文件名或位置；快照的展示名后缀会按实际图片格式校正。随后 `study_send_file` 发送附件，不在 Bot 顶层再复制一份。只保存文件不等于已发送给用户。内部快照仍用 `fileId`／UUID `.bin` 存储，用户改名不改变历史附件的 ID。

### Bot 生成文件的安全保存

新沙盒镜像内置 `wangke-save`。Bot 应在同一条 shell 命令里先生成临时文件，再保存到有意义的任务目录，而不是反复写 `output.png`：

```sh
# 在同一条 shell 调用中，先由 Python 等生成 /tmp/plot.png，再执行：
wangke-save /tmp/plot.png '函数分析/正弦函数对比.png'
```

返回 JSON 的 `path` 是实际保存路径，应传给 `study_upload_file`。工具支持 20 MiB 以内的普通文件，创建缺失子目录，拒绝越界路径、目录软链接和非普通输入；支持的光栅图片按文件签名校正后缀，登记时再由 API 校验图片元数据。原始临时输入不删除。`/tmp` 不跨命令保留。

- 默认原子防覆盖：不同内容遇到同名生成 `(2)`、`(3)`；`--on-conflict error` 则报错。同名／编号路径中已存在完全相同内容时复用，`reused=true`，包括并发发布。
- 相同内容复用只限指定目标名称及其编号，不是全库去重；非确定性重新生成的不同内容会另存，不能因此声称任意任务都恰好执行一次。中断后应先检查已有产物，不盲目重新生成。
- 明确修改已有文件时才允许走更新流程；此工具不提供隐式覆盖参数。任意 Python 直接 `open(..., 'w')` 仍能覆盖，它不是沙盒写入的强制安全边界。旧镜像没有该工具时，Bot 应退回独占创建，而不是先检查存在再普通写入。
- 生效需要发布 API 并从仓库根目录构建新沙盒镜像；只更新 broker 或只修改提示词不会把 `wangke-save` 装进旧镜像。

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

- 用户只能管理自己拥有的项目；BOT 每次文件/命令调用重新校验项目归属、归档状态及当前策略。
- 项目会话的 `project_id` 创建后不可迁移，但 Bot 可显式访问同一用户的其他项目；shell 和二进制文件读取可用准确 projectId 选择挂载到 `/workspace` 的项目。
- 用户自己的资源项目不再依赖逐项目 grant；读写/管理授权仍受全局 read/write/remove/shell 策略及项目 shell/network 策略约束，归档项目只读。审批绑定持久化工具参数，执行前再次校验权限。
- 项目会话不继承全局 MCP 连接器，也不能通过项目管理工具越出当前用户。Bot 可列出并按明确 ID 访问用户自己的全部项目，重命名仍需要管理授权。
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
PATCH          /resources/folders/color         { projectId, path, color }
POST           /resources/move                  { projectId, path, targetProjectId, target, revision }
GET            /resources/courses/:id            支持 Range
POST           /resources/courses/:id/text       { text, expected }
```

文本写入参数为 `{ text, expectedRevision }`：创建传 `null`，覆盖传上次读取返回的 revision，冲突返回 409。项目 PATCH 允许 `name`、`instructions`、`policy`、`archived`，不接受 ID/路径修改。

资源目录项的文件夹带 `folderId`、可选 `color`；创建文件夹响应也返回 `folderId`，供聊天关联同一个资源实体。

阅读器 Markdown 保存传完整原文快照 `expected` 做比较后写入；并发 Bot／页面修改返回 409，不覆盖新内容，编辑器保留草稿。目录／文件移动沿用 revision 校验、同名保护、路径安全和运行任务互斥。HTML 等课程原文件按附件返回，不能当作应用页面执行。

## 旧数据与备份

迁移 14 增加项目、BOT 授权、执行租约，以及会话的项目/BOT 归属与归档字段。已有 BOT 会话保留原记录/历史，根据原参与者补入主要 BOT。迁移 21 增加 `bot_workspaces`，普通 Bot 的后续运行使用专用资源目录；原独立会话的 `wangke-workspace-<thread-id>` volume 保留，旧 volume 内尚未导出的文件需要另行取回。已有附件归档回执保留原位置，改名／删除过的历史附件不会重新导入。会话的原始 `project_id` 和历史不改写。

资源迁移按用户惰性执行，首次访问资源时将旧虚拟文件夹按层级转换为真实目录，旧课程文件复制一次。原 blob 保留为非活动备份，不使用硬链接；之后界面和 Bot 都读取目录内文件，删除不会从备份自动复活。旧课程 ID、原有工作区目录、会话和授权不变。迁移后仍兼容旧资料夹名称／层级与课程名称／位置更新，并落实为真实目录／文件移动；顶层权限范围不可嵌套。迁移、重命名或移动遇到文件冲突会报错，不覆盖其他内容。实际部署前应先备份，当前测试仅使用隔离临时账户数据。

服务端解析／封面任务同样读取真实文件，并固定文件描述符传给子进程，不会重新打开可被替换的工作区路径。旧 worker 的 Markdown 写入同步到真实文件后清除活动 blob 引用；旧“删除源文件”操作按最近文件 revision 删除磁盘文件，遇到并发修改报冲突。删除请求只消费一次，不影响 Bot 之后重新创建的同名文件。

应用备份包含 `files/projects` 中的常规文件。现有备份脚本拒绝符号链接，恢复拒绝嵌套压缩包；有 venv/node_modules 等内容时应使用能正确保留这些文件类型的独立文件系统备份。备份前停止 API 和 broker。旧独立会话的 Docker volumes 仍需单独备份。

验证命令及 Docker 挂载环境变量见 [运行时部署](agent-runtime.md)。

资源专项验证：`npm run test:resources`、`npm run test:resources:e2e`。后者覆盖桌面／手机、真实 mkdir／上传／课程导入、机器直接创建文件、Markdown 阅读／保存／索引／并发保护、返回原目录、B 站入口及旧链接。截图保存在 `test-results/resource-folders`。

Bot 全资源访问回归：`npx tsx scripts/test-bot-resource-access.mjs`（也包含在 `npm run test:bot`），覆盖无逐项目授权、项目会话跨目录、嵌套文本／二进制文件、system 指令／笔记／技能／MCP／旧记忆免审批读写、删除强制审批、只读／可写挂载参数、归档只读、账户隔离、拒绝／重启／并发冲突／撤权及目标项目审批恢复。`npx tsx scripts/test-bot-services.mjs` 另覆盖后台记忆自动保存、来源／权限／取消检查及原子回滚；真实 Docker 挂载另用 `npm run test:sandbox` 验证。

聊天项目验证：`npm run test:chat-projects`、`npm run test:chat-projects:e2e`，覆盖本地／服务端创建、会话归属、发送后收起、子目录检索及桌面／手机文件夹颜色。截图在 `test-results/chat-projects`。

兼容边缘验证：`npx tsx scripts/test-resource-compat.mjs`，覆盖原生解析／封面、固定描述符与符号链接替换、worker 写回、旧删除／并发保护／文件重建、移动索引预检及视频扩展名。
