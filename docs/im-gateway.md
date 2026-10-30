# IM Gateway 与个人学习 Bot

## 范围与验收状态

Gateway 在现有 Fastify 5 / SQLite 服务内运行，**只部署一个 API 实例**。支持飞书企业自建应用长连接、腾讯官方微信 ClawBot / iLink 协议；只处理已绑定本人的人类私聊，忽略群聊和机器人消息。**一台服务器可连接多个不同的平台 Bot 账号**，每个渠道各自保留连接、游标、去重空间、本人绑定和 Bot 线程，共享该用户的学习库；可选择相同或不同的 Bot profile。管理页「打开对话」在首页 Bot 面板中查看、发言、审批、停止和接管。

协议模拟、真实文件解析/生成和管理页浏览器测试已通过。2026-10-28 已用线上微信账号做单次只读协议诊断，确认真实 19 位消息 ID 触发旧版解析错误；对应修复和可靠性回归见 [iLink 加固记录](ilink-reliability.md)。后续只读检查时一个微信渠道已 `connected` 并处理了 5 条入站记录，但没有本人绑定；另一个渠道为 `login_required`。这解释了“已连接却不能使用”的当前现象。**本轮就绪状态、多账号防重及移除渠道改动尚未部署，真实微信/飞书双向收发仍待验收**。二维码模拟测试不代表微信登录成功，模型模拟测试不代表真实模型质量。

## 部署

沿用 [部署文档](deployment.md) 和现有 `Dockerfile` / `compose.yaml`，无需另起 OpenClaw 或开放 IM webhook 端口：

```bash
docker compose up -d --build
```

容器基于 Node 22，保留 Chromium 和 FFmpeg。主机直跑时：

```bash
npm ci
npm run build
npx playwright install --with-deps chromium
npm start
```

还需主机安装 FFmpeg。不要为了 Gateway 删除原有浏览器执行器：PDF 材料索引、视频讲义等现有流程仍可能使用 Chromium；文字来源 Bot 讲义、已索引正文制卡可走 Node。`CLOUD_BROWSER_DISABLED=1` 会关闭需要浏览器的任务，不能当作完整学习功能部署。

- 设置正确的 `PUBLIC_ORIGIN` 和 HTTPS；首次初始化、登录及模型配置见现有部署说明。
- 服务器须能出站访问飞书 HTTPS/WebSocket、腾讯 iLink API/CDN 及配置的模型服务。长连接无需公网回调地址。
- 持久化整个 `/data`：数据库 `/data/db/wangke.sqlite`、文件 `/data/files`、密钥 `/data/config/credentials.key`。主机对应 `DATA_DIR` / `DB_PATH` / `FILES_DIR`。
- 备份数据库时使用 SQLite 在线备份或停服后一致性快照，不能仅复制正在使用的主数据库文件而遗漏 WAL。备份同时保存文件和密钥；密钥丢失无法解密账号、上下文及模型凭据。密钥权限应为 0600，备份按敏感数据保护。
- 启动自动迁移数据库（Gateway 队列为 migration 13，投影故障隔离为 migration 14）；升级前备份，勿让旧版服务读写已迁移数据库。
- 调度器是单实例实现，不要复制多个容器共享同一数据库。定期监控队列和数据库/文件增长；目前不自动清除投递审计及加密 inbox。
- 沙盒 shell 仍须按 [Agent runtime](agent-runtime.md) 配置，不会因启用 IM 自动获得主机、Docker socket 或凭据访问权限。

## 先配置学习 Bot

