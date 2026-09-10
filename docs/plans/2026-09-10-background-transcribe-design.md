# 后台转写（任务外置 + 断点续跑 + Worker 卸载）

- 状态：设计中 → 实现中
- 日期：2026-09-10
- 涉及：`src/pipelines/transcribe.ts`、新增 `src/store/jobs.ts` / `src/pipelines/transcribeQueue.ts` / `src/media/extractWorker.ts` / `src/media/extractClient.ts` / `src/media/pcm.ts`、`src/components/SubtitlePanel.tsx`、`src/pages/Library.tsx`

## 1. 背景与问题

用户诉求：「切到别的视频，另一个视频还能继续加载字幕吗？」

现状（`runTranscription` + `SubtitlePanel`）：

1. 转写本身是一个纯 async 流水线（抽音频 → VAD → ASR → 写 `segments`），不依赖组件存活，**切走确实还在跑、还在写库**。
2. 但进度 `progress` 是 `SubtitlePanel` 的 `useState`：
   - `/player/:id` 换参（切到另一个视频）时 Player 不卸载 → 面板上挂着**上一个视频**的进度条；
   - 回资料库再进来（组件卸载）→ 进度归零，按钮变回「生成字幕」，再点一次 = **同一视频两份并发**（`segments` 索引 `++id, videoId, idx` 无唯一约束，会写重行，API 双倍消耗）。
3. 刷新/关页 → 任务彻底丢失，`videos.status` 停在 `transcribing`（此前面板门控已刻意不依赖 status，见 MEMORY）。
4. 抽音频走 WebCodecs、VAD 走 ORT，都在页面线程，与正在播放的另一个视频争抢 CPU/带宽。

目标：任务状态与 UI 解耦，做到「切视频、切页面不掉进度」「刷新后能续跑」「不抢当前播放的资源」。

## 2. 分层方案

### L1 任务状态外置

新增 `src/store/jobs.ts`（zustand，**不持久化**——它是内存中的运行时状态）：

```ts
type JobPhase = 'queued' | 'extract' | 'vad' | 'asr' | 'done' | 'error' | 'canceled';
interface TranscribeJob {
  videoId: string;
  phase: JobPhase;
  message: string;
  done: number; total: number;
  error?: string;
  resume: boolean;   // 是否由续跑扫描发起
}
jobs: Record<string, TranscribeJob>;
queue: string[];     // 等待中的 videoId（L3 串行）
activeId: string | null;
```

- `SubtitlePanel` 不再持有 `progress`，改为 `useTranscribeJob(videoId)` 订阅；`start()` 调 `startTranscription(videoId)`。
- **幂等吸附**：`startTranscription(id)` 若该 id 已有 `queued | extract | vad | asr` 的 job，直接返回，不再起第二份。面板/资料库/续跑扫描三个入口共用这一条路径。
- 取消：`cancelTranscription(id)`；未开始的直接从队列移除。

### L2 断点续跑

- 转写开始时 `db.videos.update(id, { status: 'transcribing' })`（已有），正常完成写 `transcribed`，失败写 `error`，**取消**写 `transcribed`（已有完成段，可用）或 `new`（一段都没完成）。
- 启动时 `resumePendingTranscriptions()`：扫 `status === 'transcribing'` 的视频 → 视频文件仍存在 → 自动入队续跑 + toast 说明。流水线本身已支持续做（`status=1` 的段跳过、`planMismatch` 兜底），无需额外状态。
- 只认 `transcribing` 这一个状态：它是「用户发起过且没跑完」的唯一证据，不必另开 job 表。
- 不做「关页后继续」：没有 SW / Background Sync 能保证，浏览器会直接杀掉，不做承诺。

### L3 排队 + Worker 卸载

- **串行队列**：全局同时只跑一个转写（`activeId`），其余排队。理由：抽音频 + VAD 是重 CPU，多视频并行只会互相拖慢，且 ASR 侧已有 `AdaptiveLimit` 做并发。
- **Worker**：新增 `src/media/extractWorker.ts`（`type: 'module'`），一次做完「解码 → 混音 → 重采样 16k s16 → VAD 分段」，回传 `{ pcm: ArrayBuffer, segments }`（pcm 走 transfer 零拷贝）。

  **关键约束（已验证）**：mediabunny 的 `AudioBufferSink` 内部 `new AudioBuffer(...)`，Web Audio 在 Worker 中不可用 → 必须用 `AudioSampleSink` + `sample.copyTo(dst, { format: 'f32-planar' })`，绕开 `AudioBuffer`。混音/重采样的纯函数抽到 `src/media/pcm.ts`，worker 与主线程回退路径共用。
