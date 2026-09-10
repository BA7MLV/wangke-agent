# 字幕边转边显（增量字幕）设计

日期：2026-09-10
状态：已实现（方案一；播放器轨按实测结论改成「常驻单轨 + 增量 addCue」，见四·关键坑）

## 背景与目标

现状：点「生成字幕」后，字幕列表与画面字幕都要等整段音频转写完才出现。转写流水线**其实已经是逐段落库的**（`src/pipelines/transcribe.ts` 每段 ASR 成功即 `db.segments...modify({ text, status: 1, cues })`），只是 UI 侧没有订阅，且面板在 `finally` 里才 `reload()` 一次。

目标：
1. 转写进行中即可播放；每完成一段，立刻出现在字幕列表与画面字幕上（完成顺序可能乱，显示按时间排）。
2. 离开再回来能看到已转到的部分（与现有断点续做一致）。
3. 讲义 / 弹幕 / 卡片仍然等「本轮转写结束」再解锁，避免拿半份字幕去生成。

## 一、实测结论（决定实现形态）

动手前用一次性探针在真实播放器上验证了三个关键点（vidstack `@vidstack/react` 1.15.6）。

### 1. `<Track src>` 热更新会让字幕**直接消失**，不是「闪一下」

每段都新建 blob URL 换 `<Track src>` 的做法**不可行**。实测（换 src 后等 2s）：

```
轨状态: [{ kind:'subtitles', mode:'disabled', readyState:0, cues:0 }]   ← 新轨连加载都没触发
selected: null   画面字幕: ""
```
视频继续播、时间继续走（`paused:false`），**播放本身不卡**，只是字幕层没了；再换一次仍然如此，可稳定复现。

根因在 vidstack `TextTrackList`（`core/tracks/text/text-tracks.ts`）：

```ts
add(init)  { const kind = init.kind === 'captions' || init.kind === 'subtitles' ? 'captions' : init.kind;
             if (this.#defaults[kind] && init.default) delete init.default;   // key 是归一化后的 'captions'
             if (init.default) this.#defaults[kind] = track; }
remove(t)  { if (t === this.#defaults[t.kind]) delete this.#defaults[t.kind]; }  // 查的是 t.kind = 'subtitles'
```
`remove` 查 `#defaults['subtitles']`（不存在），真正的 `#defaults['captions']` **永不清理** → 新轨的 `default` 被 `delete` 掉、不登记为默认轨 → 延迟 300ms 的 `#selectTracks()` 把**已被移除的旧轨**设成 `showing`，新轨永远停在 `disabled`。

两个推论：
- 换 src 要能用，必须**每次换完手动把新轨置 `mode='showing'`**（已验证有效）。
- 同一个 player 会话内，「Track 卸载再挂载」也会踩同一个坑，新轨不会自动显示。

### 2. 常驻单轨 + 增量 `addCue` 可行，且是更优形态

一条轨挂一次，之后每完成一段往轨里塞 cue。实测（3 分钟素材、真播放）：

| 动作 | 结果 |
|---|---|
| 挂载无 `src` 的 `<Track kind="subtitles" default />` | 挂载即 `readyState=2`、自动 `mode='showing'` |
| 播放中立刻 `addCue(0,5,'ONE')` | `cues=1 active=1`，画面出现 "ONE"，`paused=false` |
| 连续追加 4 条 | `cues` 2→5，播放不中断，画面字幕实时切换 |
| 同 `id` 重复 `addCue` | 无操作（`cues` 不涨）→ liveQuery 重复触发安全 |
| key 重挂 + 强制 `showing` | 轨清空、DOM 清空、可重灌新 cue |

关键细节：**不要给轨 `src`/`content`**。给 src 的话 `#load()` 是异步的，加载完成时 `this.#cues = cues`（来自空 VTT）会**把刚 addCue 进去的 cue 覆盖掉**；无 src 时构造函数同步把 `readyState` 置 2，没有这个竞态窗口。

### 3. `removeCue` 不能用