1. 初始化并登录 Web，配置聊天模型；理解图片还需单独配置 **vision 模型槽位**，支持 OpenAI Chat、Responses、Anthropic Messages。
2. 创建并启用 Bot profile，设置其学习用途；将课程正文/字幕或材料同步到服务端学习库。
3. 在云设置的 IM Gateway 管理区新增渠道，选择 Bot 和权限预设，保存并启用。
4. 生成十分钟有效的一次性配对命令，在本人私聊中原样发送 `/pair <code>`；不要把命令转发给其他人。先扫码登录微信不等于完成学习库身份绑定。
5. 每账号只允许一个有效本人会话。重绑前撤销原绑定，再生成新命令。撤销原子废除该账号所有未消费配对码和待处理配对事件，旧配对码不能恢复授权。重绑旧线程时使用账号当前选择的 Bot，而非已撤销时的旧参与者。

### 就绪状态、多账号与移除

- 列表显示「待登录」「等待连接」「已连接 · 待绑定」「Bot 未启用」「待配置模型」「需要处理」「配置完成」，而不是将平台 `connected` 当作全链路可用。详情展示连接、绑定、Bot、模型四项准备，失败任务/入站/投影/投递及最近收到消息的时间。模型检查只验证配置关联与 chat 能力，不会发付费测试请求；真实可用性以回复为准。
- 绑定是登录后的独立步骤。管理页生成可复制、十分钟有效、可重新生成的 `/pair XXXXXXXX`，发送到该机器人的私聊，成功后界面自动更新。未绑定普通消息不创建任务、不自动补执行；绑定后重新发送问题。可先发送 `/status` 验证往返。
- 不同微信 Bot ID、不同飞书 App ID 可在同一服务器并行工作。同一平台身份在整个服务（含其他 owner、已停用记录）只允许添加一次；iLink 也检查相同 token。保存和扫码确认返回 `duplicate_channel_account`，启动时发现历史重复记录则阻止竞争消费者。移除重复项后对保留项立即重连。此防重范围是单个服务数据库，无法检测另一台独立服务是否消费同一平台账号。
- 详情底部「移除消息渠道」经确认调用 `DELETE /api/v1/gateway/accounts/:id`，校验登录、Origin 与归属。事务停止该渠道线程的运行及子任务、取消活跃提醒，并级联清除加密凭据、配对码、绑定、inbox/outbox 和投影失败记录；连接、下载、发送、扫码轮询随即取消。迟到回调不能复活账号。
- 移除保留网页线程、消息、学习资料及文件，不撤回平台已接受的消息；以后可重新添加并重新扫码/绑定。与「停用」（保留凭据和队列）、「解除绑定」（保留渠道登录）分别对应不同操作。

### 权限

- `inherit`：继承现有 owner / Bot 策略及长期信任。
- `autonomous`：仅将 `read`、`write`、`shell` 的 `ask` 升为 `allow`；**显式 `deny` 永远保留**。删除 `remove` 不提升，网络开关独立，不随渠道自动开放。
- 学习数据、文件、任务、审批均检查 owner；Bot 不暴露账号配置、密钥或宿主机管理工具。
- 新建学习子任务绑定具体 run/step；执行及提交重新检查策略，批准后改为 deny 不能继续提交。
- 更换 Bot、降级预设或停用会停止该账号相关运行；撤销还会取消其提醒和未发投递。`/stop` 也会取消已完成父 run 留下的活跃子任务。云任务的网络取消由调度器检测，通常约一秒内，不保证远端已接受操作能撤回。
- 高自治意味着被模型采纳的不可信附件指令可能导致允许范围内的写入。仅绑定本人；按需要收紧写入、删除、shell、网络策略并保留审计。

## 飞书配置

1. 在飞书开放平台创建**企业自建应用**，启用机器人能力；本实现使用飞书中国站，不是 Lark 国际站。
2. 事件接收方式选长连接，订阅 `im.message.receive_v1`。
3. 至少申请私聊读取 `im:message.p2p_msg:readonly`、机器人发送 `im:message:send_as_bot`；图片/文件还需开放平台当前要求的消息资源读取及上传权限（如 `im:resource`）。以控制台对应接口所列权限为准，勿用群聊权限代替私聊授权。
4. 发布应用版本、完成企业管理员审批，确认本人在应用可用范围内，并能打开机器人私聊。
5. 在 Gateway 填入 App ID（`cli_...`）和 App Secret，保存启用；服务端加密存储，列表不回显凭据。修改时空值不是“自动清除所有凭据”的通用约定，不要把脱敏标记当真实密钥提交。
6. 查看连接状态，发送配对命令，再做下文实号验收。不要同时用另一个客户端消费同一应用事件：长连接可能采用集群分发而非广播。

