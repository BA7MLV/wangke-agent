# 实时链路（多设备实时镜像）设计

日期：2026-10-09
状态：已实现（P1 骨架：链路 / 只读镜像 / MSE 播放）。写回（P2）与硬化（P3）未做，见 §3.7 分期（与用户逐节确认过：三段角色 → 写回模型 → 播放格式 → 边界与失败 → 隐私）

## 背景与目标

应用是 local-first、零后端：视频在 OPFS，业务数据在 IndexedDB，设置在 localStorage。**所有数据锁在宿主机浏览器里**，链接本身不携带任何数据。当前的跨设备手段只有手动迁移包（导出/导入文件），换设备要记得导、改完要记得再导。云同步（`2026-09-23-cloud-sync-design.md`）设计了一份「自建 Worker + 副本」的方案，但那份是**周期性对齐 + 不含视频 + 非实时**，且至今未实现。

用户的真实场景：**生成一个链接，其他设备（iPad / 手机 / 户外网络）打开就能实时看到并操作我这台 Mac 上的内容**——包括播放视频，且不想在自己机器上常驻任何服务进程。

**目标**：host（Mac 浏览器）→ 全托管中继（Cloudflare Worker + Durable Object）→ guest（任意浏览器）三段实时管道：

- guest 按需读取 host 的课程元数据、字幕、讲义、统计；视频按字节段流经 MSE 播放；
- guest 的交互（提问记录、制卡审核、播放进度、学习时长）作为窄 op **写回 host 落库**，host 是唯一权威；
- 链接形如 `https://<静态托管>/?relay=wss://<worker>&pair=码`，host 侧一键复制；host 之外没有任何需要常驻运行的东西。

**非目标（明确不做）**：

- **不做账号体系**。单用户自用，配对码即令牌。
- **不做云副本 / 离线可看**。host 下线即链路断，guest 视角明确「主机已离线」。要副本是云同步那份设计的范围，两者不合并（见不变量 8）。
- **不做非直连容器重封装**。mkv / flv / ts / rmvb 等来宾端明确播不了，提示回主机或本地看。mediabunny 重封装（B 站导入已有类似能力）列为后续可选，本期不做。
- **不做 WebRTC P2P**（见 §3.2 取舍）。
- **不做 guest 侧视频落库**。只看不存；镜像数据只进内存，关页面即焚。
- **不做「借 host 的 Key」**。guest 问答用 guest 自己设置里的 API Key。

## 不变量

1. **凭据永不过管道。** `providers[].apiKey`、`bilibiliCookie` 不可能出现在任何链路消息里——host 侧不过滤「正好没有」，而是从构造上只允许白名单字段出库（沿用 `sync/units.ts` 的 `NON_SYNC_SETTINGS_KEYS` 精神）。guest 没有 Key 时明确提示去本机设置填，不存在代调用路径。
2. **host 是唯一权威，写操作串行落库。** 所有写 op 在 host 侧单队列串行应用；每条 op 携带 `clientOpId`，重复到达直接回 ack 不重放——网络抖动下「问了一次」不会变成「问了两次」。
3. **中继不解析、不存任何业务数据。** Worker + DO 只做「按配对码配对两个 WebSocket 并转发帧」，DO 房间空闲即回收。与 `bili-proxy.js` 同一条设计原则。
4. **断链不丢写。** guest 侧未 ack 的 op 进本地 outbox（localStorage），重连后按序补发，host 按 `clientOpId` 去重。
5. **隐私常驻可见。** host 只要有活跃会话，应用内常驻醒目指示条（「正在共享给 N 台设备 · 一键停止」）。藏在设置页二级里等于没有——本地优先工具的用户对无感知共享零容忍。
6. **协议带版本号。** `hello` 带 protocol 版本，不匹配时明确拒绝并提示两侧版本，不猜、不静默降级。
7. **host 消失必须被显式感知。** host 主动停止 / 断网 / 刷新 / 页面被杀，guest 分别呈现「已断开 / 重连中 / 主机已离线」三态；宽限期（60s）内 host 回来则自动重连补发，用户不用手动操作（会闪一下重连提示，不是无感）。禁止 guest 用陈旧镜像假装在线。
8. **实时链路与云同步不互相寄生。** 实时链路只复用 `sync/units.ts` 的**单元 id 构造函数**与 `PART_BYTES` 分片常量（同一份数据两种切法必然漂移）；云同步的 pack/unpack 引擎、D1/R2 存储分层一律不碰。两份设计各自独立成立，谁先实现都不牵连对方。
9. **镜像数据不落 guest 库。** guest 拉到的课程 / 字幕 / 讲义只在内存。落库会产生「iPad 上出现半个课程库、与 Mac 数据静默分叉」的脏状态，且它会让用户误以为 guest 是独立副本——那正是云同步的场景，不是本功能的。

