// 注：本文件被 node 测试脚本直接 import（type stripping），相对导入必须带 .ts 扩展名
import { fmtTime } from './vtt.ts';

/** 解析 [mm:ss] / [h:mm:ss] 为秒 */
export function parseTs(s: string): number {
  const parts = s.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

const TS_RE = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;

/** 把回答中的 [mm:ss] 转成 markdown 链接 [[mm:ss]](#seek-秒)，交由自定义 a 组件渲染成可点击跳转 */
export function linkifyTimestamps(text: string): string {
  return text.replace(TS_RE, (m, ts: string) => `[${m}](#seek-${parseTs(ts)})`);
}

/** AI 回答引用课程画面的标记：[图@mm:ss]（时间戳必须来自 list_frames 工具返回的清单） */
const FRAME_RE = /\[图@(\d{1,3}:\d{2}(?::\d{2})?)\]/g;

/**
 * 把 [图@mm:ss] 转成 markdown 图片 ![课程画面 mm:ss](#frame-秒)，交由自定义 img 组件从 db.frames 取图渲染。
 * 用 #fragment 而非自定义协议：DOMPurify 默认放行 # 开头的相对地址，自定义协议会被剥掉。
 */
export function linkifyFrames(text: string): string {
  return text.replace(FRAME_RE, (_m, ts: string) => `![课程画面 ${ts}](#frame-${parseTs(ts)})`);
}

/** list_frames 工具的输出：讲义抽帧（幻灯片）清单，按时间排序的 [mm:ss] 画面描述，供 agent 挑选引用 */
export function formatFrameList(rows: { ts: number; caption?: string }[]): string {
  if (rows.length === 0) return '该课程暂无可用画面（需先在「讲义」页生成讲义）。';
  return [...rows]
    .sort((a, b) => a.ts - b.ts)
    .map((r) => `[${fmtTime(r.ts)}] ${r.caption?.trim() || '（无画面描述）'}`)
    .join('\n');
}
