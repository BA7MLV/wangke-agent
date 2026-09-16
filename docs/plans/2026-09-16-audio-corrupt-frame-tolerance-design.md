# 抽音频的坏帧容忍（Audio corrupt-frame tolerance）

**状态：已实现 + 已验证**（2026-09-16）。变更：新增 `src/media/tolerantDecode.ts`，改写 `src/media/audio.ts`、
`src/media/extractWorker.ts`、`src/media/extractClient.ts`、`src/media/pcm.ts` 的重采样，新增回归用例
`scripts/e2e-audio-corrupt-frame.mjs` 与 `scripts/test-pcm-resample.mjs`。

## 起因：线上报的一条「Decoding error」

用户在 `wangke-agent.pages.dev` 上拿到：

```
Decoding error.
Error: Decoding error
    at new zwe (…/assets/index-C1lHE3s9.js:317:8053)
    at Uwe._createDecoder (…:317:12310)
    at async …:317:3959
```

**这串栈是假的**：mediabunny 在 `new AudioDecoder()` 之前先 `const stack = new Error('Decoding error').stack`，
解码失败时把真实 error 的 `stack` **覆盖**掉（它注释里写明「默认栈很难看」）。所以三帧只能读出「解码器在哪创建」，
真实原因在 `err.message`（Chrome 的 `EncodingError: Decoding error.`；Safari 是 `InternalAudioDecoderCocoa decoding failed`，
Firefox/Chromium 之外的文案都不同——这也是判断浏览器的线索）。

对着本机 `dist/`（哈希与线上一致）反查压缩产物可以确定调用链：
`class zwe extends ZQ{constructor(e,n,r,i)` + `new AudioDecoder(...)` = `AudioDecoderWrapper`；
`hd.includes(i.codec)?new jwe(…):new zwe(…)` = `AudioSampleSink._createDecoder`（源 `media-sink.ts:2464`）。

栈落在 `index-*.js` 而不是 `extractWorker-*.js` ⇒ 这次跑的是**主线程回退路径**：Worker 里先失败一次，
`extractClient` 按 `retryable` 回退，主线程把整个文件又解了一遍，然后同样失败。

## 根因（实测）

样片 `~/Downloads/申论1-1.MP4`（91 分钟网课，h264 + AAC-LC 44.1kHz 立体声）：

| 检查 | 结果 |
| --- | --- |
| `ffmpeg -xerror` 全量解音轨 | 报 `[aac] invalid band type` **1 处** |
| 二分定位 | 出错的包在音轨 **584.4927s**（9:44） |
| ffprobe 235144 个包 | 时间戳零跳跃、尺寸分布正常 —— 只有这一帧内容坏 |
| 浏览器探针（mediabunny 直跑） | 解到 `lastEnd=584.4695`（正好是坏帧前一帧）抛 `EncodingError` |
| `申论1-2.MP4` 对照 | 干净，不报错 |

**致命性来自 WebCodecs 而不是文件**：规范规定「解码出错 → `Close(AudioDecoder)` + `EncodingError`」，
**一帧坏就废掉整个解码器**；ffmpeg / 播放器只是丢掉那一帧继续。所以「视频能在浏览器里正常播」
不代表「抽音频也能过」。

## 方案

`src/media/tolerantDecode.ts` 提供 `extractAudio16kFromTrack(track, opts)`（主线程与 Worker 共用）：

1. 正常迭代 `AudioSampleSink.samples()`，逐样本转 16kHz 单声道 s16；
2. 捕获**解码器类**错误（`EncodingError` / message 含 decode；`InputDisposedError` 直接抛）后，
   丢掉废掉的 sink，**在同一个 Input/track 上换一个新 sink**，从「最后一个成功样本的结束时间 + ∆」续解；
3. 缺掉的这段时间**补零（静音）**，并把游标推进 —— 时间轴不漂，VAD 会把静音忽略掉；
4. ∆ 先取 0.05s（实测一个坏帧 0.05 就够越过），**本次尝试毫无进展就逐级加大**（0.05/0.2/0.5/1/2/5/10s）；
5. 上限：连续无进展 > 7 次、总续解 > 24 次、累计补零 > 30s、或续解点已越过片尾 → 抛 `AudioDecodeError`
   （**中文可读**：`音轨第 9:44 处有损坏的音频帧（浏览器解码器：EncodingError: Decoding error.）…建议重新下载或 ffmpeg 转码`）。