官方 SDK 负责 WebSocket 重连；接收回调只做同步 SQLite 落盘，不等待模型或媒体下载。去重采用 `message_id`，不是 `event_id`。REST 发信采用稳定 `uuid`，只在平台约一小时的去重窗口内认为未知结果可安全重试，不承诺跨窗口 exactly-once。

## 微信 iLink 配置

协议参考腾讯官方 `Tencent/openclaw-weixin` v2.4.10、快照 `874637a0dbc24050f72d1385add4fc6170a2d726`，独立实现，未加载 OpenClaw。微信 ClawBot/iLink 的出站文本支持 Markdown 展示（包括 fenced code block）；腾讯插件的 `StreamingMarkdownFilter` 也会保留和过滤这类结构。本实现因此原样保留 Markdown 文本，不把普通 Markdown 或代码块默认转图片；仍按渠道上限做结构安全分片。LaTeX 数学公式不等同于 Markdown 能力，暂不宣称由微信原生排版。

1. 新增微信 iLink 账号并保存，在管理页获取二维码，用有资格的本人微信扫码。
2. 保持轮询；等待、已扫码、确认、过期、验证码、官方重定向按平台状态处理。验证码须点击提交，每次只发送一次；错误后等待重新输入，`verify_code_blocked` 停止该轮并允许稍后刷新，`binded_redirect` 结束该轮并提示返回查看连接。验证码不写入模型上下文。过期后重新取码。
3. 确认登录后 token 加密入库并自动重启长轮询；再向 Bot 私聊发送一次性 `/pair ...`。
4. 状态 `login_required`（包括平台 `-14`、HTTP 401）表示凭据失效，该插件实例停止轮询及后续认证请求；重新扫码并确认。新的入站消息会更新该绑定的加密 `context_token`。同一 Bot 重新登录保留游标；扫码或配置切换到另一 Bot ID 会返回 `channel_identity_changed`，应为它新建渠道，避免沿用旧身份的游标和绑定。

安全限制：API 仅接受 HTTPS `ilinkai.weixin.qq.com` 或其子域；媒体仅允许 HTTPS `cdn.weixin.qq.com` 或其子域；拒绝任意主机、非标准端口、重定向携带凭据。CDN 不发送 Bot Authorization。平台若返回其他官方域名，会保守失败，须核对官方协议后明确加入，不能放开任意 URL。

微信主动发送依赖当前会话 `context_token`，平台可能有时效和账号限制；**不保证隔天提醒一定能主动送达**。缺少 context 或凭据失效可在管理页看到失败，Web 仍保留结果；先发一条新的本人消息，再确认重试。图片/文件使用腾讯 CDN AES-ECB 协议传输；不是可复用于应用密钥存储的加密方案。

## 使用与能力边界

控制命令须独占消息：

| 命令 | 行为 |
|---|---|
| `/pair <code>` | 十分钟一次性身份绑定 |
| `/stop` | 优先停止该线程，取消先前未处理入站及正在下载的媒体 |
| `/status` | 查看线程运行状态 |
| `/approve <精确审批ID>` | 仅批准当前本人、当前线程的具体待审批操作 |
| `/reject <精确审批ID>` | 拒绝具体操作 |

自然语言“同意”不作为通用审批命令；审批 ID 一次性消费，跨线程、其他 sender 和重复提交无效。Web 同样可处理关联审批。

学习工具与渠道插件独立注册：

