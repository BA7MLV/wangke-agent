# 主页进度条设计：lastPosition 语义归位，外加一个 finished 标记

- 状态：**已实现并回归**（DB 仍为 v11，未升版本）
- 日期：2026-09-18
- 需求：课程库每张卡片的缩略图底边显示播放进度条；「已看完」与「没看过」必须能分开

## 1. 需求拆解：唯一的真问题是「播完」怎么表示

进度数据早就有了 —— `videos.lastPosition`（秒，非索引字段，见 `store/db.ts`），
由播放页的 `MediaStorage` 覆写在播放中持续落盘。所以这件事表面上只是「读出来画一条」。
但有一个绕不开的点：

**`Player.tsx` 原本写的是 `{ lastPosition: ended ? 0 : time }` —— 播完归零。**
于是「已看完」和「没看过」在数据上完全同形（都是 0 / 无值），主页上必然长得一模一样。
而扫一眼主页想知道「哪些课还没刷完」正是这个功能的主要价值，所以这条不能不管。

两条路：

| 方案 | 代价 | 结果 |
| --- | --- | --- |
| 不改写入，播完不显示进度条 | 零 | 「已看完」不可见，功能价值砍掉一半 |
| 加一个独立的完成标记 | 1 个非索引字段 + 改 3 行写入 | 满条 vs 无条，一眼可分 |

选后者。注意**不能**简单地把 `ended` 时写成 `duration` 来蒙混 —— 那会让 `getTime`
下次返回结尾位置，一进播放页就落在结尾，断点续播直接废掉。除非把「从头开始」的
判断也一起搬走 —— 这正是下面 §3.2 做的事。

## 2. 不变量

1. **断点续播不能坏**。播完后再打开，必须从头开始（与改动前完全一致）。
2. **`lastPosition` 只表示「真实播放位置」**，不再承载「播完了所以归零」这种隐藏语义。
   主页因此不需要特判就能用 `lastPosition / duration` 算比例。
3. **进度条只在「有进度可言」时出现**。不用 0 宽度的条冒充 —— 那会把
   「看了 2 秒」和「没看过」渲染成同一个东西，属于「看起来正常其实错账」。
4. **不新增任何查询**。列表页 `reload()` 本来就把 `videos` 整行读进内存
   （`orderBy('createdAt').reverse().toArray()`），`lastPosition` 与 `finished` 都在手上。
5. **不改写入频率、不新增表、不升 DB 版本**。

## 3. 设计

### 3.1 数据层：一个非索引字段，不升版本

```ts
/** 本轮已播完（看到结尾）。与 lastPosition 配合，见 Player.tsx 的 resumeStorage。 */
finished?: 0 | 1;
```

- 走 `folderId` / `dominantColor` / `coverState` 那一套先例：**非索引字段，老数据零迁移、
  无需升版本**。
- **为什么是 `0 | 1` 而不是「有就 true、清就 delete」**：清除标记要靠 `Table.update()`
  写回，而 `update` 收到 `undefined` 时的行为（删字段还是写 undefined）依赖 Dexie 的实现
  细节。写成 `0` 语义显式、行为可测，判断统一用 `v.finished === 1`（老数据没有这个字段，
  `undefined === 1` 为 false，天然是「未看完」）。
- 迁移包是**整表导出 `videos`**（`store/migration.ts` 的 `TABLES`），所以 `finished`
  自动跟着走，不用改 `migration.ts`。

### 3.2 语义搬家：归零从 `setTime` 搬到 `getTime`

```
旧： setTime(time, ended) → lastPosition = ended ? 0 : time      ← 播完归零
新： setTime(time, ended) → lastPosition = time, finished = ended ? 1 : (不动)
     getTime()            → 见 finished === 1 ⇒ 清标记 + 位置归零，返回 0
                           → 否则返回 lastPosition
```

搬家的收益：`lastPosition` 变成干净的真实位置，主页直接算比例即可；
「播完」这个状态由 `finished` 单独表达。

**为什么清标记要真的写库，而不是「见 `finished` 就返回 0」读时糊弄过去**：
后者的漏子很具体 —— 播完 → 打开 → 拖到 90% 看一段 → 退出。
读时糊弄的版本会把 `finished` 一直留着，下次打开又从头开始，**刚看的那段进度白丢**。
「打开」这个动作本身就是新一轮观看的开始，所以在这里落一次库（`finished = 0`、
`lastPosition = 0`）是语义正确的位置，不是将就。

`getTime` 只在播放器初始化时被调一次（vidstack 在 `canPlay` 时读），不是高频路径；
里面多一次主键写可忽略，且失败要吞掉（`try/catch`）—— 读进度失败不该拦住播放。

### 3.3 vidstack 的调用顺序（读源码实测，决定了不能怎么写）

`#onEnded` 里第一行是 `#onEndPrecisionChange(event)`，它会 dispatch 一个 `time-change`，
而 `time-change` 处理器会调 `#saveTime()` → `storage.setTime(realCurrentTime())` ——
**一次不带 `ended` 参数的调用**。之后才是 `storage.setTime(duration(), true)`。
即播完那一瞬间有两次写入，最终生效的是后者（带 `ended`）。

这条实测结论排除了一个看着很优雅的规则：**「非 ended 就清 `finished`」**。
它在上面那个顺序下会「先清、再被写回」，跑起来像是对的，但完全依赖 vidstack 的内部
调用顺序 —— 库一升级就可能静默失效。所以清标记只放在 `getTime`（语义位置），
不放在 `setTime` 里做时序猜测。

### 3.4 纯逻辑（`utils/videoProgress.ts`）：比例与「该不该画」

单独拆出来是因为这里的规则全是边界判断，能用纯函数表达并单测：

