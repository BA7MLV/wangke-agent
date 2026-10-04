import { useMemo } from 'react';
import { peekSvgProgress, sanitizeSvg } from './svgRender';
import DiagramBlock, { type DiagramPhase } from './DiagramBlock';

/**
 * 原生 SVG 图表块：替代 ```svg 围栏的代码块渲染。
 *
 * 为什么要有这条路（mermaid 已经覆盖 15+ 图种）：mermaid 表达不了**函数图像、几何图形、
 * 坐标轴**这类自由图形 —— 那恰恰是数学/物理课程的高频板书。模型写 mermaid 会失败，
 * 写裸 SVG 反而一次就对。
 *
 * 与 MermaidBlock 的三点差别：
 * 1. **同步**：没有懒加载与渲染队列，净化是纯函数，所以不会停在 `rendering` 态；
 *    失败态也不给「重试」（同样输入必然同样结果，摆个按不出变化的按钮只会误导）。
 * 2. **安全方向相反**：这段 SVG 是模型直出的，**必须净化**（白名单在 svgRender.ts）。
 *    mermaid 那边是「绝不二次净化」，别把两条链路的结论互相套用。
 * 3. **流式落画**：mermaid 得等整段源码到齐才能 parse，svg 不用 —— 根标签一闭合就知道画布多大，
 *    之后每写完一个元素就能追加上去（这就是 `drawing` 态，见 LiveSvg）。
 *
 * 净化放在 useMemo 而不是 effect 里：它是同步纯计算，放 effect 会先渲染一帧
 * `waiting`/空态再跳成 `ok`，出现没必要的闪烁。
 */
export default function SvgBlock({ code, closed }: { code: string; closed: boolean }) {
  const trimmed = useMemo(() => code.replace(/\s+$/, ''), [code]);

  /**
   * 流式增量**只在围栏未闭合时**算。闭合后一律走 `sanitizeSvg` 的完整路径 ——
   * 完整净化产物是唯一权威结果，预览层不该（也没能力）替代它。
   */
  const progress = useMemo(() => {
    if (closed) return null;
    try {
      return peekSvgProgress(trimmed);
    } catch {
      // 命中安全闸门（外部 url() 之类）：这一拍不画，退回等待态，等闭合后统一报错。
      // 不弹错是因为用户此刻看到的还只是半段源码，错误该由最终结果来说。
      return null;
    }
  }, [trimmed, closed]);

  const { phase, svg, err } = useMemo<{ phase: DiagramPhase; svg: string | null; err: string }>(() => {
    if (!closed) {
      // 根标签还没成形 / 被安全闸门拦下 → 退回旧的等待态（占位 + 源码预览）
      return progress
        ? { phase: 'drawing', svg: null, err: '' }
        : { phase: 'waiting', svg: null, err: '' };
    }
    try {
      return { phase: 'ok', svg: sanitizeSvg(trimmed), err: '' };
    } catch (e) {
      return { phase: 'error', svg: null, err: e instanceof Error ? e.message : String(e) };
    }
  }, [trimmed, closed, progress]);

  return (
    <DiagramBlock
      testId="svg"
      tag="SVG"
      phase={phase}
      svg={svg}
      stream={progress}
      err={err}
      source={trimmed}
      copyLabel="复制 SVG 源码"
      copyToast="已复制 SVG 源码"
      waitingText="图形生成中…"
      renderingText="正在渲染图形…"
      errorTitle="图形无法渲染，已回退为源码"
      downloadPrefix="figure"
    />
  );
}