vidstack 的 `addCue` 有 `instanceof TextTrackCue` 守卫（原生 `VTTCue` 通过，不会转发到原生 `<track>`），但 `removeCue` **没有守卫**，会无条件 `this[native].track.removeCue(cue)`。而 vidstack 的 `NativeTextRenderer` 会给每条字幕轨都挂一个原生 `<track>` 元素（即便用自绘渲染器），该元素处于 disabled/未加载态 → 抛 `NotFoundError`，并且**跳过后面的 `activeCues` 刷新**，画面上会留下过期字幕节点。

→ 结论：**正常增量路径永远不调 `removeCue`**；「重新生成」这种整轨重置用 **key 重挂**完成（已验证 DOM 干净）。

### 4. 抽音频 / VAD 不是瓶颈（实测）

3 分钟素材（单线程 ORT 下测得）：

| 阶段 | 耗时 | 折算 |
|---|---|---|
| `extractAudio16k` | 0.21s | ≈850x 实时 |
| VAD 首次（含模型加载） | 0.63s | — |
| VAD 热态 | 0.38s | ≈470x 实时 |
| 冷启动合计 | **0.8s** | 1 小时视频约几秒 |

→ 「先抽音频 + VAD 跑完才开始出字」的空窗其实很短，**真正的等待在 ASR 网络请求**。所以本方案的价值集中在 ASR 阶段。

> 备注：多线程 ORT 的 worker 脚本在本机 dev + headless Chrome 下被判定 `ERR_BLOCKED_BY_RESPONSE`，未测到多线程数值；同一环境用单线程可正常跑。疑似本地/headless 环境现象，建议另行在真实浏览器确认，与本设计无关。

### 5. 并发完成顺序

`adaptivePool` 按 `idx` 派发、完成后回调，`done` 只用于进度文案 → 完成顺序天然可能乱。显示层按 `idx`（即时间）排序即可完全无感，画面字幕用绝对时间，与到达顺序无关。

## 二、方案选型

| 做法 | 结论 |
|---|---|
| ① Dexie liveQuery 增量显示（列表） | **采用**。与现有断点续做天然一致，离开再回来即可见已转部分 |
| ② 流水线回调把段推给面板 | 否。耦合更紧，刷新后仍要读库，没有额外收益 |
| ③ 自绘字幕层替代 vidstack 轨 | 否。等于重做一套字幕渲染（字体/位置/字号变量/示例态），现有轨够用 |
| ④ 换 `<Track src>` + 手动置 showing | 否。虽能修，但每 1–2s 重建轨 + 重拉重解析整份 VTT，长视频在 iPad 上白白吃性能，且中间有空白窗口 |
| ⑤ **常驻单轨 + 增量 `addCue`** | **采用**（原方案一的播放器轨部分按实测替换为这个） |

## 三、数据流

```
runTranscription（不改）
  每段 ASR 成功 → db.segments.modify({ text, status:1, cues })   ← 已经是逐段写
        │
        ├─→ SubtitlePanel: liveQuery(db.segments.where('videoId').equals(id).sortBy('idx'))
        │        → filter(status===1 && text) → segments[]
        │        → 展开为展示用 cue（splitIntoCues，带缓存）
        │        → 列表渲染（按 idx / 时间，天然有序）
        │
        └─→ onSegmentsChange(cues) → Player.segments
                 → effect：同步到常驻字幕轨（addCue，按 id 幂等）
                 → effect：算 hasSubtitles 门控下游面板
```

要点：
- **不需要改 `transcribe.ts`**。它已经在 ASR 前把整批 pending 行写库（`status: 0`），成功后逐段 `modify`。
- 列表订阅用 `.sortBy('idx')`，完成顺序乱不影响展示顺序。
- 首次 `liveQuery` 发射时库里已有的 `status===1` 段会一次性出现 → 覆盖「离开再回来」。

## 四、播放器字幕轨（核心改动）

`src/pages/Player.tsx`：

**a. 常驻轨，无 src、带固定 id**

