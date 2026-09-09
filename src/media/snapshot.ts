export interface Snapshot {
  /** 送模型的大图（最长边 1280，JPEG 0.85） */
  dataUrl: string;
  /** 历史持久化用缩略图（最长边 320） */
  thumb: string;
  /** 截图时刻（秒） */
  ts: number;
}

function drawToJpeg(video: HTMLVideoElement, maxEdge: number, quality: number): string {
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** 从 video 元素抓当前帧；视频未就绪（无尺寸或 readyState < HAVE_CURRENT_DATA，如 seek 后帧未解码）时返回 null */
export function captureFrame(video: HTMLVideoElement, ts: number): Snapshot | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  if (video.readyState < 2) return null; // HAVE_CURRENT_DATA：防止 seek 后截到陈旧/黑帧
  return {
    dataUrl: drawToJpeg(video, 1280, 0.85),
    thumb: drawToJpeg(video, 320, 0.7),
    ts,
  };
}

/**
 * 从 Vidstack playerRef 解析 <video> 元素（兜底全局查询）。
 * 已核对 @vidstack/react 1.15.6 类型：MediaPlayerInstance 沿 MediaPlayer → Component → ViewController
 * 继承链暴露 `get el(): HTMLElement | null`（见 node_modules/@vidstack/react/types/vidstack-instances.d.ts），
 * 故主路径取 player.el 再在宿主内查 video；取不到时退回 .video-pane 容器全局查询。
 */
export function resolveVideoEl(playerRef: { current: unknown } | null): HTMLVideoElement | null {
  const host = (playerRef?.current as { el?: HTMLElement | null } | null)?.el;
  const v = host?.querySelector('video') ?? document.querySelector('.video-pane video');
  return (v as HTMLVideoElement | null) ?? null;
}
