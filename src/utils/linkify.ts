// 注：本文件被 node 测试脚本直接 import（type stripping），相对导入必须带 .ts 扩展名
import { fmtTime } from './vtt.ts';
import { unitRefRe, type UnitKind } from '../materials/units.ts';

/** 解析 [mm:ss] / [h:mm:ss] 为秒 */
export function parseTs(s: string): number {
  const parts = s.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

const TS_RE = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;

/**
 * 只在「非代码」区域应用 transform。
 *
 * 必要性：linkify 作用在整篇 markdown 上，若不避开代码，` ```mermaid ` 里的节点标签
 * （如 `A[03:25]`）会被改写成 markdown 链接，图表源码直接损坏；普通代码块里出现 `[00:10]`
 * 同理。按行扫描围栏（``` / ~~~，含缩进与长度校验），再对非代码段落跳过行内 `code`。
 */
function mapOutsideCode(text: string, fn: (s: string) => string): string {
  const FENCE_RE = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/;
  const parts: { code: boolean; s: string }[] = [];
  let buf = '';
  let marker: string | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = i > 0 ? `\n${lines[i]}` : lines[i];
    const m = FENCE_RE.exec(lines[i]);
    if (marker === null) {
      if (m) {
        if (buf) parts.push({ code: false, s: buf });
        buf = raw;
        marker = m[2];
      } else {
        buf += raw;
      }
      continue;
    }
    buf += raw;
    // 闭合围栏：同种字符、不短于开始、且行尾无其他内容
    if (m && m[2][0] === marker[0] && m[2].length >= marker.length && m[3].trim() === '') {
      parts.push({ code: true, s: buf });
      buf = '';
      marker = null;
    }
  }
  if (buf) parts.push({ code: marker !== null, s: buf });
  // 行内代码：`...`（奇偶交替即代码段）；反引号不成对时后半段按代码处理，宁可不动
  return parts
    .map((p) => (p.code ? p.s : p.s.split(/(`+[^`]*`+)/).map((seg, i) => (i % 2 === 1 ? seg : fn(seg))).join('')))
    .join('');
}

/** 把回答中的 [mm:ss] 转成 markdown 链接 [[mm:ss]](#seek-秒)，交由自定义 a 组件渲染成可点击跳转 */
export function linkifyTimestamps(text: string): string {
  return mapOutsideCode(text, (s) => s.replace(TS_RE, (m, ts: string) => `[${m}](#seek-${parseTs(ts)})`));
}

/** AI 回答引用课程画面的标记：[图@mm:ss]（时间戳必须来自 list_frames 工具返回的清单） */
const FRAME_RE = /\[图@(\d{1,3}:\d{2}(?::\d{2})?)\]/g;

/**
 * 把 [图@mm:ss] 转成 markdown 图片 ![课程画面 mm:ss](#frame-秒)，交由自定义 img 组件从 db.frames 取图渲染。
 * 用 #fragment 而非自定义协议：DOMPurify 默认放行 # 开头的相对地址，自定义协议会被剥掉。
 */
export function linkifyFrames(text: string): string {
  return mapOutsideCode(text, (s) => s.replace(FRAME_RE, (_m, ts: string) => `![课程画面 ${ts}](#frame-${parseTs(ts)})`));
}

/** list_frames 工具的输出：讲义抽帧（幻灯片）清单，按时间排序的 [mm:ss] 画面描述，供 agent 挑选引用 */
export function formatFrameList(rows: { ts: number; caption?: string }[]): string {
  if (rows.length === 0) return '该课程暂无可用画面（需先在「讲义」页生成讲义）。';
  return [...rows]
    .sort((a, b) => a.ts - b.ts)
    .map((r) => `[${fmtTime(r.ts)}] ${r.caption?.trim() || '（无画面描述）'}`)
    .join('\n');
}

/**
 * 阅读材料的定位引用：`[第3页]` / `[第3段]` → `[第3页](#unit-3)`，
 * 交由自定义 a 组件滚动阅读器到对应单元并高亮。
 *
 * 用统一的 `#unit-` 前缀而不是 `#page-`/`#para-`：材料页天然知道自己是 PDF 还是 Word，
 * 一个前缀就够，ChatPanel 的分支也少一条。与 `#seek-`（跳播放器时间）互不干扰。
 *
 * ⚠️ 材料场景**只跑本函数、不跑 linkifyTimestamps** —— 材料没有播放器，
 * 模型万一输出了 `[03:25]`，`#seek-` 会变成一个点了没反应的死链。
 */
export function linkifyUnits(text: string, kind: UnitKind): string {
  return mapOutsideCode(text, (s) => {
    const re = unitRefRe(kind);
    return s.replace(re, (m, n: string) => `[${m}](#unit-${n})`);
  });
}

/** 材料引用链接的前缀，渲染层（ChatPanel 的 a 组件）与测试共用同一常量，避免两边写死不一致 */
export const UNIT_LINK_PREFIX = '#unit-';
