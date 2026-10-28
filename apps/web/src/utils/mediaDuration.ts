import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

/** Prefer native container metadata; fall back for MKV/FLV and other formats. */
export async function probeDuration(file: Blob): Promise<number> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata'; video.muted = true; video.playsInline = true;
  let nativeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      nativeTimer = setTimeout(() => reject(new Error('native duration timeout')), 3000);
      video.onloadedmetadata = () => resolve(video.duration);
      video.onerror = () => reject(new Error('native duration unavailable'));
      video.src = url;
    });
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch { /* Unsupported containers use mediabunny below. */ }
  finally {
    clearTimeout(nativeTimer);
    video.onloadedmetadata = null; video.onerror = null;
    video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
  }
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const duration = await Promise.race([input.computeDuration(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('probe timeout')), 15000);
    })]);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch { return 0; }
  finally { clearTimeout(timer); input.dispose(); }
}
