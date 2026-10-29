import { apiUrl } from '../api/base';
import { cloud } from '../cloud/state';
import { getVideoFile } from './fileStore';

export interface VideoPlaybackSource {
  src: string;
  crossOrigin?: 'use-credentials';
  release: () => void;
}

export class VideoPlaybackError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

function accessError(status: number): VideoPlaybackError {
  return new VideoPlaybackError(status === 401 ? '登录已过期，请重新登录后重试'
    : status === 403 ? '没有权限播放这个视频'
    : status === 404 ? '视频文件不存在或已被删除'
    : `读取视频失败（HTTP ${status}），请稍后重试`, status);
}

/** Only probe headers. The native media provider owns buffering, seeking and cancellation. */
export async function getVideoPlaybackSource(id: string, signal: AbortSignal): Promise<VideoPlaybackSource | null> {
  signal.throwIfAborted();
  if (cloud.enabled && !cloud.workerToken) {
    const src = apiUrl(`/api/v1/resources/courses/${encodeURIComponent(id)}`);
    const response = await fetch(src, { method: 'HEAD', credentials: 'include', cache: 'no-cache', signal });
    if (response.status === 404) return null;
    if (!response.ok) throw accessError(response.status);
    return { src, crossOrigin: 'use-credentials', release: () => {} };
  }
  // Offline files are already local. Token-only background workers retain their
  // authenticated Blob path; never put their bearer token into a media URL.
  const blob = await getVideoFile(id);
  signal.throwIfAborted();
  if (!blob) return null;
  const src = URL.createObjectURL(blob);
  return { src, release: () => URL.revokeObjectURL(src) };
}

/** Native media errors hide HTTP status; a header-only probe gives an actionable reason. */
export async function describeVideoPlaybackError(code: number, src: string, signal: AbortSignal): Promise<string> {
  if (src && !src.startsWith('blob:')) {
    try {
      const response = await fetch(src, { method: 'HEAD', credentials: 'include', cache: 'no-cache', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) return accessError(response.status).message;
    } catch {
      if (signal.aborted) throw signal.reason;
      return '网络连接失败，请检查网络后重试';
    }
  }
  return code === 3 ? '视频解码失败，文件可能损坏或当前浏览器不支持此编码'
    : code === 4 ? '当前浏览器不支持这个视频的格式或编码，请换用兼容的 MP4 视频'
    : '视频加载中断，请检查网络后重试';
}
