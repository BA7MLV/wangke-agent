# 云端同步（多设备双向）设计

日期：2026-09-23
状态：待确认（用户已选：云端 Worker 通路、L1 + L2 同步、不含视频本体）
修订：v2 —— 按「L2 也要同步」重写；修正两处体积估算与一处遗漏

## 背景与目标

应用是 local-first：视频在 OPFS，业务数据在 IndexedDB（Dexie `wangke`，schema v12，19 张表），设置（zustand persist）在 localStorage。跨设备协作只能靠 2026-09-09 那份设计里的**手动**导出/导入迁移包 —— 换设备要记得导，改完要记得再导一次，中间任何一边的更新都会把另一边覆盖掉。

README 里已有两处把这个缺口写在了明面上：B 站导入一节说「iPad 装不了油猴，请改用本地文件导入，**或在电脑浏览器里导好再同步**」；已知限制说「数据只存在本机浏览器，清除站点数据会丢失」。

**目标**：自建一个单用户云端中转，让 Mac / iPad 在打开应用时自动对齐。范围是**文本内容 + 派生数据**（向量索引、讲义抽帧、封面），即用户口中的 L1 + L2。

**非目标（明确不做）**：

- **不做账号体系**。单用户自用，一个静态 token 足够。
- **不同步课程文件本体（L3）**：OPFS 里的视频 / PDF / Word，GB 级。这一条是用户明确的选择，也是本设计唯一一处「知道怎么做但不做」。
- **不做实时同步**（WebSocket / CRDT）。
- **不做端到端加密**。传输走 HTTPS，服务端自建。

## 不变量

写错就会坏掉的硬约束：

1. **凭据永不离开本机**。`apiKey` 与 `bilibiliCookie` 不进任何同步载荷 —— 用**白名单**而非黑名单列出可同步字段（黑名单意味着以后谁加个 token 字段就静默泄漏）。
2. **同步失败绝不阻塞 UI，绝不丢本地数据**。
3. **本地是权威副本**。远端数据先落库再报错；宁可少同步，不可覆盖成空。
4. **清除站点数据后，L1 + L2 可从服务端完整恢复**（含向量索引，即恢复后问答无需重新 embedding）。
5. **Worker 不解析业务载荷**。免费档 CPU 只有 10ms/请求，base64 编解码或大 JSON 反序列化会直接打爆。序列化、gzip、分片**全部在客户端完成**，Worker 只做搬运与 LWW 判定，R2 对象以流式转发。（这条来自 Workers 免费档的硬限制，见 §成本）
6. **单次请求的单元数有上限**。免费档子请求 50/请求、D1 每次调用 50 条 SQL，所以 pull 与 push 都必须分页，客户端循环直到 `hasMore: false`。
7. 既有手动迁移包**必须继续可用**，且与同步走**同一套合并函数**（见 §3.4）。

## 设计

### 3.1 数据分级与同步范围

| 级 | 内容 | 处理 | 存哪 | 量级（实测/推算） |
|---|---|---|---|---|
| L1 | `videos` 元数据、`segments`、`subtitleTracks`、**`materialBlocks`**、`handouts` 的 IR 与元数据、`chatSessions`、`chats`、`comments`、`danmakus`、`cards`、`studyDays`、`folders`、自定义 `skills`/`skillRefs`、设置白名单 | **同步** | D1 | gzip 后约 350KB/课 |
| L2 | `embeddings`、`materialEmbeddings`、`frames`、`covers` | **同步** | R2 | 约 6.4MB/课（见下） |
| L3 | OPFS 的 `videos/` 与 `materials/` 文件本体 | **不同步** | — | GB 级 |
| — | `handouts.blob`（DOCX） | **不同步**（可从 IR + frames 重建） | — | 1–5MB/课 |

> **v1 遗漏修正**：`materialBlocks` 是阅读材料的文本块，是问答检索的**输入**，不同步等于 iPad 上材料类课程问不了。它与 `videos` 共用同一 id 空间（`materialId === videos.id`），因此并入同一个内容单元，不单开单元类型。