- **回退**：worker 创建失败、`error` 事件、或首次执行抛错 → 自动回退到主线程 `extractAudio16k + segmentAudio`（并把是否走了 worker 记到 `console.debug`，便于实测记录）。
- **取消**：`extract/vad` 阶段 → `worker.terminate()` 并懒重建（下次转写重新加载 VAD 模型）；`asr` 阶段 → 主线程 cancel 标记，每段派发前检查并抛 `CancelError`，`adaptivePool` 收到后整体停下，外层按 canceled 处理（不弹错误、不写 `error` 状态）。
  - 已知限制：**回退到主线程的那条路径上，VAD 是同步 wasm 循环，取消只能等它跑完**（没有 Worker 可 terminate）。生产档走 Worker 不受影响。
  - ASR 的指数退避（1s/2s/4s）也会拖慢取消，因此 `withAdaptiveRetry` 增加 `shouldAbort`：每次退避 sleep 后检查一次，取消响应从「最长 7s/段」降到「当前 sleep 结束即停」。
- Wake Lock 由队列层统一持有：第一个任务开始时 `acquire`，队列排空后 `release`（现有 `wakeLock.ts` 是单 sentinel + wanted 标志，配对使用即可，不改）。

## 3. 不改的东西

- `segments` 表结构与 Dexie schema 版本**不动**：靠 job 幂等 + 事务内 existing 检查防重，避免为唯一索引升版牵动迁移测试。
- 面板 e2e 契约（`subs-generate` / `subs-progress` / `subs-list` / `[role="tabpanel"]`）保持不变。
- `hasSubtitles` 门控仍不依赖 `video.status`（转写现在可能在别的视频上跑，更不能用 status 判断）。

## 4. 实测结论（2026-09-10）

1. **mediabunny 在 Worker 里能跑，但必须绕开 `AudioBuffer`**：`AudioBufferSink.buffers()` 内部走
   `new AudioBuffer(...)`（见 `node_modules/.../sample.js` 的 `toAudioBuffer`），Web Audio 在 Worker
   中不存在，一调用就抛。改用 `AudioSampleSink.samples()` + `copyTo(buf, { planeIndex, format: 'f32-planar' })`
   直接取平面 PCM —— e2e 实测抽取阶段正常完成（面板走到了 VAD）。Vite 会把 worker 打成独立
   chunk（`dist/assets/extractWorker-*.js`）。
2. **ORT/VAD 在 dev(5173) 下依旧卡死**（与既有记录一致：多线程 wasm 被 block）。副作用是任务会
   长期停在 `vad`，正好被拿来验证「切页面/刷新时进度还在不在」。生产档待真机验证。
3. **`videos.status` 不是索引**（schema 里 videos 只索引了 `id, createdAt`），续跑扫描不能用
   `where('status')`（会抛 SchemaError），只能 `db.videos.filter(...)` 全表过滤。
4. **dev 下拿不到与页面共享的 zustand 实例**：`page.evaluate(() => import('/src/store/jobs.ts'))`
   取到的 store 与页面里那个不是同一个（Vite 给模块 URL 加了版本戳）。所以 e2e 一律走真实 UI 路径
   触发任务，不直接戳 store。
5. **转写中的「生成」按钮是 loading 态，mdui 会让它不可点** —— 幂等吸附在 UI 上天然成立，
   连点也点不动；队列层面的 `startTranscription` 仍保留幂等判断（续跑扫描等入口也要靠它）。

## 5. 验收

1. A 视频点生成 → 切到 B 视频 → B 的字幕面板不显示 A 的进度；回 A → 进度条接着走、按钮仍是「转写中…」，再点不会起第二份。
2. A 转写中回资料库 → 列表卡片显示「转写中 n/m」，回播放页进度仍在。
3. 转写中刷新页面 → 重新进入后自动续跑（已完成段不重复计费）。
4. 取消按钮能停（asr 段最多多跑在途那几个请求，已完成的段保留）。
5. 转写 A 时播放 B 不掉帧（主观 + 主线程长任务显著减少）。
6. `npm run build` 通过；`scripts/e2e-live-subs.mjs` 等字幕相关 e2e 不回归。

已自动化的是 1–4：新增 `scripts/e2e-bg-transcribe.mjs`（dev 档，不需 API key，8 项断言全绿）。
它注入假 key + 不可达 baseUrl，让任务停在抽音频/VAD 阶段从而长期存活，再切页面、刷新、取消。
剩下的 5（播放流畅度）与真实 ASR 全链路仍需 `SF_KEY` 跑 `e2e-smoke` 或真机确认。
