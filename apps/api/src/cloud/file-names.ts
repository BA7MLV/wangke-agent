import path from 'node:path';

const imageExtensions: Record<string, string[]> = {
  'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/gif': ['.gif'], 'image/webp': ['.webp'],
};
const truncate = (value: string, bytes: number) => {
  let result = '';
  for (const char of value) { if (Buffer.byteLength(result + char) > bytes) break; result += char; }
  return result;
};

/** One portable leaf name, not a path. Leave room for collision suffixes within NAME_MAX. */
export function safeFileName(value: string, fallback = 'Attachment') {
  const clean = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').trim().replace(/[. ]+$/, '');
  const name = clean && !/^\.+$/.test(clean) ? clean : fallback;
  const extension = truncate(path.posix.extname(name), 32);
  const stem = name.slice(0, name.length - path.posix.extname(name).length);
  const portable = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${stem}` : stem;
  return truncate(portable, 240 - Buffer.byteLength(extension)) + extension;
}

export function imageFileName(name: string, mime: string, fallback: string) {
  const extensions = isRasterImage(mime) ? imageExtensions[mime] : undefined;
  let result = safeFileName(name, fallback);
  if (!extensions) return result;
  const extension = path.posix.extname(result);
  if (extensions.includes(extension.toLowerCase())) return result;
  result = extension ? result.slice(0, -extension.length) : result;
  return safeFileName(result + extensions[0]);
}

export function isRasterImage(mime: string) { return Object.hasOwn(imageExtensions, mime); }
export function hasRasterExtension(name: string) {
  return Object.values(imageExtensions).some(extensions => extensions.includes(path.posix.extname(name).toLowerCase()));
}