```tsx
const SUBS_TRACK_ID = 'live-subs';   // 模块级常量
const [trackReady, setTrackReady] = useState(false);   // 首次有完成段后置 true，只置不撤
useEffect(() => { if (segments.length > 0 && !trackReady) setTrackReady(true); }, [segments.length, trackReady]);
```
```tsx
<MediaProvider>
  {trackReady && <Track id={SUBS_TRACK_ID} kind="subtitles" label="中文字幕" default />}
</MediaProvider>
```
- 不设 `src`/`content`：无 src 时 vidstack 构造函数同步把 `readyState` 置 2，没有「异步 load 完成时
  `this.#cues = cues` 覆盖掉刚 addCue 进去的 cue」的竞态。
- `id` 必须显式给：`NativeTextRenderer` 会把轨的 id 写到它创建的原生 `<track>` 上，而 `MediaProvider`
  的 `Tracks` 观察器会把「没登记的 `<track>` 元素」当成新轨补进列表（id 为空时用
  `vds-vtt-subtitles-<src>` 另生成一个）。不给 id 就会累积幽灵轨，`toArray().find(kind)` 还可能挑错。
- **整轨全程不重建**（没有 `key` 切换）—— 见下面「关键坑 2」，重建轨会让画面字幕永久卡在旧内容。

**b. cue 同步 effect**

```tsx
const cueStoreRef = useRef(new Map<string, VTTCue>());   // 我们灌过的 cue：id → cue 对象

const syncTrack = useCallback((list: Cue[]) => {
  const textTracks = playerRef.current?.textTracks;
  const track = textTracks?.getById(SUBS_TRACK_ID) ?? textTracks?.toArray().find((t) => t.kind === 'subtitles');
  if (!track) return;
  const store = cueStoreRef.current;
  const keep = new Set<string>();
  for (const c of list) {
    if (!c.id) continue;
    keep.add(c.id);
    if (store.has(c.id)) continue;              // 已灌过 → 跳过（liveQuery 会反复全量触发）
    const cue = new VTTCue(c.start, c.end, c.text);
    cue.id = c.id;
    try { track.addCue(cue as never); store.set(c.id, cue); } catch { /* 单条异常不影响其余 */ }
  }
  // 已不在计划里的旧 cue（重新转写后内容变了 → id 变了）：推到不可达时间点让它失效
  for (const [id, cue] of store) {
    if (keep.has(id)) continue;
    cue.startTime = CUE_DISABLED_TIME;          // 1e9
    cue.endTime = CUE_DISABLED_TIME;
    store.delete(id);
  }
  if (track.mode !== 'showing') track.mode = 'showing';
}, []);

useEffect(() => { if (trackReady) syncTrack(segments); }, [trackReady, segments, syncTrack]);
```
- cue 的 **id 由内容算出**（`cueKey(start,end,text)`，FNV-1a 32 位，见 `src/utils/cues.ts`）：
  内容没变 → 同 id → `addCue` 幂等；重新转写后内容变了 → id 变了 → 作为新 cue 加入。
  这样**不需要检测「重新生成」、也不需要重建轨**。
- 旧 cue 用「推离时间轴」而不是 `removeCue`：vidstack 的 `removeCue` 会无条件向原生 `<track>` 转发
  （`addCue` 有 `instanceof TextTrackCue` 守卫、`removeCue` 没有），原生轨未加载时抛 `NotFoundError`，
  并且跳过后面的 `activeCues` 刷新，画面反而留过期字幕。
- 末尾强制 `showing` 是必需的：`TextTrackList` 的 `#defaults` 用归一化后的 `'captions'` 作 key、`remove()`
  却按 `track.kind`（`'subtitles'`）查，默认轨引用永不清理 → 首次挂载之外不保证自动选中。
  已 showing 时这行是空操作。

**c. 删掉 `vttUrl`**

`const vttUrl = useMemo(...)` 及其 revoke effect 整段删除 —— 不再需要为每次更新造 blob URL。

**d. 门控下游面板**