L2 各表的量级依据（**2026-09-23 实测，非估算**）：

| 表 | 依据 | 单课量级 |
|---|---|---|
| `frames` | `extractFrames` 出 640px/q0.75 JPEG，课件类内容实测 12–40KB/帧（满屏随机噪声的理论上限 116KB，真实幻灯片到不了）；25s 间隔、只留 VL 判定为幻灯片的帧 → 约 30 帧 | **约 1.5MB** |
| `embeddings` | `段数 × 维度 × 4B`（代码不传 `dimensions`，维度由模型决定）。1 小时约 300 段；若为 4096 维则 4.9MB，1024 维则 1.2MB | **1.2–4.9MB** |
| `covers` | 480px WebP/JPEG，15–30KB | **约 25KB** |

> **修正 `2026-09-09-data-migration-design.md` 的体积估算**：该文档称「讲义帧 10–30MB」，比实测高约 10–20 倍。原因是把出 DOCX 时**临时重抽的 1600px 高清帧**（`extractFramesAt(videoBlob, usedTs, { maxWidth: 1600, quality: 0.92 })`）当成了入库数据 —— 实际上高清帧只存在于生成 DOCX 的那一瞬间，`db.frames` 里只有 640px 那一档。这个修正直接改变了 L2 同步的性价比，所以写在这里而不只是改错。

### 3.2 同步单元：为什么不按行同步

最初判断「自增主键跨设备会撞」是本设计最大的坑，所以动手前先量了引用链。结果比预期窄：

| 引用 | 指向 | 在同步范围？ |
|---|---|---|
| `chats.sessionId` | `chatSessions.id` | 是（L1） |
| `comments.parentId` | `comments.id`（同表） | 是（L1） |
| `skillRefs.skillId` | `skills.id` | 是（L1） |
| `videos.skillOverride.{pin,drop}`、`chatSessions.skillIds` | `skills.id` | 是（L1） |
| `embeddings.segmentId` | `segments.id` | 是（L2），但整表按视频打包，包内自洽 |
| `materialEmbeddings.blockId` | `materialBlocks.id` | 同上 |

**改用「以课程为同步单元整包替换」**：

- 单元 id 用 `videos.id`（uuid，**天然稳定，无需任何改造**）。
- 一个单元 = 该课程的全部 L1 子表行（材料类课程含 `materialBlocks`）。包内自增 id 只在包内自洽，接收端**整包替换**（先 `where('videoId').delete()` 再写入），重新分配主键并按映射重挂 `sessionId` / `parentId` / `segmentId` / `blockId`。
- **这套「包内 id 重挂」逻辑 `src/store/migration.ts` 已经写好，且 `scripts/test-migration.mjs` 已覆盖**。复用它，而不是新写一套。

L2 的两张向量表也走同一思路：`segmentId` / `blockId` 在包内自洽，接收端整包替换后重挂，因此**同样不需要改主键**。

副作用是冲突粒度变成「每门课」：两台设备同时改同一门课的不同部分时，后写的一方整体胜出。对一个人自用两台设备足够；要更细就得回到 CRDT，与 §非目标 冲突。

**但整包不能是唯一的粒度** —— 播放进度是高频写入（`lastPosition` 每几秒一写），每次推一个 MB 级整包不可接受。因此每门课拆单元：

| 单元 | 内容 | 写入频率 | 量级 |
|---|---|---|---|
| `video:<id>:meta` | `videos` 行易变字段：`lastPosition`、`finished`、`lastUnit`、`folderId`、`name`、`coverState`、`skillOverride` | 高 | < 1KB |
| `video:<id>:content` | `segments`、`subtitleTracks`、`materialBlocks`、`handouts`（IR + 元数据）、`chatSessions`、`chats`、`comments`、`danmakus`、`cards` | 低 | 约 1MB（压前） |
| `video:<id>:vectors` | `embeddings` 或 `materialEmbeddings`（二进制） | 低（索引建成时） | 1.2–4.9MB |
| `video:<id>:frames` | `frames` 表的全部帧（打成一个 zip） | 低（讲义生成时） | 约 1.5MB |
| `video:<id>:cover` | `covers` 一行（单张小图） | 极低 | 约 25KB |

