// 用 mediabunny 把 B 站 DASH 的视频 m4s + 音频 m4s 重封装（remux）成单个 mp4。
//
// 关键点：
//  - 全程不重新编码，仅做容器层重打包（EncodedPacket 级别直通），速度快、不丢画质。
//  - 输出目标用 StreamTarget 直接对接 OPFS 的 FileSystemWritableFileStream，
//    不在内存里攒整文件（大网课视频可能 1GB+），配合 fastStart:'reserve' 支持随机写。
//  - 每路流只持有「当前一小段」字节，读完一个完整 m4s 后立即释放，峰值内存可控。
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
  Mp4OutputFormat,
  Output,
  StreamTarget,
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

/**
 * 把一路已下载的 m4s（Blob）经 mediabunny 解封装，把 EncodedPacket 直通写入输出。
 * 返回该轨道的时长（秒）。
 */
async function pipeTrack(
  inputBlob: Blob,
  output: Output,
  kind: 'video' | 'audio',
): Promise<number> {
  const input = new MediaInput({ source: new BlobSource(inputBlob), formats: ALL_FORMATS });
  try {
    const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    if (!track) throw new Error(`m4s 中未找到${kind === 'video' ? '视频' : '音频'}轨道`);
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new Error('无法读取解码配置（codec）');

    if (kind === 'video') {
      const source = new EncodedVideoPacketSource('avc');
      output.addVideoTrack(source, { frameRate: undefined });
      const sink = new EncodedPacketSink(track);
      let first = true;
      for await (const packet of sink.packets()) {
        if (first) {
          await source.add(packet, { decoderConfig: decoderConfig as VideoDecoderConfig });
          first = false;
        } else {
          await source.add(packet);
        }
      }
      source.close();
    } else {
      const source = new EncodedAudioPacketSource('aac');
      output.addAudioTrack(source);
      const sink = new EncodedPacketSink(track);
      let first = true;
      for await (const packet of sink.packets()) {
        if (first) {
          await source.add(packet, { decoderConfig: decoderConfig as AudioDecoderConfig });
          first = false;
        } else {
          await source.add(packet);
        }
      }
      source.close();
    }
    return input.computeDuration();
  } finally {
    input.dispose();
  }
}

export interface RemuxOptions {
  proxy?: string;
  cookie?: string;
  videoUrl: string;
  audioUrl: string | null;
  /** 输出写入点：OPFS 文件的可写流 */
  writable: FileSystemWritableFileStream;
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

  // ---- 阶段二：重封装（占 DOWNLOAD_WEIGHT..1）----
  const target = new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'reserve' }),
    target,
  });
  await output.start();
  let bytes = videoBlob.size + (audioBlob?.size ?? 0);
  try {
    // 视频轨道直通
    await pipeTrack(videoBlob, output, 'video');
    onProgress?.(DOWNLOAD_WEIGHT + (1 - DOWNLOAD_WEIGHT) * (audioBlob ? 0.6 : 1));
    // 音频轨道直通（可缺）
    if (audioBlob) {
      await pipeTrack(audioBlob, output, 'audio');
      onProgress?.(DOWNLOAD_WEIGHT + (1 - DOWNLOAD_WEIGHT) * 1);
    }
    await output.finalize();
  } catch (e) {
    try {
      await output.cancel();
    } catch {
      /* 忽略取消异常 */
    }
    throw e;
  }
  onProgress?.(1);
  return { bytes };
}
