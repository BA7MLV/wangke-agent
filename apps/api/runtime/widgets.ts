import { randomUUID } from 'node:crypto';
import { validateWidgetArgs, widgetAcceptedText, widgetRejectedText, type WidgetPayload } from '@wangke/study-core/widgets';
import { validateDiagram } from '@wangke/study-core/diagram-schema';
import { compileExpression } from '@wangke/study-core/diagram-expression';

/** No generated code is evaluated here. Browser sandbox/render checks remain mandatory. */
export function executeServerWidget(raw: unknown, accept: (payload: WidgetPayload) => void): string {
  const parsed = validateWidgetArgs(raw);
  if (!parsed.ok) throw new Error(`预检参数不合法：${parsed.error}。请修正后重新调用 show_widget。`);
  const args = parsed.args;
  try {
    if (args.format === 'html') {
      const id = randomUUID();
      const payload: WidgetPayload = { kind: 'html', schemaVersion: 1, revision: 1, source: 'tool', id, ref: id, html: args.code,
        ...(args.libs?.length ? { libs: args.libs } : {}) };
      // The caller commits this payload before a successful receipt reaches the model.
      accept(payload);
      return widgetAcceptedText(args, id);
    }
    if (args.format === 'diagram') {
      let input: unknown;
      try { input = JSON.parse(args.code); }
      catch { throw new Error('diagram 围栏里不是合法的 JSON，请检查逗号、引号和多余说明'); }
      const doc = validateDiagram(input);
      if (doc.type === 'plot') for (const curve of doc.curves ?? []) compileExpression(curve.fn);
    } else if (args.format === 'svg') {
      if (!/^<svg\b[^>]*\bviewBox\s*=/i.test(args.code)) throw new Error('SVG 必须以 <svg 开头并带 viewBox');
      if (!/<\/svg>\s*$/i.test(args.code)) throw new Error('SVG 没有闭合（缺少 </svg>）');
      if (/<\s*(?:script|iframe|object|embed|foreignObject|image|use|a|style|animate\w*|set)\b|\son[a-z]+\s*=|\b(?:href|src)\s*=|javascript:/i.test(args.code)
        || [...args.code.matchAll(/url\(\s*['"]?\s*([^'")]*)/gi)].some(match => !match[1].trim().startsWith('#'))) {
        throw new Error('SVG 包含脚本或外部嵌入内容，已阻止渲染');
      }
    } else {
      // Mermaid's complete parser/rendering needs a DOM. Do not claim a server
      // render succeeded or import a Web runtime into the API for that purpose.
      if (!/^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|mindmap|pie|gantt|journey|gitGraph|timeline|quadrantChart|xychart-beta)\b/.test(args.code)) {
        throw new Error('mermaid 需以支持的图种声明开头，如 flowchart / sequenceDiagram / stateDiagram-v2 / mindmap / pie');
      }
    }
    return `服务器已完成参数与结构预检；完整图形语法、净化和渲染仍由客户端检查。\n${widgetAcceptedText(args)}`;
  } catch (error) {
    // Never convert persistence/cancellation failures into a success receipt.
    if (args.format === 'html') throw error;
    throw new Error(widgetRejectedText(error));
  }
}