**`frames` 打成一个 zip 而不是一帧一个对象**：`fflate` 已是项目依赖；30 个对象 = 30 次 Class A 操作与 30 次往返，打包成 1 个对象则只有 1 次，且「整包替换」的原子性与单元语义天然一致。

其余全局单元：`folder:<name>`、`study:<YYYY-MM-DD>`、`skill:<name>`、`settings`。

**为什么全局表按名字/日期切碎**：整表一个单元会让「在 iPad 上多学了 10 分钟」的推送覆盖掉 Mac 上的全部学习记录。切碎后冲突面收敛到「同一天」。

### 3.3 冲突策略

单元级 last-write-wins，加两个特例：

| 单元 | 策略 | 理由 |
|---|---|---|
| `video:*`、`folder:*`、`skill:*`、`settings` | `updatedAt` 新者胜 | 实现简单、语义可预期 |
| `study:<date>` | **取较大值** | 同一天两台设备都学过时相加会重复计时，跳过会丢掉更久的那一半。**沿用 `migration.ts` 已有语义** |
| `video:<id>:meta` 的 `lastPosition` | `updatedAt` 新者胜 | 「我最后在哪台设备看到哪」是真实意图，即使新位置更靠前（从头重看）也应接受 |

### 3.4 与手动迁移包的关系

`migration.ts` 里的 `encodeRow`/`decodeRow` 与整套合并逻辑，正是同步所需的两个原语。做法是**拆成可复用的 `pack` / `unpack`，让迁移包与同步共用一份**：

```
src/sync/pack.ts    DB 行 → 同步单元载荷（含 encodeRow）
src/sync/unpack.ts  同步单元载荷 → DB（含包内 id 重挂）
```

`migration.ts` 改为调用这两个模块。**不接受「同步新写一套合并逻辑」** —— 两套并存必然漂移，而漂移的表现是数据静默错乱。

### 3.5 存储分层

| 载荷 | 存哪 | 编码 |
|---|---|---|
| 文本单元（`content` / `meta` / `folder` / `study` / `skill` / `settings`） | D1 `payload` 列 | 客户端 **gzip**（`fflate`，中文 JSON 压缩率约 20–25%），以 `int8Array` 绑定参数写入。**不用 SQL 字面量拼接** —— 免费档单条 SQL 语句上限 100KB；绑定参数不占这 100KB，单查询最多 100 个绑定参数 |
| 二进制单元（`vectors` / `frames` / `cover`） | R2 对象 | 原样二进制（zip / Float32 字节 / WebP），**不做 base64**（避免 33% 膨胀与 Worker 侧 CPU） |
| 单元索引 | D1 `units` 表 | 只存元数据；大对象记 `r2_key`，不记字节 |

D1 索引表：

```sql
CREATE TABLE units (
  unit       TEXT PRIMARY KEY,
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL,            -- 'text' | 'blob'
  r2_key     TEXT,                     -- kind='blob' 时指向 R2 对象
  part       INTEGER NOT NULL DEFAULT 0,
  part_total INTEGER NOT NULL DEFAULT 1,
  payload    TEXT                      -- kind='text' 时内联；> 256KB 则拆多行 part
);
CREATE INDEX idx_units_rev ON units(rev);
```

**为什么文本走 D1 而不是全塞 R2**：文本单元是 pull 的常见项，内联在 D1 可以一次查询取回一批，省掉 N 次 R2 往返。**为什么二进制不进 D1**：D1 单行上限 2MB、单库上限 500MB（免费档），向量与帧必然顶穿。