## 设计

### 3.1 三角色

| 角色 | 是什么 | 职责 |
|---|---|---|
| host | Mac 上的应用页面（设置页开「实时链路」） | 连上中继 WSS；生成/展示配对码与活跃会话；按需发货：索引、单元载荷、视频字节段；串行应用 guest 写 op 并回 ack |
| relay | Cloudflare Worker + Durable Object | 按配对码把 host 与 guest 接进同一「房间」；双向转发帧；错误配对限速；房间空闲 10 分钟回收 |
| guest | 任意设备浏览器打开链接 | 输入配对码 → 镜像态：课程库 / 字幕 / 讲义 / 统计按需拉取，视频走 MSE 播放；写 op 进 outbox 等 ack |

数据流上，**host 页面本身就是服务器**：读路径全部来自本机 IndexedDB / OPFS，不经过任何第三方存储。

### 3.2 部署形态与取舍

**为什么是全托管中继（Worker + DO）而不是本机常驻中继**：用户明确要求外网可访问且不愿在 Mac 上常驻进程。浏览器开不了监听端口，「浏览器当中继」严格不存在；任何方案里公网都必须有一个可达端点，区别只在于是自己常驻还是托管。DO 方案下用户侧唯一的「服务」就是一次性部署一个 worker——但注意 **DO 不能纯 dashboard 粘贴部署**（需要 binding 与 class 迁移），所以用 wrangler 一条命令：

```bash
cd cloudflare-worker/live-relay && npx wrangler deploy
```

成本如实记：比 bili-proxy 的粘贴重一档；换来的是 Mac 上零常驻、链接随时在线。

**为什么不用 WebRTC P2P**：外网 NAT 穿透失败率不低，失败就要 TURN 中继——又回到一台有带宽成本的服务器；且 DataChannel 喂 MSE 比分片 WSS 更绕。评估后放弃，不留接口。

**带宽与成本口径（写进文档而非留在嘴边）**：Cloudflare 不对 Worker 流量收带宽费；DO 按「请求数 + 房间活跃时长」计费，看视频是小时级会话，免费额度和计费口径在实现前按当时的价目表核对并补录。**真正的硬约束是 host 家的上行带宽**：1080p（B 站导入常见 2–6Mbps）可看；4K/高码率会卡——这是物理上限，guest 播放页要显示实时码率与余量，卡了明说，不假装。

### 3.3 协议（四类消息，一个 WSS 双向通道）

帧格式：`{ v: 协议版本, t: 类型, id: 消息 id, ... }`，文本帧为 JSON，视频数据为二进制帧。`src/livelink/protocol.ts` 定义类型与纯函数校验，**坏帧跳过不炸房间**（远端数据不完全可信，一条畸形帧不该杀死整条链路）。

**控制面**：`hello`（配对码 + 版本）、`welcome`（host 昵称）、`bye`（host 主动踢人）、`host-stopped`。配对失败不计入业务。

**读面**（按需拉，不全量推）：

1. guest 连上后先拉**索引**：课程清单 + 每门课的单元清单（`video:<id>:meta`、`:content`、`:cover`）与各单元 gzip 后字节数。单元 id 直接复用 `sync/units.ts` 的 `videoUnit()`——同一门课两套 id 是漂移源；
2. 打开课程 → 拉 `meta` + `cover`；看字幕 / 讲义 → 拉 `content`（IR 与字幕在其中，讲义插图 `frames` 本期不拉，讲义 IR 内引用处显示占位）；
3. 载荷超过 `PART_BYTES`（256KB，gzip 后）自动分片，分片常量同样直接用现成的。

**写面**（窄 op 集合，host 权威）：

| op | 作用 |
|---|---|
| `chat.append` | 追加一条问答消息到会话 |
| `card.decide` | 制卡候选保留 / 丢弃 |
| `position.set` | 更新课程播放进度 |
| `study.add` | 记一个学习日（分钟数） |

每条 op 带 `clientOpId`（guest 侧 uuid）。host 串行 apply 后回 `ack(clientOpId, host行id)`；重复 `clientOpId` 直接重放 ack。op 语义与参数校验在 `src/livelink/ops.ts`，**host 侧 apply 与本地写库走同一个函数**——否则「guest 写一条和本地写一条」会走出两种行为。

**视频面**（二进制，独立流控）：