- `study_read`：列课程、检索已同步学习数据、读字幕/材料/卡片/讲义/学习记录。数据库先限定 owner、table、courseId 和字面 query，再按 revision 游标分页，不因其他课程超过 1000 条而遗漏旧资料。单次最多 30 条、记录 envelope 合计约 12000 字符；单条 value 超过 10000 字符时只返回 key/revision/omitted/sizeChars，不能拿缺失 value 修改。跟随 `nextCursor` 并保持相同过滤条件，null 表示完成；`truncated` 表示尚有下一页或存在省略记录。不是语义搜索。
- 读写契约为 `{key,value,revision}`：仅把 **value 原样作为 study_manage.before**，key 单独传入，不把 envelope 存回学习记录。课程引用为 `#/player/<id>`；设置管理员 `PUBLIC_ORIGIN` 后返回该站点的绝对 URL，Bot 不能自行提供外部链接基址。
- `study_manage`：乐观并发更新学习记录，删除服从原有 remove 审批；不能写配置、账号或凭据。
- `study_task`：持久化制卡、文字讲义、材料索引任务，以及查询进度/结果、取消。排队不等于成功，必须查询终态。
- Bot 讲义从已索引正文/字幕生成文字来源 Markdown 和真实 DOCX，存入课程讲义及文件库；最多取 50000 个来源字符，结果注明截断，不声称分析了视频画面。原有视频/视觉讲义流程不变。没有索引内容时明确失败。
- `study_file`：真实读取本人文件。文本/Markdown/JSON/CSV、DOCX、PDF 文本解析；图片通过配置的 vision 模型理解。PDF 最多 100 页，文本最多返回 14000 字符；DOCX 正文 XML 上限 4 MiB；文件上限 20 MiB。扫描 PDF **不自动 OCR**，可改发图片给 vision 或先用现有材料流程索引。
- `study_export` / `study_send_file`：生成并下载/发送 UTF-8 文件，或发送**已进入应用文件库、归属本人的 fileId**（包括上传图片、讲义 DOCX）。Web 附件提供鉴权下载。异步文件 I/O 后、数据库提交与附件发布前均重查运行状态、精确审批和当前权限，停止/撤销/改为 deny 后不能继续发布。`send_message(kind=attachment)` 只保留历史普通文字附件；含 fileId 的真实附件必须使用 `study_send_file`，不能绕过 read 权限。
- 图片收发支持 PNG/JPEG/GIF/WebP，按实际 magic bytes 识别 MIME 而非信任飞书 octet-stream / iLink JPEG 标签；拒绝伪装成图片的无效数据。目前**没有图片生成模型，也没有沙盒文件到应用文件库的桥接**：沙盒中即使生成图片，也不能仅凭工作区路径通过 IM 导出，不承诺沙盒生成图片闭环。
- `study_reminder`：创建、列出、取消持久化一次性/周期提醒。

### 提醒时间语义

创建必须同时指定带 `Z` 或显式偏移的 ISO8601 时间和 IANA 时区，例如 `2099-01-01T09:00:00+08:00`、`Asia/Shanghai`。周期为 `intervalSeconds`（60 至 31536000），按**经过的秒数**重复，不是本地日历 cron；夏令时切换会改变当地钟面时间。停机错过的周期合并为一次，不补发通知洪水。提醒先原子写入 Web 消息，再由 outbox 投递；微信的主动发送限制仍适用。

## 运维与恢复