**blob 单元的写入顺序**：先写 R2 对象，再写 D1 索引行。D1 索引行是唯一的真相来源（`rev`/`updated_at`/`deleted`），R2 对象只被索引行引用 —— 顺序反了会出现「索引指向不存在的对象」。旧 R2 对象在索引行更新后异步删除，失败不重试（残留的孤儿对象只占存储、不影响正确性）。

### 3.6 传输协议

Worker 四个路由，单用户、固定 `user = 'me'`：

```
GET  /sync/state                 → { rev, updatedAt }               轻量探活 + 取游标
GET  /sync/pull?since=<rev>&limit=50
                                 → { rev, hasMore, units: [...] }   拉取已变更单元的索引
GET  /sync/blob?key=<r2_key>     → 流式返回二进制                    Worker 不落内存
POST /sync/push                  → { rev, conflicts: [...] }         推送，冲突单独回报
```

- **`rev` 由服务端单调分配**，客户端不参与 —— 用客户端时间戳当版本号会因两台设备时钟偏差出错。
- 推送携带 `baseRev`（客户端拉取时该单元的 rev）。服务端发现 `baseRev` 落后时返回该单元的当前版本，客户端按 §3.3 合并后重推一次（仅一次，避免震荡）。
- `pull` 与 `push` 都分页（不变量 6），客户端循环到 `hasMore: false`。
- 二进制单元的分片沿用 `part` / `part_total`，每片独立成 R2 对象。

### 3.7 删除与墓碑

现有代码删除是**直接 delete，不留痕**，最大的删除路径是 `Library.tsx` 删课程时级联清 12 张表。没有墓碑，另一台设备会在下次同步时把删掉的课程又推回来。

做法：本地新增 `syncUnits` 表（Dexie v13）记录同步状态，删除时写 `deleted: 1` 墓碑而不是删行：

```ts
interface SyncUnitRow {
  unit: string;        // 主键
  rev: number;         // 本地已知的服务端 rev（0 = 从未同步）
  updatedAt: number;   // 本地最后修改时间
  dirty: 0 | 1;        // 待推送
}
```

课程删除时，该 `videoId` 下的 `meta` / `content` / `vectors` / `frames` / `cover` 五个单元一起写墓碑。

**墓碑保留期 90 天**：离线超过 90 天的设备再上线，会看到已删课程「复活」。个人工具可接受，但要写进 README 已知限制，而不是让人自己发现。

### 3.8 触发时机

| 时机 | 动作 |
|---|---|
| 应用启动、`online` 事件 | pull（先探 `/sync/state`，rev 未变则跳过） |
| 本地 L1/L2 写入 | 标记对应单元 `dirty: 1`，防抖 30s 后 push |
| `visibilitychange` 转隐藏 | 立即 flush（移动端被切走可能就没有下次机会） |
| 设置页「立即同步」 | 手动 pull + push |
| Worker 不可达 | 静默跳过，仅更新卡片上的「上次同步」时间戳 |

**不做的**：不做轮询、不做 WebSocket、不做后台定时 —— PWA 在 iPad 上被挂起后定时器不可靠，做了反而制造「以为同步了其实没有」的错觉。

### 3.9 认证与凭据

- Worker 侧：`SYNC_TOKEN` 用 `wrangler secret put` 配置，校验 `Authorization: Bearer <token>`。**不写进 `wrangler.toml`**。
- 客户端：设置页填 Worker 地址与 token，存 localStorage（与现有 `apiKey` 同等对待，输入框用密码态）。
- token 是**唯一凭据**，泄漏等于全部学习数据泄漏。README 免责声明必须更新（§7）。
- 不做速率限制、不做多 token。

### 3.10 设置同步的白名单

21 个字段中仅下列参与同步：

```
baseUrl  asrModel  llmModel  embedModel  visionModel  favorites
contextWindow  asrConcurrency  thinkingEnabled  thinkingEffort
captionScale  agentRounds  danmakuEnabled  customRates  theme
dynamicColor  studyTrackingEnabled  studyIdleMinutes
```

