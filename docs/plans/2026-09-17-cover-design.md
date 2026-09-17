# 封面（派生资源）设计：入库即生成，三类内容共用一条路

- 状态：**已实现并回归**（DB v10）
- 日期：2026-09-17
- 需求：封面不该依赖「跑过讲义」这个前提；视频、PDF、Word 都不该出现「没有封面」的长期状态

## 1. 问题：封面从来不是一份「资源」，而是一条链路的副产品

旧实现里没有封面字段（全项目搜不到 `poster`），最接近封面的是资料库卡片里的
`useCover(videoId)` —— 它去 `db.frames` 取该视频的第一帧，而 `db.frames` **只由讲义流程写**
（`pipelines/handout.ts`，且只写被 VL 判为 slide 的帧）。于是：

| 场景 | 旧行为 |
| --- | --- |
| 刚导入、还没生成讲义 | **没有封面** |
| 只做了转写 | **没有封面** |
| 讲义生成过，但没判定出 slide 帧 | **没有封面** |
| 正在重新生成讲义 | 封面**凭空消失**（`delete` 与 `bulkAdd` 之间 frames 是空的） |
| `bulkAdd` 之前失败（配额/中断） | 旧的帧已删，封面**永久丢失** |
| 阅读材料（PDF / Word） | 硬编码文档图标，从不尝试生成 |

顺带两个被证伪的历史假设：

1. `docs/plans/2026-09-16-youtube-style-ui-design.md` 里写的「封面取 `db.frames.thumb`
   （320px dataURL）」**从未落地**：`FrameRow` 没有 `thumb` 字段。`useCover` 实际用的是
   全尺寸 `frame.blob`。而且 dataURL 本身就是错的方向 —— base64 相对 Blob 膨胀 33%，
   存进 IndexedDB 还要走字符串。
2. 封面「有就用、没有就占位」被当成设计内的正常态，而不是待修的问题。

## 2. 不变量

1. **封面是派生资源，不是事实来源**。生成失败绝不影响资源本身可用（字幕/讲义/问答照常）。
2. **不阻塞入库**。生成永远在后台队列里，导入流程不等它。
3. **永不空白**。任何时刻卡片都有东西可画（封面 → 主色 → 图标）。
4. **不重读全表**。封面 blob 不能出现在 `videos` 行上，列表页那句 `videos.toArray()`
   不允许把几十上百张图拉进内存。
5. **原子写入**。任何「先删后写」的窗口都是 bug。

## 3. 设计

### 3.1 数据层（v10）

```ts
export interface CoverRow {
  videoId: string;   // 主键，就是 videos.id：三类内容共用一个 id 空间
  blob: Blob;        // 480px 长边、WebP（不支持时 JPEG），15~30KB
  w: number; h: number;
  ts: number;        // 视频=秒；材料=页码（PDF 恒为 1）
  source: 'user' | 'slide' | 'auto' | 'material-page' | 'material-title';
  createdAt: number;
}
// covers: 'videoId'
```

`VideoRow` 另加两个**非索引**字段（沿用 `cues` / `sectionsJson` 的先例）：

- `dominantColor?: string` —— 7 字符 `#RRGGBB`，LQIP 占位底
- `coverState?: 'pending' | 'done' | 'skipped'` —— `skipped` 只表示「永远不会有」（文件已删、Word 材料）

为什么拆表而不是挂字段：`covers.get(id)` 是主键查询、只读一条；挂在 `videos` 行上会让
每一次列表读取都顺带把封面 blob 拖进来。这是本项目最该守住的一条（旧代码在
`useCover` 的注释里已经手工躲了同一个坑，拆表才算从根上消掉）。

### 3.2 选帧（`media/frames.ts` 的 `pickCoverFrame`）

与 `extractFrames`（给讲义/VL 用，等间隔铺满全片 + dHash 去重）分工不同：封面要回答
「哪一帧最适合当这门课的脸」。

- **只采开头**：`min(3s, 2%)` 起，跨度不超过 120 秒。标题页/首页课件就在这里。
- **不打绝对阈值**：拉普拉斯方差的绝对值随分辨率与码率变化，标定出来的阈值换个视频就失效。
  所以清晰度与稳定性**只在这几个候选之间做组内归一化**，免标定；唯一的绝对量是亮度带
  （均值落在 `[0.15, 0.85]` 之外按距离衰减），因为黑场/过曝无论什么时候都该被判死。
- **稳定性探针**：同位置再取 `t + 0.35s`，两帧差得越多越可能是转场中点或剧烈运镜
  —— 那种帧是重影的，当封面很难看。
- **输出长边 480 + WebP**，并**校验 `blob.type`**：`convertToBlob` / `toBlob` 遇到不认识的
  格式不报错、而是静默退回 PNG（体积翻倍）。Safari 16.4 以下没有 `OffscreenCanvas`，
  回退到主线程 `toBlob`。

三级来源（`pipelines/cover.ts`）：