- 管理页显示账号健康、绑定、投递状态、失败原因、提醒取消及线程接管；`GET /api/v1/gateway` 还提供脱敏的 `inboxFailures` 和 `projectionFailures`。单条损坏事件会隔离并保留检查点，每 30 秒重试，不影响其他会话或现有队列；须从可信备份/原始 Web 记录修复损坏事件。修复后自动继续，不会静默跳过丢失消息。整个 tick 的意外异常会被捕获并显示 `runtime_failed`，不把异常正文写入日志或 API。
- `pending`：等待或退避；`sending`：已开始远端请求；`sent`：平台确认；`failed`：显式失败或重试耗尽；`uncertain`：平台可能已收到但无法确认；`cancelled`：撤销取消。
- 崩溃时 `sending` 恢复为 `uncertain`。同会话的后续消息会等待前序不确定/失败消息处理，避免倒序。飞书未知结果在有效去重窗口内可固定 UUID 自动重试，微信未知结果**不会自动重放**。
- 人工重试 `uncertain` 必须确认重复风险；它只重投结果，绝不重新执行学习任务。先检查远端是否已收到。旧飞书 UUID 超出平台窗口同样可能重复。
- 无法重发或不再需要的 `pending` / `failed` / `uncertain` 可在管理页选择**放弃投递**，或本人调用 `POST /api/v1/gateway/deliveries/:id/discard`，标记 `cancelled` 并放行后续消息。它不撤回平台可能已收到的消息，未知投递可能早已送达；Web 结果仍保留。`sending` / `sent` 不允许放弃，以免与在途请求竞态。
- `rate_limited`：iLink 解析 Retry-After 的秒数和 HTTP 日期，轮询按其等待下限与带随机抖动的指数退避重试（普通退避上限 60 秒）；异常 Retry-After 使用有限默认值。长文本按渠道限制做 Markdown-aware 分片：优先段落、换行、句子和空白边界，保护代码围栏、公式、链接等结构；iLink 的单片上限为 1500 个 Unicode 码点。媒体上限保守设为 20 MiB，真实平台可能更低；文件名/格式/权限也可能导致拒绝。
- 入站批次和 iLink 游标同事务提交；消息去重、Bot client nonce、outbox/checkpoint 保证本地不会因重放重复创建 run。网络投递仍受平台契约限制，不声称端到端 exactly-once。
- 停用取消连接及在途 I/O，保留历史和未发送队列供重新启用；撤销绑定取消其待发队列和提醒。在途远端操作已被接受时无法撤回，标为不确定。停服保留数据以便恢复。
- `connection_failed` / `reconnecting`：管理页和 `GET /api/v1/gateway` 的账号 `connection` 显示错误分类、HTTP/平台数字错误码、连续失败次数、下次重试和最近成功同步时间。诊断仅存当前进程内存，重启后重新观测；`gateway_connection` 结构化日志在错误改变及第 1/2/4/8… 次失败时输出，保留诊断又避免日志洪泛。字段严格白名单，不包含平台 errmsg、异常正文、凭据、二维码、游标或消息内容。插件启动失败释放旧实例，30 秒后可自动重试；详情页「立即重连」或重新保存可立即重启。永久 HTTP 4xx（429/408 除外）停止自动轮询，修正配置后重连；`login_required` 须扫码。
- iLink 的 `message_id`、`msg_id`、`svr_id` 在转为 JavaScript Number **之前**由 `lossless-json` 保存为精确字符串，支持数字形式的 uint64 最大值及原始字符串 ID。普通数值字段仍是 number；不更改发送协议。已经被其他调用方解析丢精度的 Number 仍被拒绝。无效 JSON、重复键、无效消息结构、超出 4 MiB 的 API 响应不提交游标，并报告具体错误；不会静默跳过未知消息。空/缺失游标保留此前进度。
- iLink 长轮询在收到 HTTP 响应头前达到本轮期限视为正常空闲，直接开始下一轮，不将它当作重连或认证成功；收到头后的传输超时仍报错。服务器停止、重新配置及浏览器中止扫码请求会向在途请求传递取消；旧插件的迟到回调不能写入新实例的游标。
- 发送请求断网、5xx/408、响应体截断或 JSON 无法确认时仍标记 `uncertain`，不自动重复发消息；明确的不可重试 4xx 直接失败。仅 CDN 上传失败尚未开始发消息，可安全重试上传。API/CDN 请求都有截止时间，CDN 不携带 Bot 鉴权。

## 自动化与实号清单

```bash
npm run test:api
npm run test:bot
npm run test:cloud
npm run test:tasks
npm run test:gateway
npm run build
npm run test:gateway:ui
```