**排除**：`apiKey`、`bilibiliCookie`（不变量 1）、`bilibiliProxy`（跟部署位置绑定）、`syncEndpoint`、`syncToken`、`syncEnabled`（同步自身的配置必须本机独立，否则「关掉同步」都同步不过去）。

白名单与排除项写成**两张显式常量表**（`src/sync/units.ts` 的 `SYNC_SETTINGS_KEYS` / `NON_SYNC_SETTINGS_KEYS`），每一条排除项都必须写明理由 —— 否则下一个人会以为它只是被忘了。

**「新字段必须归类」这条用编译期守门员，不用单测**（实现时对初稿的修正，理由如下）：

```ts
export const ALL_SETTINGS_FIELDS_CLASSIFIED:
  [keyof Settings] extends [SettingsKeyCovered] ? true : false = true;
```

往 `Settings` 加字段而没归入两张表之一时，`keyof Settings` 不再被覆盖，类型变成 `false`，于是 `= true` 触发 `Type 'true' is not assignable to type 'false'`。

为什么比单测强：`npm run build` 含 `tsc -b`，是必经关卡；而单测要人记得运行。加字段这个动作本身发生在编辑器里，编译期反馈最及时。单测则负责**类型管不到**的两条：两张表不得有交集（类型无法表达「互斥」），以及「`apiKey` / `bilibiliCookie` 必须在排除项里」这条不许松动的底线（单独成一条测试，让它红得显眼）。

### 3.11 同步 `frames` 之后，讲义插图的行为

上一版把「设备 B 重建讲义插图缺失」列为已知降级，**这是错的**。`src/pipelines/handoutEdit.ts:137` 的注释写明了既有行为：

> 由 IR 重建 DOCX：图片优先按原视频重抽高清（1600px），失败/视频已删**回退 frames 表 VL 帧**

所以同步 `frames` 之后：

- 设备 B **有**课程视频（本地导入过）：重建走 1600px 高清路径，与设备 A 一致。
- 设备 B **没有**课程视频（L3 不同步的常态）：重建走 640px 兜底路径 —— **插图在，清晰度降一档**（约 110 DPI，屏幕阅读没问题，打印偏软）。

因此 `handouts.blob` 继续不同步是自洽的：成品 DOCX 可从 IR + frames 重建，而同步 blob 本体（1–5MB）比它的图源（约 1.5MB）更贵。

**若日后要打印级清晰度**，两条路：同步 L3 视频本体（在本机重跑重抽），或加同步 `handouts.blob`（直接拿含 1600px 插图的成品，但需在 IR 编辑后重新推送以保持一致）。都不在 v2 范围。

## 成本与额度

**计费口径（回答用户的提问）：按 Cloudflare 账号，不按项目、不按设备、不按 Worker。** 同一账号下所有 Workers / D1 / R2 的用量汇总到同一份额度 —— 也就是说新增的同步 Worker 会与现有 `bili-proxy.js` **共享**那 100,000 请求/天。

以下为 2026-09-23 核对官方文档所得的免费档额度：

| 产品 | 免费额度 | 关键硬限制 |
|---|---|---|
| Workers | 100,000 请求/天（UTC 午夜重置） | **CPU 10ms/请求**、子请求 50/请求、并发出站连接 6、内存 128MB。超额直接 **429**（不是计费） |
| D1 | 5GB 存储/账号、5M 行读/天、100K 行写/天、10 个库 | **单库上限 500MB**（免费档，不可提升）、单行 2MB、单条 SQL 语句 100KB、每次 Worker 调用 50 条 SQL |
| R2 | 10GB 存储、1M Class A（写）/月、10M Class B（读）/月 | **出口流量免费**；计费向上取整到整数 GB-month |

付费档参考：Workers $5/月含 10M 请求（超出 $0.30/M，CPU $0.02/M CPU-ms）；R2 $0.015/GB-月、Class A $4.50/M、Class B $0.36/M。