```tsx
const [subsRunning, setSubsRunning] = useState(false);   // 由 SubtitlePanel 上报
const hasSubtitles = segments.length > 0 && !subsRunning;
```
- 转写进行中 → `false`（讲义 / 弹幕 / 卡片按钮保持禁用，符合「不要拿半份字幕去生成」）。
- 本轮结束后 → `true`。
- **刻意不用 `video.status`**：若用户在转写中刷新页面，`status` 会永久停在 `'transcribing'`（转写任务在内存里，刷新即中断），面板会被永久锁死。用「已完成段数 > 0 && 本轮未在跑」可以自然避开这个坑，且与现状语义一致（`segments.length > 0`）。

### 关键坑（实现期实测，都踩过）

1. **换 `<Track src>` 不可行**，见「实测结论 1」。同一 player 会话内 Track 卸载再挂载也踩同一个坑。
2. **重建轨 = 画面字幕永久卡死**。`TextRenderers` 只在收到「列表级 mode-change」时才重新绑定渲染器，
   而 `CaptionsTextRenderer.changeTrack(null)` 第一行是 `if (!track || this.#track === track) return;`
   —— 传 null 是 no-op，旧字幕节点不会被清。于是「移除旧轨 → 挂新轨」之后渲染器仍绑在**已移除**的旧轨
   上，后续 `addCue` 只进新轨，画面再也不更新（实测连续 1.2s 内 `.vds-captions` 连一次 DOM 变更都没有），
   直到整页刷新。→ 所以整轨一次都不重建。
3. **不要用 `removeCue`**，原因见 b。
4. **`<Track>` 必须显式给 `id`**，原因见 a。
5. `kind / label / default / id` 必须恒定：`createTextTrack` 的 `useMemo` deps 是 `Object.values(init)`，
   任一值变化就会重建轨，直接撞上第 2 条。
6. `player.textTracks` 可能在 list 里同时存在多条同名轨（幽灵轨），一律用 `getById(SUBS_TRACK_ID)` 定位。
7. **原生 `VTTCue` 要手动补 `positionAlign = 'auto'`，否则画面字幕不居中**（修复于同日）。
   - 现象：字幕框只占视频**左半边**，文字看着偏左；`.vds-captions [data-part='cue-display']` 上实测
     `--cue-width: 50%`、`--cue-left: 0%`（居中时应为 `100%` / `0%`）。
   - 成因：Chrome 没实现规范里的 `VTTCue.positionAlign`（实测返回 `undefined`），而 vidstack 自绘字幕
     用的 `media-captions` 正是靠它算宽度：

     ```js
     function computeCuePositionAlignment(cue, dir) {
       if (cue.positionAlign === 'auto') { /* 按 cue.align 推导 */ }
       return cue.positionAlign;            // ← 原生 cue 在这里返回 undefined
     }
     // L(cue)：
     let maxSize = position;                                    // position = 50（center + position:auto）
     if (pa === 'line-left') maxSize = 100 - position;
     else if (pa === 'center' && position <= 50) maxSize = position * 2;   // ← 只有这条能到 100
     const size = cue.size < maxSize ? cue.size : maxSize;      // pa 为 undefined → 50
     ```
     `pa` 是 `undefined` 时三条分支全不命中 → `maxSize` 停在 `position = 50` → `--cue-width: 50%`。
   - 为什么之前没事：`media-captions` 自己那套 `VTTCue extends window.VTTCue` 有类字段
     `positionAlign = 'auto'`，所以**解析 VTT 得到的 cue 天然带这个属性**；换成 `addCue` 原生 cue 后丢了。
   - 修法：`cue.positionAlign = 'auto'`（在 `syncTrack` 里紧跟 `new VTTCue(...)` 之后）。
   - 回归断言：`scripts/e2e-live-subs.mjs` 第 4 步新增「cue 节点中心 == `.vds-captions` 容器中心」。

## 五、字幕面板（`src/components/SubtitlePanel.tsx`）

**a. `reload()` → `liveQuery`**