Gateway 测试使用独立临时数据库与模拟 transport；覆盖去重、快速 ACK、账号/租户/会话隔离、拒绝机器人/群聊、绑定/撤销、策略 deny、精确审批、子任务取消、iLink 游标回滚、outbox 重启/未知投递/429、时区提醒、文件归属、真实 DOCX 生成与 PDF/DOCX 解析、三种 vision 请求格式、QR/CDN 加解密及 `-14`。UI 测试实际启动独立服务并用浏览器检查 390/1440px 管理控件；不替代真实渠道联调。

源码审查回归在 `scripts/test-gateway-review.mjs`（由 `test:gateway` 一并运行）：未消费/待处理配对撤销、切换 Bot 后重绑、真实 Bot read→update→read→审批 remove、原始 value 与 owner/conflict、1140 条记录中过滤旧课程/游标/引用、fileId 附件权限绕过、六种异步文件 I/O 与 stop/revoke/deny 竞态、损坏投影与计时器异常/插件重启、失败/不确定队头放弃后继续发件、实际图片 MIME 与三协议 vision 请求。UI 回归另覆盖放弃投递确认和已发送消息禁止放弃。

`scripts/test-ilink.mjs` 新增 17 组协议/持久化/取消回归，包含真实故障形态的无 ret HTTP 200 + 两个相邻 19 位 ID、uint64 边界、文本保持原样、SQL 回滚/重放/重启、限流/抖动、错误脱敏、认证失效、发送未知结果及浏览器断连取消上游。`test:gateway:ui` 使用独立 API + Vite Web，覆盖诊断界面、验证码只提交一次、blocked/already-bound 终态与 390/1440px 布局。2026-10-28 本次加固的运行结果与开源参考见 [可靠性记录](ilink-reliability.md)。

本轮 `scripts/test-gateway-management.mjs` 增加六组回归：真实 SQLite 就绪状态、同服务器双 Bot 独立会话/游标/去重、跨 owner/并发保存/扫码重复账号拒绝、发送/下载/登录在途移除与历史保留、历史重复账号启动保护及 DELETE 鉴权。Node 26.3.0 与 Node 22.23.4（隔离 SQLite 原生模块）均通过；完整 Gateway、API、构建、类型及 i18n 检查通过。浏览器回归同时检查连接→绑定→模型准备、绑定码更新、重复扫码提示和移除的取消/确认操作；中英界面与确认弹窗截图输出到 `test-results/gateway-management/`。

子代理在 macOS Node 26.3.0 完成实现与回归；主代理又用 **macOS Node 22.23.4** 复验完整构建、API、Bot、cloud、学习任务、两组 Gateway 测试和 390/1440px 管理页，全部通过。Node 22 验证使用隔离安装的同版本 `better-sqlite3@12.11.1` 原生模块，避免覆盖工作目录中的 Node 26 ABI 产物；正常部署须在目标 Node 版本下运行 `npm ci`。本机 Docker 守护进程未运行且磁盘余量不足，**Linux/Docker 镜像尚未构建运行**，需目标环境补验。构建仍有现有 HeroUI CSS minify / chunk 混用警告；生产依赖 audit 与实施前 main 对照均为相同 12 项，未做无关依赖升级。

以下必须由用户提供凭据后验收，**当前全部未完成**：

- [ ] Node 22 Linux/Docker 构建、持久卷重启、Chromium/FFmpeg 及沙盒能力。
- [ ] 飞书企业应用发布、本人私聊文字/图片/文件双向收发；重复事件、断线重连和凭据失效。
- [ ] 微信真实二维码/验证码/重定向/过期/重登、文字及 CDN 媒体双向收发，核对真实官方域名。
- [ ] 微信延时/隔天提醒、context 更新及过期限制、限流和未知投递后的人工处置。
- [ ] 实号多步问答/制卡/讲义/提醒闭环，Web 接管、精确审批、停止和撤销即时性。