**按本项目的实际用量估算**（假设 200 门 1 小时课程，全部有字幕 + 向量索引 + 讲义抽帧）：

| 项 | 单课 | 200 课 | 归属 | 占免费额度 |
|---|---|---|---|---|
| L1 文本（gzip 后） | 约 350KB | 约 70MB | D1 | 单库 500MB 的 **14%** |
| `frames` | 约 1.5MB | 约 300MB | R2 | — |
| `embeddings`（按 4096 维） | 约 4.9MB | 约 980MB | R2 | — |
| `covers` | 约 25KB | 约 5MB | R2 | — |
| **合计** | | **约 1.4GB** | | R2 为 10GB 的 **13%** |

请求量：即便每天同步 200 次、每次推 5 个单元 —— 约 6,000 请求/月、1,000 次 Class A/月、数百次 Class B/月，相对 100,000/天、1M/月、10M/月**差两到三个数量级**。

**结论：个人自用落不到付费档，$0。** 触发付费的前提是：存超过 10GB（约 1,400 门课），或开始同步视频本体（L3）—— 后者会立刻把用量从 GB 级推到数十 GB 级，是唯一真正会花钱的变更。

两个要通过实操验证、不能只看文档的点（**这两条我无法替你确认，需要你在 dashboard 上走一遍**）：

1. **开通 R2 需要先绑定支付方式**，即使全程留在免费额度内。多数实操教程与作者实测一致（含一张「向银行卡发短信验证」的描述，国内双币/银联卡有成功案例）；但也有一处来源称免绑卡。以你 dashboard 实际提示为准 —— 若被卡在这一步，退路是**只同步 L1 文本**（D1 不需要绑卡），L2 留本机重建。
2. 免费档 **CPU 10ms/请求** 是否够用。按不变量 5 的设计（Worker 只搬运、不解析载荷、R2 对象流式转发），同步 Worker 的 CPU 消耗应该远低于 10ms；但首次全量同步（200 门课 = 约 1000 个单元）时，如果 push 是逐单元请求，请求数会瞬间冲到千级 —— 仍在 100,000/天 内，但**客户端需要做批量与限速**，否则会被限流。这一点在实现时按批量 20 个单元/请求设计。

## 涉及文件

**新增**

| 文件 | 作用 |
|---|---|
| `src/sync/pack.ts` | DB 行 → 同步单元载荷（从 `migration.ts` 抽出 `encodeRow`），文本 gzip、二进制打包 |
| `src/sync/unpack.ts` | 单元载荷 → DB（从 `migration.ts` 抽出合并与 id 重挂逻辑） |
| `src/sync/units.ts` | 单元 id 构造与解析、本地表 → 单元映射、分片规则（纯函数，可单测） |
| `src/sync/blob.ts` | R2 对象的读写封装（zip 打包/解包、Float32 ↔ 字节、二进制分片） |
| `src/sync/client.ts` | `/sync/*` 的 fetch 封装：token、超时、分页循环、错误归一 |
| `src/sync/index.ts` | 编排：pull → 合并 → push；防抖、脏标记、批量限速 |
| `src/store/syncState.ts` | `syncUnits` 表的读写、dirty 标记、墓碑 |
| `src/components/SyncCard.tsx` | 设置页卡片：开关 / 地址 / token / 立即同步 / 上次同步 / 上次结果 / 用量 |
| `cloudflare-worker/sync-worker.js` | Worker 实现（`/sync/state`、`/sync/pull`、`/sync/blob`、`/sync/push`） |
| `cloudflare-worker/wrangler-sync.toml` | D1 + R2 绑定（与现有 `bili-proxy.js` 各自独立部署） |
| `cloudflare-worker/sync-schema.sql` | `units` 表与索引 |
| `scripts/test-sync-units.mjs` | 单元切分与解析、分片规则、设置白名单与 `Settings` 的差集断言 |
| `scripts/test-sync-pack.mjs` | pack/unpack 往返：文本 gzip 往返、二进制字节级相等、包内 id 重挂、墓碑、`studyDays` 取大 |
| `scripts/e2e-sync.mjs` | 两个浏览器 context 模拟两台设备互推（含 L2） |