| 优先级 | source | 来源 |
| --- | --- | --- |
| 1 | `user` | 用户手选（**UI 尚未做**，见 §6） |
| 2 | `slide` | 讲义已抽好的幻灯片帧（课程首页即课件，最稳） |
| 3 | `auto` | 自己对视频多点采样打分 |
| — | `material-page` | PDF 首页按目标尺寸直接渲染（**不复用阅读器的 `renderPageToCanvas`**：那个的尺寸由「CSS 宽度 × dpr」推出、要跟文本层 viewport 同源，落到封面会有 floor 误差；封面按 `COVER_EDGE / 长边` 算 scale 一次画到位，同时先铺白底——pdf.js 不留底色） |

### 3.3 队列与触发（`pipelines/coverQueue.ts`）

- **串行**（并发 1）：抽帧要 seek + 解码，并行只会和「正在播放的视频」抢解码器。
- **幂等**：`known` 集合吸附「队列中 + 正在跑」的 id。
- **失败不写 `coverState`**：那正是留给下次启动回填重试的语义；只留一条控制台日志。
- **完成时 `useCoverStore.bump()`**：`useThumb` 订阅这个令牌重查自己那一张，
  而**不去调整个列表的 reload**（那要把 `videos` 整表读进内存）。

三个触发点：

1. 导入（视频与材料各一处，`Library.tsx`，写 `coverState: 'pending'` + `enqueueCover`）
2. **讲义跑完**（`handout.ts`）→ `enqueueCover(id, { force: true })`：
   手上的 slide 帧比入库时自动抽的那张更贴课件首页。`ensureCover` 会拒绝覆盖 `source === 'user'`。
3. **启动回填**（`App.tsx` → `backfillCovers()`）：给上线前的历史数据、上次失败的补封面。
   用 `covers.toCollection().primaryKeys()` 只取主键判断「谁有封面」，不读 blob。

### 3.4 读取（`Library.tsx` 的 `useThumb`）

四级降级，任何一级都不出空白：

1. `covers` 有记录 → `<img decoding="async" loading="lazy">`
2. 没有封面但有 `dominantColor` → 纯色块（LQIP）
3. 都没有 → 主题色底 + 图标（视频=播放、PDF=PDF、Word=文档）
4. 视频与 PDF 不再分叉：有封面就画封面，材料也有封面

两个实现细节：用 `createdAt` 判断「是不是同一版封面」（IndexedDB 每次读都重新反序列化，
Blob 的对象身份稳定不了）；先建好新的 object URL 再回收旧的，中间不留「指向已撤销 URL」的空窗。

## 4. 顺带修掉的一致性 bug

`handout.ts` 的 `db.frames` 写入：原先 `delete → bulkAdd` 中间 frames 是空的。现在包进
`db.transaction('rw', db.frames, ...)` 且**先写新的、再删旧的**。新行的 `++id` 与旧的不同，
不会互相误删。

## 5. 验证

`scripts/e2e-covers.mjs`（9 项，全绿）：

- 导入后**全程不碰讲义**，卡片自动出现封面 —— 直接钉死旧行为（并交叉验证此时 `db.frames` 计数为 0）
- 小图档位：640×360 源 → 480×270，体积 < 80KB
- `blob.type` 是 webp/jpeg、`source=auto`、`coverState=done`、`dominantColor` 合规
- 刷新后仍在（证明落库而非内存态）
- PDF：导入即有封面、长边 480 且保持 A4 竖版比例、**四角 alpha=255**（白底确实铺上了）、`source=material-page`
- 两步删除后 `covers` 不留孤儿行（v10 给级联清单加了 covers）

读库类断言需要 dev server（能动态 import `/src/store/db.ts`），preview 构建下自动跳过。

用法：`npm run dev &` → `BASE_URL=http://localhost:5173 node scripts/e2e-covers.mjs`

## 6. 已知未做 / 取舍

1. **手选封面 UI 没做**。`source: 'user'` 已在类型、优先级、`ensureCover` 的强制覆盖保护
   里预留好了位置，但还没有「从帧池里挑一张」的入口。补的时候只需写入 `covers`（`source: 'user'`）
   再 `bump()`，读取端不需要改。
2. **Word 材料没有封面**，保留文档图标 + `coverState: 'done'`。硬要生成就得自己排版一张
   标题卡（canvas fillText + CJK 换行），收益不高且容易做得难看。
3. **播放页的动态取色仍读 `db.frames`**（`Player.tsx`）。换成 `covers` 会让动态取色对所有
   视频生效、且与卡片缩略图配色一致，但要同步改 `scripts/e2e-material-you.mjs` 的播种方式
   （它按「种一帧 frames」验这条链路），属于独立一笔改动。
4. **`reuseSlideFrame` 会 `toArray()` 读出该视频全部帧的 blob**（几 MB）。它是一次性后台操作
   且队列串行，与 `Player.tsx` 的取舍相同；帧表没有 `kind` 索引，想只读 slide 帧也绕不开它，
   不值得为这个改库结构。
