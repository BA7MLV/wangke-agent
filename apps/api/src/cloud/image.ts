import fs from 'node:fs/promises';
import sharp from 'sharp';
import { hasRasterExtension, isRasterImage } from './file-names.js';

/** Sniff supported raster formats, never trust a platform MIME label for vision. */
export function imageMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && b.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 13 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(b.toString('ascii', 12, 16))) return 'image/webp';
}
export function mediaMime(bytes: Uint8Array, declared: string): string {
  const mime = imageMime(bytes);
  if (mime) return mime;
  if (declared.startsWith('image/')) throw new Error('invalid_image_format');
  return declared;
}

/** Format/header validation only, without re-encoding the original or reading a
 * potentially huge non-image upload into memory. Vision separately decodes pixels. */
export async function uploadedImageMime(filename: string, name: string, declared: string, header?: Uint8Array) {
  if (!header) {
    const handle = await fs.open(filename, 'r');
    try { const buffer = Buffer.alloc(32); const { bytesRead } = await handle.read(buffer, 0, 32, 0); header = buffer.subarray(0, bytesRead); }
    finally { await handle.close(); }
  }
  const mime = imageMime(header);
  const invalid = () => Object.assign(new Error('invalid_image_format'), { statusCode: 400 });
  if (!mime) {
    if (isRasterImage(declared) || hasRasterExtension(name)) throw invalid();
    return undefined;
  }
  try {
    const metadata = await sharp(filename, { limitInputPixels: 40_000_000 }).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) throw invalid();
  } catch { throw invalid(); }
  return mime;
}