**改动**

| 文件 | 改什么 |
|---|---|
| `src/store/db.ts` | v13 加 `syncUnits` 表 |
| `src/store/migration.ts` | 改为调用 `sync/pack.ts`、`sync/unpack.ts`，删除本地重复实现 |
| `src/pages/Library.tsx` | 删课程（级联 12 张表）/删文件夹/改名/改 `folderId` 时写单元脏标记与墓碑 |
| `src/pages/Player.tsx`、`src/materials/*` | 进度写入点标记 `video:<id>:meta` 脏（复用已有节流落库时机，不新增定时器） |
| `src/pipelines/embedIndex.ts`、`src/pipelines/embedMaterial.ts` | 索引建成后标记 `vectors` 单元脏 |
| `src/pipelines/handout.ts`、`src/pipelines/cover.ts` | 帧入库、封面更新后标记 `frames` / `cover` 单元脏 |
| `src/store/settings.ts` | 加 `syncEnabled` / `syncEndpoint` / `syncToken`；导出同步白名单常量 |
| `src/pages/Settings.tsx` | 挂载 `SyncCard` |
| `src/main.tsx` | 启动时触发一次 pull（失败静默） |
| `scripts/e2e-all.mjs` | 登记 `e2e-sync` 的 META（`service`、`key`、`timeout`、`skip` 原因） |
| `README.md` | 免责声明（数据会离开本机）、功能一览、已知限制（90 天墓碑、插图降为 640px）、目录结构、部署一节加同步 Worker |

## 验证

**纯 Node 单测**（无需 key、无需服务）

- `test-sync-units.mjs` —— 单元 id 往返；分片边界（256KB 两侧）；设置白名单与 `Settings` 的差集断言（**防将来加字段漏判的守门员**）
- `test-sync-pack.mjs` —— 造一门课的完整 fixture（含材料类课程）→ pack → unpack 到空库 → 与原库逐字段比对：
  - 文本 gzip 往返后 JSON 完全相同
  - 二进制（Float32 向量、JPEG 帧、WebP 封面）**字节级相等**
  - `comments.parentId` 两级重挂、`chats.sessionId` 重挂、`embeddings.segmentId` 重挂、`materialEmbeddings.blockId` 重挂
  - `studyDays` 同日取大
  - `handouts` 无 blob 时不崩
- `test-migration.mjs` 必须仍然全绿 —— 迁移包与同步共用合并函数后，这是回归防线

**e2e**（`scripts/e2e-sync.mjs`）

- 两个 `browser.newContext()` 模拟两台设备，共用一个本地 stub Worker（Node 起的极简 D1/R2 替身，避免测试依赖 Cloudflare 账号）
- 断言链路：A 导入课程并生成字幕 + 索引 + 讲义 → A push → B pull → B 的字幕数、检索结果、`frames` 帧数与字节、封面、讲义重建都可用
- B 删掉该课程 → push → A pull → A 的课程及其 5 个单元全部消失
- 断网降级：关掉 stub Worker → 应用正常可用、无报错弹窗、卡片显示「同步失败」而不阻塞任何操作
- 分页：造 120 个脏单元，断言客户端分页循环完成且无丢单元

**手工验收（云端真机）**

`npm run build` → 部署 → Mac 上导一门 B 站课程、生成字幕与讲义 → iPad 打开同一地址 → 不导入任何文件即可：看到字幕、问答能检索到内容、讲义预览带插图。

## 变更记录

- 2026-09-23 初稿。推翻两处早期判断：
  - **原判断「必须先改自增主键」** → 实测引用链后改为「以课程为单元整包替换 + 复用 migration 的 id 重挂」，现有表结构零改动。
  - **原判断「逐行 LWW + 逐行 updatedAt」** → 改为单元级 LWW，不侵入 19 张表每一行。