```tsx
useEffect(() => {
  const sub = liveQuery(async () =>
    (await db.segments.where('videoId').equals(videoId).sortBy('idx')).filter((r) => r.status === 1 && r.text),
  ).subscribe({ next: setSegments, error: (e) => setErrorText(formatCaughtError(e)) });
  return () => sub.unsubscribe();
}, [videoId]);
```
- 删除手动 `reload()` 调用（`start()` 的 `finally` 里不再需要）。
- `liveQuery` 在项目里已有先例（`DanmakuLayer.tsx` 订阅弹幕表），属既有模式，不是新依赖。

**b. cue 展开加缓存**

`segments` 每次都是新数组，`cues` 的 `useMemo` 会对**全部**段重跑 `splitIntoCues` → 每来一段 O(n) 重算，长视频是 O(n²)。加一层按段缓存：

```tsx
const cacheRef = useRef(new Map<number, { sig: string; cues: Cue[] }>());
const cues = useMemo(() => segments.flatMap((s) => {
  const sig = `${s.start}|${s.end}|${s.text.length}|${s.cues?.length ?? 0}`;
  const hit = cacheRef.current.get(s.id!);
  if (hit?.sig === sig) return hit.cues;
  const out = s.cues?.length
    ? s.cues.flatMap((c) => splitIntoCues(c.start, c.end, c.text))
    : splitIntoCues(s.start, s.end, s.text);
  cacheRef.current.set(s.id!, { sig, cues: out });
  return out;
}), [segments]);
```

**c. 转写中的视觉反馈**

进度条（`phase/done/total`）不变；额外把当前已落库的段数显示出来（如「转写中 37/210 · 已可看 36 段」），让「边转边显」可感知。`running` 变化通过新增回调 `onRunningChange` 上报给 Player（用于门控）。

**d. 导出按钮**

`VTT / SRT` 继续导出「当前已完成的 cue」，转写中可导出半份（有明确文案提示即可）。

## 六、边界与错误

| 场景 | 行为 |
|---|---|
| 转写中离开再进播放页 | liveQuery 首次发射即呈现已完成的段；`runTranscription` 已中断，需要重新点生成（续做，跳过已完成段） |
| 转写中刷新 | 同上（现状即如此）；因门控不依赖 `status`，不会被锁死 |
| 单段 ASR 失败 | 该段保持 `status:0`，列表不显示、画面无字，不影响其他段 |
| VAD 结果与已有数据差异 >20%（`planMismatch`） | 上游清表 → 新段的 cue id（内容寻址）全部变化 → 旧 cue 被推离时间轴失效、新 cue 加入，画面不残留旧字幕（**不重建轨**，原因见四·关键坑 2） |
| 文件已删（`fileMissing`） | 无播放器，字幕轨不渲染；列表/导出照常增量 |
| 并发顺序乱 | 列表按 `idx` 排序；画面字幕用绝对时间 |
| 完成顺序导致 `activeIdx` 跳变 | 「自动滚动到当前字幕」已有 effect，跟随 `activeIdx`；新增段不会把视图顶走（`scrollIntoView block:'nearest'`） |

## 七、性能

- 每段落库触发一次 liveQuery 重跑（读该视频全部段）+ 一次 cue 重算（有缓存后只算新段）+ 一次 `addCue`（**O(1)**，只加新 cue，不重建轨、不重拉 VTT）。
- 对比「换 src」方案：省掉每段一次 blob 创建 + 一次完整 VTT fetch + 一次完整解析，长视频差异明显。
- `Player` 每次都会重渲染，但 `layoutSlots` 已 memo、`MediaPlayer` props 稳定、`Track` 的 `useMemo` deps 不变 → 不会重建播放器或字幕轨。

## 八、测试

新增 `scripts/e2e-live-subs.mjs`（**需 `npm run dev`（5173）**，无需 API key）：

```
TEST_FILE=/path/to/video.mp4 node scripts/e2e-live-subs.mjs
```

