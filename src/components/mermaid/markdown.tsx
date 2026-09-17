import React from 'react';
import type { ComponentProps } from '@ant-design/x-markdown';
import MermaidBlock from './MermaidBlock';
import SvgBlock from './SvgBlock';
import { diagramKindOf } from './fence';

type CodeLikeProps = { block?: unknown; lang?: unknown; children?: unknown };

/**
 * 替换 XMarkdown 的 `code` 元素。
 *
 * XMarkdown 在 code 组件上额外挂了 `block` / `lang` / `streamStatus`（见其 Parser 的
 * configureCodeRenderer + Renderer 的属性映射）：`streamStatus` 由**围栏是否闭合**决定，
 * 正好用来在流式期间拦住未完成的图表源码。
 *
 * 围栏判定在 `./fence`（纯模块，不 import 任何 DOM 依赖）—— 那里是「提示词 ↔ 渲染层」
 * 的契约所在，抽出来是为了能在 Node 单测里守住它，见 scripts/test-chat-frames.mjs。
 */
export function MarkdownCode({ block, lang, streamStatus, className, children }: ComponentProps) {
  const kind = diagramKindOf({ block, lang });
  if (kind) {
    const code = typeof children === 'string' ? children : String(children ?? '');
    // 未闭合（流式中）时只停在等待态，不解析半截内容 —— 见 MermaidBlock / SvgBlock 的说明
    const closed = streamStatus !== 'loading';
    return kind === 'mermaid' ? <MermaidBlock code={code} closed={closed} /> : <SvgBlock code={code} closed={closed} />;
  }
  return <code className={typeof className === 'string' ? className : undefined}>{children as React.ReactNode}</code>;
}

/**
 * 替换 XMarkdown 的 `pre` 元素。
 *
 * 块级围栏被解析成 `<pre><code>…</code></pre>`，而图表块自带边框容器，
 * 再套一层 `<pre>` 会被代码块样式包住。这里靠「唯一子元素是不是套了图表围栏的 code」
 * 来剥离外壳 —— mermaid 与 svg 两种围栏共用同一条判定。
 *
 * 注意：XMarkdown 的 Renderer 会 processChildren 递归替换，但拿到的 children 是**尚未渲染的
 * React 元素**（`type` 是 MarkdownCode 本身，不是 MermaidBlock），所以判定只能看它的 props。
 */
export function MarkdownPre({ children }: ComponentProps) {
  const items = React.Children.toArray(children as React.ReactNode).filter(
    (c) => !(typeof c === 'string' && c.trim() === ''),
  );
  if (items.length === 1 && React.isValidElement(items[0]) && diagramKindOf(items[0].props as CodeLikeProps)) {
    return <>{children as React.ReactNode}</>;
  }
  return <pre>{children as React.ReactNode}</pre>;
}
