/** Bounded, exact edits: never guess a location or modify the surrounding answer. */
export type ArtifactKind = 'diagram' | 'svg' | 'mermaid' | 'html';
export type ArtifactLocation = 'fence' | 'html' | 'widget';
export const MAX_ARTIFACT_LENGTH = 120_000;

/** Only infer visual content for markup/unlabelled code, never JS/JSX strings or ordinary XML. */
export function isSvgCode(lang: unknown, source: unknown): boolean {
  if (!/^(?:xml|html?|image\/svg\+xml|application\/svg\+xml)?$/i.test(String(lang ?? '').trim())) return false;
  if (typeof source !== 'string') return false;
  const text = source.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/^\s*(?:<\?xml\b[^?]*\?>\s*|<!--[\s\S]*?-->\s*)*/i, '').trimStart();
  return /^<svg(?:\s|\/?>|$)/i.test(text);
}

export function parseArtifactReply(reply: string): unknown {
  const clean = reply.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  if (!clean.trim()) throw new Error('模型未返回修改内容，原内容未修改；请重试或切换模型');
  try { return JSON.parse(clean); } catch {
    throw new Error('模型返回的修改 JSON 不完整或格式不正确，原内容未修改；请重试、缩小修改范围，或使用“仅重生成此块”');
  }
}

export function applyArtifactReply(source: string, reply: unknown, mode: 'patch' | 'rewrite'): string {
  if (!reply || typeof reply !== 'object') throw new Error('模型未返回有效的修改对象');
  const result = reply as { edits?: unknown; source?: unknown };
  let next = source;
  if (mode === 'rewrite') {
    if (typeof result.source !== 'string') throw new Error('模型未返回此块的完整源码');
    next = result.source;
  } else {
    if (!Array.isArray(result.edits) || !result.edits.length || result.edits.length > 30) {
      throw new Error('补丁必须包含 1–30 项修改，可尝试仅重生成此块');
    }
    // Resolve every edit against the SAME base. Overlaps are rejected, not ordered implicitly.
    const edits = result.edits.map((edit: unknown) => {
      if (!edit || typeof edit !== 'object') throw new Error('补丁格式不正确');
      const { search, replace } = edit as { search?: unknown; replace?: unknown };
      if (typeof search !== 'string' || !search || typeof replace !== 'string') throw new Error('补丁缺少 search / replace');
      const start = source.indexOf(search);
      if (start < 0 || source.indexOf(search, start + 1) >= 0) throw new Error('补丁位置不存在或不唯一，原内容未修改；可尝试仅重生成此块');
      return { start, end: start + search.length, replace };
    }).sort((a, b) => b.start - a.start);
    let boundary = source.length;
    for (const edit of edits) {
      if (edit.end > boundary) throw new Error('补丁范围重叠，原内容未修改');
      next = next.slice(0, edit.start) + edit.replace + next.slice(edit.end);
      boundary = edit.start;
    }
  }
  if (!next.trim() || next.length > MAX_ARTIFACT_LENGTH) throw new Error('修改结果为空或超过内容块大小限制');
  if (next === source) throw new Error('模型没有修改此块');
  return next;
}

export interface FenceRange { start: number; end: number; kind: string; source: string; marker: string }

/** Markdown fences, including tilde/long fences. Ignore nested-looking fences inside code. */
export function artifactFences(content: string): FenceRange[] {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const ranges: FenceRange[] = [];
  let offset = 0;
  let open: { start: number; kind: string; marker: string } | undefined;
  for (const line of lines) {
    const text = line.replace(/\r?\n$/, '');
    if (!open) {
      const match = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)[^\r\n]*$/.exec(text);
      if (match) open = { start: offset + line.length, marker: match[1], kind: match[2].toLowerCase() };
    } else if (new RegExp(`^ {0,3}${open.marker[0]}{${open.marker.length},}[ \\t]*$`).test(text)) {
      ranges.push({ ...open, end: offset, source: content.slice(open.start, offset).replace(/\s+$/, '') });
      open = undefined;
    }
    offset += line.length;
  }
  return ranges;
}

export function replaceArtifactFence(content: string, kind: ArtifactKind, source: string, next: string): string {
  const matches = artifactFences(content).filter((f) => (f.kind === kind || (kind === 'html' && f.kind === 'htm')
    || (kind === 'svg' && isSvgCode(f.kind, f.source))) && f.source === source.replace(/\s+$/, ''));
  if (matches.length !== 1) throw new Error('无法唯一定位此块，原回答未修改（可能包含相同的图或内容已变化）');
  const range = matches[0];
  // Do not let model output escape its fence and inject/replace other answer blocks.
  const closing = new RegExp(`^ {0,3}${range.marker[0]}{${range.marker.length},}[ \\t]*$`, 'm');
  if (closing.test(next)) throw new Error('修改内容包含围栏结束标记，已拒绝覆盖');
  return content.slice(0, range.start) + next.replace(/\s+$/, '') + '\n' + content.slice(range.end);
}
