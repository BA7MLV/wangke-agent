import sharp from 'sharp';
import type { CloudConfig } from '@wangke/contracts/cloud';

/** Explicit selection wins. The server has no browser capability catalog, so
 * automatic mode sends a real multimodal request to the main model and surfaces
 * provider rejection rather than guessing capabilities from model names. */
export function visionTarget(config: CloudConfig) {
  const explicit = Boolean(config.visionModel.model);
  const ref = explicit ? config.visionModel : config.llmModel;
  const provider = config.providers.find(p => p.id === ref.providerId);
  if (!provider || !ref.model) throw new Error('vision_model_not_configured');
  return { ref, provider };
}

/** Apply EXIF rotation, strip metadata and bound pixels/bytes. Read the first frame. */
export async function prepareVisionImage(bytes: Uint8Array) {
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error', animated: false })
      .rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    if (data.length > 5 * 1024 * 1024) throw new Error('image_too_large');
    return { bytes: data, mime: 'image/jpeg', width: info.width, height: info.height };
  } catch { throw new Error('vision_image_invalid_or_too_large'); }
}

export const visionRecovery: Record<string, string> = {
  vision_model_not_configured: 'Select an image-understanding model in model settings. Do not repeatedly retry or ask the user to transcribe the image as the default fix.',
  vision_image_invalid_or_too_large: 'Image decoding failed or exceeded the 40-megapixel input limit. Ask for a valid PNG/JPEG/WebP/GIF or a smaller crop.',
  invalid_image_format: 'Ask for a supported PNG/JPEG/WebP/GIF image.',
  vision_empty_response: 'The image model returned no usable text. Retry once with a specific question; if it persists, report the failure without inventing image contents.',
  model_auth_failed: 'Model credentials were rejected. Ask the user to check the provider credentials in settings; do not retry unchanged credentials.',
  model_quota_exhausted: 'Ask the user to check the model provider billing/quota.',
  model_invalid_request: 'The provider rejected the image request. Select an image-capable vision model and check its API protocol in model settings; do not repeat an unchanged request.',
  model_request_failed: 'Transient failures persisted after bounded automatic retries. Explain that the provider is temporarily unavailable; do not loop on the same tool.',
};
