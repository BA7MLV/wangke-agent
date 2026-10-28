// 用 mediabunny 把 B 站 DASH 的视频 m4s + 音频 m4s 重封装（remux）成单个 mp4。
//
// 关键点：
//  - 全程不重新编码，仅做容器层重打包（EncodedPacket 级别直通），速度快、不丢画质。
//  - 输出目标用 StreamTarget 直接对接 OPFS 的 FileSystemWritableFileStream，
//    不在内存里攒整文件（大网课视频可能 1GB+），配合 fastStart:'reserve' 支持随机写。
//    注意：StreamTarget 写下来的是 { type:'write', data, position } 分片（正好兼容 OPFS 的
//    WriteParams），不是裸字节，接收端必须按 position 落位（能覆盖写）。
//  - 每路流只持有「当前一小段」字节，读完一个完整 m4s 后立即释放，峰值内存可控。
//
// mediabunny 的两条硬约束（踩过坑）：
//  1. 所有 addVideoTrack/addAudioTrack 必须在 Output.start() 之前调用，start() 之后再加轨会抛
//     「Cannot add track after output has been started or canceled.」；
//  2. fastStart:'reserve' 要求每条轨道都提供 maximumPacketCount，否则 start() 时抛错。
//     因此这里在 start() 之前先把两路 m4s 打开、取 codec、数包，再建输出。
//
// 该模块依赖浏览器 WebCodecs/OPFS（FileSystemWritableFileStream），无法在无 DOM 的
// Node 里做有意义单测，故其验证走 e2e（见 scripts/e2e-bilibili-remux.mjs）。
// 这里的纯逻辑（URL 拼装、进度权重）抽成独立函数以便单测。

import {
  ALL_FORMATS,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input as MediaInput,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny';
import { biliRequest, buildProxiedUrl } from './transport';

export { buildProxiedUrl };

export interface RemuxProgress {
  /** 0..1，下载阶段与封装阶段的合并进度（下载占 0.85，封装占 0.15） */
  (ratio: number): void;
}

export interface RemuxResult {
  /** 实际写入字节数 */
  bytes: number;
}

// 进度权重：下载是大头，封装（重打包已下载的字节）相对快
const DOWNLOAD_WEIGHT = 0.85;

export interface DownloadJob {
  url: string;
  /** 该路在总下载进度中的占比（视频通常远大于音频，由调用方按 content-length 估算） */
  weight: number;
}

/**
 * 经油猴桥或代理下载一路流到 Blob（流式读，报进度）。
 * B 站 CDN 必须带 Referer：油猴脚本会注入；代理则由 Worker 转发时注入。
 */
async function downloadTrack(
  proxy: string | undefined,
  cookie: string | undefined,
  url: string,
  onBytes: (done: number, total: number) => void,
): Promise<Blob> {
  const resp = await biliRequest({ proxy, cookie }, url);
  if (!resp.ok || !resp.body) {
    throw new Error(`下载视频流失败 HTTP ${resp.status}（防盗链或未注入 Referer）`);
  }
  const total = Number(resp.headers.get('content-length') ?? 0);
  const reader = resp.body.getReader();
  const chunks: BlobPart[] = [];
  let done = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    if (value) {
      chunks.push(value);
      done += value.byteLength;
      onBytes(done, total);
    }
  }
  return new Blob(chunks);
}

/** 预先打开好的一路视频输入，含它对应的输出源。 */
interface PreparedVideoTrack {
  input: MediaInput;
  track: InputVideoTrack;
  source: EncodedVideoPacketSource;
  decoderConfig: VideoDecoderConfig;
  /** 包（帧）总数，用于 fastStart:'reserve' 的 maximumPacketCount */
  packetCount: number;
}

/** 预先打开好的一路音频输入，含它对应的输出源。 */
interface PreparedAudioTrack {
  input: MediaInput;
  track: InputAudioTrack;
  source: EncodedAudioPacketSource;
  decoderConfig: AudioDecoderConfig;
  packetCount: number;
}

/** reserve 模式下 moov 预留空间按 maximumPacketCount 估算，留点余量防止边界溢出。 */
const withPacketMargin = (n: number) => Math.max(16, Math.ceil(n * 1.05) + 16);

/**
 * 打开一路 m4s 的视频轨：读主轨道、解码配置、包数，并建立输出源。
 * 必须在 output.start() 之前调用——轨道只能在 start 之前 add。
 */
