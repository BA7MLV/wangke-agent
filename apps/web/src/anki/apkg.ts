/**
 * 浏览器端 .apkg 导出：懒加载 sql.js（wasm ~1.2MB 由 vite `?url` 产出，
 * 匹配 PWA workbox 的 globPatterns wasm 规则，预缓存后离线可导出）。
 */
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { CardRow } from '../store/db';
import { buildApkgBytes } from './apkgCore';

export async function buildApkg(videoName: string, cards: CardRow[]): Promise<Blob> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const bytes = buildApkgBytes(SQL, videoName, cards);
  // 按视图范围精确切片，避免 buffer 类型/偏移问题
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([ab], { type: 'application/octet-stream' });
}
