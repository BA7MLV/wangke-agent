import { useEffect, useMemo, useRef, useState } from 'react';
import { peekMermaid, renderMermaid } from './mermaidRender';
import DiagramBlock, { type DiagramPhase } from './DiagramBlock';

/**
 * Mermaid 图表块：替代 ```mermaid 围栏的代码块渲染。
 *
 * 这里只负责「源码 → SVG」这一步（懒加载 + 串行队列 + 缓存 peek），
 * 外壳（标签 / 工具条 / 四态正文 / 源码折叠 / 大图弹层）交给共用的 DiagramBlock。
 *
 * 三种状态（对应「绝不吞信息」）：
 * - waiting：围栏还没闭合（流式中）→ 只提示「图表生成中」并给源码预览，不 parse、不抖。
 * - ok：渲染成功 → 展示 SVG + 工具条。
 * - error：语法不合法 → 错误摘要 + 源码 + 重试，用户至少能拿走源码。
 */
export default function MermaidBlock({ code, closed }: { code: string; closed: boolean }) {
  const trimmed = useMemo(() => code.replace(/\s+$/, ''), [code]);
  // 命中缓存则直接进 ok，避免重挂/流式重渲染时的闪烁
  const cached = peekMermaid(trimmed);
  const [phase, setPhase] = useState<DiagramPhase>(cached ? 'ok' : closed ? 'rendering' : 'waiting');
  const [svg, setSvg] = useState<string | null>(cached ?? null);
  const [err, setErr] = useState('');
  // 重试时自增，作为渲染 effect 的触发源
  const [retry, setRetry] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!closed) {
      setPhase('waiting');
      return;
    }
    const hit = peekMermaid(trimmed);
    if (hit) {
      setSvg(hit);
      setErr('');
      setPhase('ok');
      return;
    }
    setPhase('rendering');
    setErr('');
    renderMermaid(trimmed)
      .then((out) => {
        if (!alive.current) return;
        setSvg(out);
        setPhase('ok');
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setErr(e instanceof Error ? e.message : String(e));
        setPhase('error');
      });
  }, [trimmed, closed, retry]);

  return (
    <DiagramBlock
      testId="mermaid"
      tag="Mermaid"
      phase={phase}
      svg={svg}
      err={err}
      source={trimmed}
      copyLabel="复制 Mermaid 源码"
      copyToast="已复制 Mermaid 源码"
      waitingText="图表生成中…"
      renderingText="正在渲染图表…"
      errorTitle="图表渲染失败，已回退为源码"
      downloadPrefix="diagram"
      onRetry={() => setRetry((v) => v + 1)}
    />
  );
}