| 输入 | 输出 | 理由 |
| --- | --- | --- |
| `kind === 'material'` | `null` | 材料的进度是 `lastUnit / unitCount`（页/段），另一套口径，本次不做 |
| `duration` 非有限数或 ≤ 0 | `null` | 时长没探到就没法算比例；硬算会得到 Infinity |
| `finished === 1` | `1` | 满条。**放在比例计算之前**：万一 `lastPosition` 是 0（历史数据），标记仍能纠正 |
| `lastPosition` 缺失 / 非有限数 / ≤ 0 | `null` | 没看过 |
| 比例 < 1% | `null` | 见下 |
| 其余 | `clamp(lastPosition / duration, 0, 1)` | `lastPosition > duration` 时要夹住（时长探测误差会造出 100.4%） |

**1% 阈值为什么存在**：40 分钟的课看了 5 秒，比例 0.2%，画出来是不到 1px 的一丝 ——
既看不清，也让人以为渲染坏了。**但不能用 `min-width: 2px` 去补救**：那会把
「看了 5 秒」画成「看了 1%」，是把错误藏起来。宁可不出条，与「没看过」同形 ——
这两者在这个精度下本来也没有可分辨的差别。

### 3.5 页面（`pages/Library.tsx` + `ui/layout.css`）

- 落点：`.video-row__thumb` 内部贴底边。该容器本来就是
  `position: relative` + `overflow: hidden` + `border-radius: 12px`，所以
  **圆角裁切是白送的**，不需要给进度条自己算圆角。
- 与右下角时长徽标（`.video-row__duration`，`bottom: 6px`）不冲突：进度条高 4px 贴 `bottom: 0`。
- **必须与后台任务进度区分开**：同一张卡上 `.video-row__job` 也用进度条语义
  （转写 / 建索引，`Library.tsx` 里的 `mdui-linear-progress`）。两者靠位置分：
  任务进度在文字区、播放进度在缩略图上；颜色也不同（任务用 primary 文字色，播放用 primary 实心条）。
- 颜色走 mdui 令牌：轨道 `rgb(0 0 0 / 0.32)`（压在任意缩略图上都稳），
  进度 `rgb(var(--mdui-color-primary))`。**不自造颜色**。
- 渲染条件由 `progressRatio()` 决定，返回 `null` 时**不渲染这个元素**（而不是渲染一条 0 宽度的）。
- 测试锚点：容器 `data-testid="video-progress"` + `data-ratio`（三位小数）+ `data-finished`；
  填充层 `data-testid="video-progress-fill"`。`data-ratio` 给断言数值，真实宽度给断言 CSS 真的生效了。

## 4. 验证

`scripts/test-video-progress.mjs`（纯 Node）：材料的 null、`duration` 为 0 / NaN / 负数、
`finished` 的优先于比例、`lastPosition` 缺失 / 0 / 负数 / NaN、
1% 阈值两侧（恰好 1% 与略低于 1%）、`lastPosition > duration` 的夹取、
正常比例、以及 `finished` 与 `lastPosition` 同时存在时的取舍。

`scripts/e2e-library-progress.mjs`（preview 档，**自播种、不需要 TEST_FILE**）：
用原生 IndexedDB 播种 5 条视频（看到 62% / 已看完 / 没看过 / 看了 5 秒 / 阅读材料）→
刷新 → 断言**只有两条**进度条、`data-ratio` 数值对得上、
**填充层的实际像素宽度 / 容器宽度 ≈ 比例**（这条才抓得住 CSS 没生效）、
进度条确实在缩略图内部（`closest('[data-testid="video-thumb"]')` 非空）、
`finished` 的那条 `data-ratio === 1`。顺手留一张 `e2e-shots/library-progress.png`。

`scripts/e2e-resume.mjs`：**注释要改**。它原来写着「播完归零逻辑由 ended 回调保证」，
现在语义变了（播完写真实位置 + `finished`），注释与实现不符就是误导。断言本身不用动 ——
它验的是「seek 到 10s 播放几秒后 `lastPosition` ≥ 9」，新语义下依然成立。

## 5. 已知未做 / 取舍

1. **老数据无法回溯**。改动之前已经播完的视频，`lastPosition` 被写成了 0 且没有
   `finished` 字段 —— 它们在主页上会显示成「没看过」。**这不是 bug，是信息在数据里
   根本不存在**：0 既可能是「没看过」也可能是「看完了」，无法反推。不做猜测性迁移。
2. **看到 99% 不算看完**。`finished` 只在真正触发 `ended` 时写。差 1% 没播完就退出，
   主页显示 99% 的条 —— 这是诚实的。
3. **阅读材料没做**。`lastUnit / unitCount` 是另一套口径（位置而非时间），
   要单独算比例、单独写测试。
4. **不做「继续观看 12:34 / 20:15」文字**。只做条，信息量够用、视觉最干净。
5. **不做「继续观看」区块 / 按进度排序**。主页的分组与排序规则不动。
6. **`setTime` 没有节流**（顺带发现，本次不动）。vidstack 在每次 `time-change` 时都会调
   `storage.setTime`，而内置的 `LocalMediaStorage` 版本是 `functionThrottle(saveTime, 1000)`
   （1 秒节流）。我们覆写后是每次调用直接 `db.videos.update()` 一笔 IndexedDB 写。
   time-change 的实际频率未实测。补节流是独立一笔改动，且会影响断点续播的落盘时机，
   要与 `e2e-resume` 一起改，不掺进这次。
7. **多设备同时播放同一视频**不做协调（后写的覆盖先写的）。跨设备本来就只有迁移包一条路，
   而 `lastPosition` 随 `videos` 整行迁移，天然带过去。