- `openFile(videoId)` → host 经 `getCourseFile()` 拿 `File`（OPFS 的 `File.slice()` 天然支持随机读，存储层零改动）回报 `{ size, mime }`；
- `readRange(start, len)` → host 回二进制分片（约 1MB/帧，防背压）；
- guest 维护**在途窗口约 8MB**，ack 一片要一片；seek = 新的 `readRange`；
- `closeFile(videoId)` 释放句柄引用。
- **容器白名单**：MSE 直连容器（mp4 / webm，H.264/AAC 或 VP9/Opus 码）走流式播放；其余容器 `openFile` 阶段直接拒绝，guest 明确提示「该格式来宾端无法播放」。拒绝发生在打开时而不是播放中途，是取舍：中途失败会留下一个看似在播放其实黑屏的怪状态。

### 3.4 guest 侧实现要点

- 路由 `/#/live`（App 路由表现有 `/#/settings` 同款）。镜像态**只进内存**（不变量 9）；outbox 持久化在 localStorage。
- **不做播放器全量复刻**。guest 是一个轻量镜像页：课程列表 → 课程详情（字幕列表可点跳转、讲义阅读、问答面板）+ 自建 MSE 播放条。复用 `Player` 的全部能力（影院模式、弹幕层、双击手势……）意味着要把本地 store 抽象成 source 接口，那是这个功能最大的工作量风险，YAGNI。
- 问答链路：检索用从 host 拉到的字幕块在 guest 本地跑（BM25 是现成的），LLM 调用走 guest 自己的 Key；会话以 `chat.append` op 写回 host。
- 断线三态UI：重连中 / 主机已离线 / 已断开，outbox 待补发数量可见。

### 3.5 host 侧实现要点

- 设置页「实时链路」卡片：配对码（8 位随机，可一键轮换——轮换即断所有旧连接）、当前活跃 guest 列表、「停止共享」开关。
- `src/livelink/host.ts`：WS 客户端 + 房间协议 + 索引生成 + 单元读取（Dexie → 载荷）+ OPFS range 服务 + op 串行队列。
- 常驻指示条 `src/components/LiveShareBar.tsx`：任意页面只要有活跃会话就显示（不变量 5）。

### 3.6 安全模型（够用就好）

- 配对码即令牌：8 位随机；host 可轮换；链接不带码时 guest 手动输入。
- 房间级限速：同一房间连续 5 次错误配对锁定 5 分钟（DO 内计数）。
- 全链路 WSS/HTTPS；DO 房间空闲 10 分钟回收，host 断链宽限 60 秒后回收。
- 不做的：过期链接、设备指纹、审计日志——单用户场景是噪音。

### 3.7 分期

- **P1 链路骨架**：worker + DO、host 卡片与指示条、guest 镜像页（课程列表 + meta/content/cover 拉取 + mp4 播放）、Node 桩中继的 e2e。验收：同 Wi-Fi + 外网 4G/5G 各播通一部 1080p 课程。
- **P2 交互**：op 写回（chat.append / card.decide / position.set / study.add）、outbox 补发、host 侧 apply 复用本地写库函数。
- **P3 硬化**：带宽/码率可见性、多 guest 同看的带宽分摊提示、容器白名单外的明确拒绝文案、真实 DO 长时间会话稳定性记录。

## 涉及文件

新增：

- `cloudflare-worker/live-relay/`（`wrangler.toml` + `src/index.ts`）：Worker + DO 房间（WebSocket Hibernation API：长连接 + 空闲低耗 + 断线事件由平台派发，不用自己维护心跳表）
- `src/livelink/protocol.ts`：帧类型 + 校验纯函数（Node 可单测）
- `src/livelink/ops.ts`：op 定义、参数校验、host 侧 apply（复用本地写库函数）
- `src/livelink/outbox.ts`：暂存 / 补发 / 去重纯函数（Node 可单测）
- `src/livelink/host.ts`：host 客户端（索引、读库、OPFS range、op 串行队列）
- `src/livelink/guest.ts`：guest 客户端（索引缓存、按需拉取、outbox 驱动）
- `src/livelink/mse.ts`：guest 侧 MSE 管道（append 分片、seek→readRange、窗口流控）
- `src/pages/LiveGuest.tsx`：guest 镜像页（`/#/live`）
- `src/components/LiveShareBar.tsx`：host 常驻共享指示条
- `scripts/test-livelink-protocol.mjs`、`scripts/test-livelink-outbox.mjs`、`scripts/test-livelink-ops.mjs`：Node 单测
- `scripts/e2e-livelink.mjs`：双 browser context（一个 host 一个 guest）+ Node WS 桩中继跑真实链路
- `docs/plans/2026-10-09-live-link-design.md`：本文档

改动：

- `src/App.tsx`：`/#/live` 路由
- `src/pages/Settings.tsx`：「实时链路」卡片（复用 `SectionCard` / `Field` 既有模式）
- `src/store/fileStore.ts`：加一个 `readCourseFileRange()` 小工具（`getCourseFile().then(f => f.slice(a, b))`，存储层其余不动）
- `scripts/e2e-all.mjs`：登记 `e2e-livelink` 的 META（漏登记的后果是一键跑分永远不执行它）
- `cloudflare-worker/README.md`：补 live-relay 部署章节