async function prepareVideoTrack(inputBlob: Blob): Promise<PreparedVideoTrack> {
  const input = new MediaInput({ source: new BlobSource(inputBlob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('m4s 中未找到视频轨道');
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new Error('无法读取视频解码配置（codec）');
    if (!track.codec) throw new Error(`不支持的视频编码：${decoderConfig.codec}`);
    // metadataOnly：只读样本表（moof）不解码，用来数包
    const { packetCount } = await track.computePacketStats();
    return {
      input,
      track,
      decoderConfig,
      packetCount,
      source: new EncodedVideoPacketSource(track.codec),
    };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

/** 同上，音频轨（B 站 DASH 的音频通常是 aac，这里以实际探测到的 codec 为准）。 */
async function prepareAudioTrack(inputBlob: Blob): Promise<PreparedAudioTrack> {
  const input = new MediaInput({ source: new BlobSource(inputBlob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('m4s 中未找到音频轨道');
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new Error('无法读取音频解码配置（codec）');
    if (!track.codec) throw new Error(`不支持的音频编码：${decoderConfig.codec}`);
    const { packetCount } = await track.computePacketStats();
    return {
      input,
      track,
      decoderConfig,
      packetCount,
      source: new EncodedAudioPacketSource(track.codec),
    };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

/**
 * 交错写出两路包：按时间戳归并。
 *
 * 为什么要交错而不是「一路写完再写另一路」：fastStart:'reserve' 下 mediabunny 会在
 * 「所有轨道都收到首个样本」时才创建 mdat/moov；若在此期间某轨已经跑过两次关键帧
 * （processTimestamps 已填好 compositionTimeOffsetTable，但样本还在队列里、samples 为空），
 * 写 moov 时会断言失败（cslg: assert(samples.length > 0)）。按时间戳归并能保证 moov
 * 在第二路首个样本到来时立刻创建，此时第一路最多只处理过 1 个关键帧。
 */
async function pipeInterleaved(
  video: PreparedVideoTrack,
  audio: PreparedAudioTrack | null,
  onPacket?: () => void,
): Promise<void> {
  const videoIter = new EncodedPacketSink(video.track).packets()[Symbol.asyncIterator]();
  const audioIter = audio ? new EncodedPacketSink(audio.track).packets()[Symbol.asyncIterator]() : null;

  let v = await videoIter.next();
  let a = audioIter ? await audioIter.next() : null;
  let vFirst = true;
  let aFirst = true;

  try {
    while (!v.done || (a !== null && !a.done)) {
      let takeVideo: boolean;
      if (v.done) takeVideo = false;
      else if (a === null || a.done) takeVideo = true;
      else takeVideo = v.value.timestamp <= a.value.timestamp;

      if (takeVideo && !v.done) {
        await video.source.add(v.value, vFirst ? { decoderConfig: video.decoderConfig } : undefined);
        vFirst = false;
        onPacket?.();
        v = await videoIter.next();
      } else if (a !== null && !a.done && audio) {
        await audio.source.add(a.value, aFirst ? { decoderConfig: audio.decoderConfig } : undefined);
        aFirst = false;
        onPacket?.();
        a = await audioIter!.next();
      }
    }
  } finally {
    video.source.close();
    audio?.source.close();
  }
}

export interface RemuxOptions {
  proxy?: string;
  cookie?: string;
  videoUrl: string;
  audioUrl: string | null;
  /**
   * 输出写入点：OPFS 文件的可写流（FileSystemWritableFileStream 的写参数形状与
   * StreamTargetChunk 兼容，调用方按需断言类型即可）。写入是「按 position 落位」的，
   * 可能回填靠前的区域，实现方必须支持覆盖写。
   */
  writable: WritableStream<StreamTargetChunk>;
  onProgress?: RemuxProgress;
}

/**
 * 下载 B 站视频/音频流并重封装写入 writable。
 * 调用方负责在完成后关闭/清理 writable（本函数内部会写并 flush，但不关闭句柄所有权）。
 */
export async function remuxBiliToStream(opts: RemuxOptions): Promise<RemuxResult> {
  const { proxy, cookie, videoUrl, audioUrl, writable, onProgress } = opts;

  // ---- 阶段一：下载两路流（合计占 0..DOWNLOAD_WEIGHT）----
  // 先各自下载，再统一封装；下载进度按已完成字节粗报。
  let videoTotal = 0;
  let audioTotal = 0;
  let videoDone = 0;
  let audioDone = 0;
  const report = () => {
    const total = videoTotal + audioTotal;
    const done = videoDone + audioDone;
    const ratio = total > 0 ? done / total : 0;
    onProgress?.(ratio * DOWNLOAD_WEIGHT);
  };

  const videoBlob = await downloadTrack(proxy, cookie, videoUrl, (d, t) => {
    videoDone = d;
    videoTotal = t || videoTotal;
    report();
  });
  const audioBlob = audioUrl
    ? await downloadTrack(proxy, cookie, audioUrl, (d, t) => {
        audioDone = d;
        audioTotal = t || audioTotal;
        report();
      })
    : null;

  // ---- 阶段二：打开两路轨道（必须在 output.start() 之前）----
  const video = await prepareVideoTrack(videoBlob);
  let audio: PreparedAudioTrack | null = null;
  try {
    if (audioBlob) audio = await prepareAudioTrack(audioBlob);
  } catch (e) {
    video.input.dispose();
    throw e;
  }

  // ---- 阶段三：重封装（占 DOWNLOAD_WEIGHT..1）----
  const target = new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'reserve' }),
    target,
  });

  // addTrack 只能在 start() 之前；'reserve' 还要求每轨都给出 maximumPacketCount
  output.addVideoTrack(video.source, { maximumPacketCount: withPacketMargin(video.packetCount) });
  if (audio) {
    output.addAudioTrack(audio.source, { maximumPacketCount: withPacketMargin(audio.packetCount) });
  }

  const bytes = videoBlob.size + (audioBlob?.size ?? 0);

  // 封装阶段进度：按已写入包数占总包数的比例（节流到每 1% 报一次）
  const totalPackets = video.packetCount + (audio?.packetCount ?? 0);
  let writtenPackets = 0;
  let lastStep = -1;
  const reportPackingProgress = () => {
    if (totalPackets === 0) return;
    writtenPackets += 1;
    const step = Math.floor((writtenPackets / totalPackets) * 100);
    if (step === lastStep) return;
    lastStep = step;
    onProgress?.(DOWNLOAD_WEIGHT + (1 - DOWNLOAD_WEIGHT) * (writtenPackets / totalPackets));
  };

  try {
    await output.start();
    // 两路包按时间戳归并直通（顺序很关键，见 pipeInterleaved 注释）
    await pipeInterleaved(video, audio, reportPackingProgress);
    await output.finalize();
  } catch (e) {
    try {
      await output.cancel();
    } catch {
      /* 忽略取消异常 */
    }
    throw e;
  } finally {
    video.input.dispose();
    audio?.input.dispose();
  }
  onProgress?.(1);
  return { bytes };
}
