import { useMemo } from 'react';
import { peekDiagramProgress } from './diagramStream';
import { renderDiagram } from './diagramRender';
import { validateDiagram } from './diagramSchema';
import { sanitizeSvg, sanitizeSvgFragment } from './svgRender';
import DiagramBlock, { type DiagramPhase, type DiagramStream } from './DiagramBlock';
import type { DiagramShape } from './diagramSchema';

/**
 * ```diagram 围栏（JSON 中间层）的图表块。
 *
 * 这条链路替代的是「模型直出 SVG」：围栏里放一段 JSON（{"type":"graph"|"plot", …}），
 * 由 diagramRender 确定性算出布局与坐标，再落成 SVG。模型不再手写路径、手算坐标 ——
 * 那些正是「AI 端到端画图」最常漂移的地方。schema 与写法见「讲解配图」技能。
 *
 * 与 SvgBlock / MermaidBlock 的差别：
 * 1. **流式单位是逻辑图元**：半截 JSON 每多写完一个数组项就多一个 key，
 *    由 DiagramCanvas 按 key 追加（见该组件说明）。闭合前的最后一拍与闭合后的
 *    完整渲染收敛到同一份 shapes，所以闭合那一刻画面不变、只多出工具条。
 * 2. **净化方向是纵深防御**：产出 SVG 的是我们自己的渲染器（文本已转义），
 *    但每个片段仍过 svgRender 的同一道白名单（sanitizeSvgFragment）——
 *    渲染器哪天多吐一个白名单外的东西，在这里现形。
 * 3. **同步纯计算**：与 SvgBlock 一样放 useMemo（放 effect 会先闪一帧空态），
 *    失败态同样不给「重试」（同样的输入必然同样的结果）。
 */
export default function JsonDiagramBlock({ code, closed, title }: { code: string; closed: boolean; title?: string | null }) {
  const trimmed = useMemo(() => code.replace(/\s+$/, ''), [code]);

  /**
   * 流式增量**只在围栏未闭合时**算。闭合后一律走完整校验 + 完整渲染 ——
   * 那才是权威结果，预览层不该（也没能力）替代它。
   */
  const stream = useMemo<DiagramStream | null>(() => {
    if (closed) return null;
    const progress = peekDiagramProgress(trimmed);
    if (!progress) return null;
    try {
      const shapes: DiagramShape[] = progress.shapes.map((s) => ({
        key: s.key,
        svg: sanitizeSvgFragment(s.svg),
      }));
      return { kind: 'diagram', viewBox: progress.viewBox, shapes };
    } catch {
      // 命中安全闸门（渲染器产出物都不该触发，属于纵深防御的那一挡）：
      // 这一拍不画，退回等待态，等闭合后统一处置。
      return null;
    }
  }, [trimmed, closed]);

  const { phase, svg, err, finalCanvas } = useMemo<{ phase: DiagramPhase; svg: string | null; err: string; finalCanvas?: DiagramStream }>(() => {
    if (!closed) {
      return stream ? { phase: 'drawing', svg: null, err: '' } : { phase: 'waiting', svg: null, err: '' };
    }
    try {
      let doc: unknown;
      try {
        doc = JSON.parse(trimmed);
      } catch (e) {
        const hint = /^\s*</.test(trimmed)
          ? '内容以 < 开头，看起来是 SVG 而不是 JSON —— ```diagram 围栏里只放 JSON 对象'
          : '请检查有没有多余的逗号、缺引号、或把说明文字写进了围栏';
        throw new Error(`diagram 围栏里不是合法的 JSON：${e instanceof Error ? e.message : String(e)}。${hint}`);
      }
      const validated = validateDiagram(doc);
      const rendered = renderDiagram(validated);
      return { phase: 'ok', svg: sanitizeSvg(rendered.svg), err: '', finalCanvas: {
        kind: 'diagram', viewBox: rendered.viewBox,
        shapes: rendered.shapes.map(s => ({ key: s.key, svg: sanitizeSvgFragment(s.svg) })),
      } };
    } catch (e) {
      return { phase: 'error', svg: null, err: e instanceof Error ? e.message : String(e) };
    }
  }, [trimmed, closed, stream]);

  return (
    <DiagramBlock
      testId="diagram"
      tag="DIAGRAM"
      title={title}
      phase={phase}
      svg={svg}
      stream={finalCanvas ?? stream}
      err={err}
      source={trimmed}
      copyLabel="复制 diagram 源码"
      copyToast="已复制 diagram 源码"
      waitingText="图形生成中…"
      renderingText="正在渲染图形…"
      errorTitle="暂时无法显示图形"
      downloadPrefix="diagram"
    />
  );
}