## 验证

- **单测**（纯 Node）：protocol 坏帧 / 版本不匹配 / 二进制帧边界；outbox 的重复 clientOpId 去重、重连按序补发、与 host ack 的交互；op 参数校验（越界时间戳、空消息体、未知 op 类型）。这些是分支逻辑，不依赖浏览器。
- **e2e**（`e2e-livelink.mjs`，dev 5173）：Playwright 起两个 context 模拟 host / guest，中间挂一个 Node WS 桩中继（不依赖真实 DO 部署——CI 无 Cloudflare 凭据）。断言：配对成功 → 索引一致 → 按需拉单元内容与库内一致 → openFile/readRange 拼出的字节与 host 文件字节相等（fixture 视频前 N 片）→ op 写回后 host 库内可见 → 杀中继后 guest 进入重连态、host 回来后 op 补发且不重复。
- **手动验收**（P1/P3 边界，脚本替不了）：真实 `wrangler deploy` 后 iPad 走 4G/5G 打开链接播放 1080p；记录实际上行带宽占用与 DO 活跃时长计费口径，补回 §3.2。

## 验证记录

2026-10-10 实测（P1 落地后回填）：

| 层 | 结果 |
|---|---|
| `test-livelink-protocol`（Node 单测） | **19 断言全过**。黄金字节线格式（rid u32 LE + seq f64 LE + payload）、坏 gzip 抛异常两条硬契约在列 |
| `test-livelink-window`（Node 单测） | **全过**：7 组硬断言 + pos 锚定断言 + 补充边界（seek 越界钳制 / 非正 size / 在途占满不新规划 / 尾部钳制） |
| `test-livelink-index`（Node 单测） | **全过**：4 组硬断言 + 补充边界（fileDeleted 双态、meta 不发 coverState、cover 单元可逆、空 content 合法） |
| `e2e-livelink`（dev 档 + Node 桩中继，双 browser context） | **全过**：配对 → 索引 → 单元（字幕 + 对照轨）→ range 载荷与 host 文件逐字节一致 → webm 真解码（buffered + currentTime 推进）→ host 停机 guest 立刻离线。ffmpeg 在场 **27 项断言全过**；`E2E_FFMPEG=''` 实测降级路径：真解码步跳过并打印原因、退出码仍 0（不当成全量通过） |
| 真实 DO 部署 + iPad 外网播放 | **P3 手动验收项**（脚本替不了）：同 Wi-Fi 与外网 4G/5G 各播通一部 1080p 课程；记录实际上行带宽占用与 DO 活跃时长计费口径，补回 §3.2 |

## 变更记录

- 2026-10-09 首版。
- 2026-10-10 P1 落地（9 个 Task，commit `2e83119`–`302fe09`，逐个 Task 的 commit 与计划出入见同目录实现计划「执行结果」）。相对首版设计的实际差异，留给下一个人：
  1. **guest 详情只镜像了字幕 / 对照轨 / 封面 / 视频**：§3.4 写的「讲义阅读、问答面板」未进 P1（content 单元只发字幕与对照轨；问答写回属 P2）；
  2. **「链接不带码时 guest 手动输入」未做**：P1 的 need-code 态只提示向主机索取带配对码的完整链接；
  3. **窗口锚点**被实测推翻：不能锚「连续覆盖末端」（追着末端跑、无界），也不能锚「文件头」（首窗填满后停摆），必须锚播放头；
  4. **MSE codec 识别**被实测推翻：容器级 type 不够（Chrome 上 `addSourceBuffer('video/mp4')` 直接抛 NotSupportedError），须带 codecs 参数 + 候选序 + append 失败重试。
- 被推翻的假设（留在文档里，防止下一个人重新踩）：
  1. **「WebRTC P2P 更省」**——外网 NAT 穿透失败仍需 TURN 服务器，且 DataChannel + MSE 更复杂。放弃。
  2. **「本机常驻中继 + 局域网链接」**——用户要外网访问且不愿常驻进程。放弃，仅留作开发期联调手段。
  3. **「guest 本地自治写」**——两机数据分叉，Mac 上看不到 iPad 上的操作记录。改为 host 权威 + outbox。
  4. **最初判断「视频过不去」**——修正为：range 读 + WSS 管道 + MSE 可行，但仅限直连容器，且硬约束是 host 上行带宽。
  5. **「直接复用云同步的 pack/unpack 引擎」**——边界改为只复用 `sync/units.ts` 的单元 id 与分片常量；云同步未实现，实时链路不等待它。