- 2026-09-23 v2（本次）。三处实质修订：
  1. **L2 纳入同步范围**（用户要求）。架构新增 R2 与存储分层（§3.5），`embeddings` / `frames` / `covers` 各自成单元，向量与帧仍走「整包替换 + 包内 id 重挂」，因此**主键依旧不用改**。
  2. **修正体积估算**：实测 640px/q0.75 帧为 12–40KB，`frames` 单课约 1.5MB；此前沿用 `2026-09-09` 文档的「10–30MB」把临时重抽的 1600px 高清帧误当成了入库数据。该修正使 L2 同步的体积预期下降约一个数量级。
  3. **修正讲义插图结论**：上一版把「设备 B 插图缺失」写成降级，实际 `handoutEdit.ts` 已有 640px 兜底路径 —— 插图不缺失，只是清晰度降一档。
  - 补一处 v1 遗漏：`materialBlocks` 必须同步，并入内容单元。
  - 新增 §成本与额度：按用户提问补充 CF 计费口径（按账号）、免费档硬限制与用量估算。
- 2026-09-23 开工：地基模块落地，三处实现期修正记录如下。
  1. **`src/sync/units.ts` + `scripts/test-sync-units.mjs`（27 条断言）**：单元 id 构造/解析往返、名字编码无歧义、分片边界、畸形 id 不抛异常、设置白名单与排除项互斥。零运行时依赖（只 `import type`），Node 直接读 TS。已登记 `scripts/e2e-all.mjs` 的 META，编排器实跑通过。
  2. **守门员从「单测」改为「编译期」**：见 §3.10。实测它**立刻抓到一个真实的建模漏洞** —— 我原本以为 `VideoRow` 的字段只有「同步」与「本机事实」两类，守门员报错后才发现主键 `id` 无处安放（它既是单元 id 本身的来源，又不属于任何一类）。于是新增第三类 `VIDEO_IDENTITY_FIELDS`，并把这段经过留在代码注释里，免得后人又想把三类简化回去。
  3. **`VideoRow` 字段归属定型**：`VIDEO_META_FIELDS`（17，跟着走）/ `VIDEO_LOCAL_FIELDS`（2，`fileDeleted`、`coverState`）/ `VIDEO_IDENTITY_FIELDS`（1，`id`）。其中 `fileDeleted` 不得同步是硬结论（A 腾空间删文件不该让 B 也变「文件已删」）；`coverState` 是**暂定**本机，待封面单元实现时回头确认（见 §3.2 末尾）。
  - `Settings` 增三个字段：`syncEnabled`（**默认 false**）/ `syncEndpoint` / `syncToken`。同步默认关闭不是保守起见 —— 开关一开，「数据不出本机」这条承诺就失效，必须由用户显式做。
  - **附带发现（非本次引入）**：`src/components/TimeSliderWithPreview.tsx` 是一个**未提交且无人引用**的半成品文件，它让 `tsc -b` 报 5 条错，因此**当前 `npm run build` 是红的**。与本设计无关，但会让「构建作为交付关卡」这条约定暂时失效，需要单独处理（补完或删除）。
- 与 `2026-09-09-data-migration-design.md` 的「不做云端同步（用户明确一次性迁移场景）」冲突：该非目标因需求变化作废，但**那份设计的格式、合并语义、`fileDeleted` 机制全部保留并被本次复用**（其体积估算一并修正，见上）。

### 参考来源

- R2 定价与免费额度：https://developers.cloudflare.com/r2/pricing/
- D1 限制（单库 500MB、单行 2MB、SQL 语句 100KB、每次调用 50 条 SQL）：https://developers.cloudflare.com/d1/platform/limits/
- Workers 限制（免费档 100k 请求/天、CPU 10ms、子请求 50）：https://developers.cloudflare.com/workers/platform/limits/