为什么不用常规的 preview(4173)：Dexie `liveQuery` 只感知经由 Dexie 的写入，原生 IndexedDB 写入不会
触发（实测）。dev 下可以用模块 URL `import('/src/store/db.ts')` 拿到应用正在用的那个 db 实例，
按「每完成一段就写一次库」的节奏逐段写 `segments`；生产构建里该模块已打包，拿不到句柄。

7 个阶段、24 条断言：

1. 导入视频进播放页；
2. 初始无字幕 → 三个下游面板按钮 disabled + 显示「请先在字幕页生成字幕」；
3. 播放中逐段写入（每段间隔 0.9s）→ 列表条数每段 +1、**播放不中断**（`paused === false`）、按 idx 有序；
4. seek 到每段时间 → `.vds-captions` 文本含该段内容（**本次改动的核心断言**）；
5. 停止写入 → 三个下游面板解锁；
6. 清表后写入内容不同的样本（同 idx / 同时间）→ 列表归零、画面清掉旧字幕、只显示新内容（覆盖「重新生成」路径）；
7. 点「生成字幕」进入转写中 → 已有字幕也不解锁下游面板（环境里转写立即结束则跳过，不算失败）。

## 九、不做（YAGNI）

- 不做流式 ASR（接口本身是整段返回，改不了）；
- 不做「按完成顺序插到列表底部」的另一套排序（按时间排即可，乱序对用户无意义）；
- 不做画面字幕的自绘层（现有轨 + `addCue` 已验证足够）；
- 不做转写进度与 `video.status` 的强绑定（见四·d 的刷新坑）；
- 不顺手改「重新生成字幕」的语义 —— 附带发现：当前该按钮对已完成的段会全部跳过，实际是「校验/续做」，只有 VAD 结果差异 >20% 才会真重做。是否改成「强制重转」另行讨论。

## 十、改动清单

| 文件 | 改动 |
|---|---|
| `src/pages/Player.tsx` | 删 `vttUrl`；加常驻 `<Track id="live-subs">`（无 src）+ `syncTrack` 增量灌 cue + 旧 cue 推失效；`hasSubtitles` 改为 `segments.length>0 && !subsRunning` |
| `src/components/SubtitlePanel.tsx` | `reload` → `liveQuery` 订阅；cue 展开加缓存（按段）；cue id 改为内容寻址；新增 `onRunningChange` 上报；按钮文案 `转写中…`、进度文案加「已可看 N 条」 |
| `src/utils/cues.ts` | 新增 `cueKey()`（FNV-1a 内容指纹） |
| `src/utils/vtt.ts` | `Cue` 加可选 `id`（导出 VTT/SRT 时忽略） |
| `src/pipelines/transcribe.ts` / `src/store/db.ts` | 不改 |
| `scripts/e2e-live-subs.mjs` | 新增 |
| `scripts/e2e-danmaku.mjs` | 顺带修：antd 6 已删除 `.ant-tabs-tabpane-active` 类，该选择器恒为 0 导致弹幕用例长期失败；改为 `[role="tabpanel"]:visible` |
| `README.md` | 字幕功能描述补「转写中边转边显」；测试清单补新用例 |

## 十一、落地结论（2026-09-10）

- 已实现并验证：
  - `npx tsc -b` 通过；`npm run build` 通过。
  - `TEST_FILE=... node scripts/e2e-live-subs.mjs` → 25/25 断言通过（含新增的画面字幕居中）。
  - 回归：`e2e-resume`（断点续播）、`e2e-player-enhance`（倍速/双击/字幕字号/窄屏折叠）通过；
    `e2e-danmaku` 在修掉失效选择器后全通过（修前在原代码上同样失败，与本次改动无关）。
  - 未覆盖：真实转写下的端到端（需 `SF_KEY`）——`e2e-smoke` 仍是那条链路的用例。
- 同日补丁：修「画面字幕不居中」（`cue.positionAlign`，见四·关键坑 7）。

实测结论仍然成立：抽音频 ≈850x 实时、VAD 热态 ≈470x 实时，静默期很短；等待集中在 ASR。