配套：
- `extractClient` 把解码错误当作**不可回退**（换线程结果一样，别白解两遍），Worker 侧同样给 `retryable: false`；
- 续解发生时通过进度回调带一句 `已跳过第 N 处损坏帧`，转写面板能看见；
- 主线程回退路径改用 `AudioSampleSink`（原来用 `AudioBufferSink`），**两个线程第一次真正共用同一份抽音频实现**
  （`AudioBufferSink` 内部要 `new AudioBuffer`，Worker 里没有 Web Audio，没法共用）；`pcm.ts` 里随之删掉
  只服务于 AudioBuffer 的 `mixToMono`。

## 验证

**真机端到端**（`scripts/.cache/run-probe-app.mjs`，跑 esbuild 打包的真实 `src/media/audio.ts`）：

| 样片 | 结果 |
| --- | --- |
| 申论1-1.MP4（坏） | `ok=true`，`recoveries=1`，`skipped=0.046s`，`at=584.4695`，整条 91 分钟 **10.9s** 解完 |
| 申论1-2.MP4（好） | `recoveries=0`、`skipped=0`（不能把正常文件也当坏的） |

**回归用例** `node scripts/e2e-audio-corrupt-frame.mjs`（已登记进 `e2e-all` 的 META，`service: 'none'`）：
ffmpeg 造 60s AAC → 找到 30.000s 的那个包**涂成 0xFF** → 断言坏文件能解完且时长正确、干净文件 `recoveries=0`。
已验牙齿：把 `MAX_RECOVERIES` 改成 0，用例变红且错误信息准确指出「音轨第 0:30 处」。

**e2e**：`e2e-audio-corrupt-frame`（新）、`e2e-bg-transcribe`（dev，进度能走到「语音端点检测中…」——
说明 Worker 里的抽音频已经成功返回）、以及库页/播放页/移动端等既有用例见当日日志。

## 顺带修掉的时间轴漂移（原「已知遗留」，已修）

**症状**：PCM 时间轴比媒体短。91 分钟的片子解出 5452.402s，媒体 5460.017s，**短 7.6s（0.139%）**。
**原因**：`resampleTo16kS16` 对**每个 AAC 帧独立**重采样并用 `floor()` 截断——
每帧 1024 源样本 @44.1k 精确应得 371.51 个 16k 样本，`floor` 只出 371 个，
每帧丢 0.52 个样本 × 235144 帧 ≈ 122048 样本 ≈ 7.6s。长视频后期字幕因此**线性偏早**。

**改法**：给 `resampleTo16kS16` 加第三参 `srcStartSeconds`（本段在媒体时间轴上的起点），
输出按 **1/16000 的全局网格**取区间 `[ceil(start*16000), ceil(end*16000))`，
插值位置也按全局网格算（`pos = (j - start*16000) * ratio`）。调用方（`tolerantDecode` 的 `sampleToS16`）
必须传 `sample.timestamp` —— 用真实时间戳而不是自己累加长度，这样容器里有真实间隙时也不会越漂越远。

| 验证 | 结果 |
| --- | --- |
| 真机 91 分钟坏文件 | `pcmSeconds = 5460.037`（媒体 5460.017，**+0.02s**；修前 −7.615s） |
| `scripts/test-pcm-resample.mjs` | 长度守恒、相位对齐、误差不累积、16k 直通、非整格起点，5/5 通过 |
| 残差量级实测 | 0.2min→0、1min→1.7、10min→1.8、91min→62 个样本（**3.9ms**），不随长度线性增长 |
| 验牙齿 | 把实现换回 `floor(input.length/ratio)` → 3 项变红（短 1342 个样本） |

残余的毫秒级抖动来自「每帧 ceil 边界偶尔多 1 个样本」（`sample.timestamp` 与 `start + len/ratio`
两条计算路径在整数边界上的浮点差异），量级比 VAD/ASR 的分辨率低两个数量级，不再处理。
