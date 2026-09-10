import React from 'react';
import type { ComponentProps } from '@ant-design/x-markdown';
import MermaidBlock from './MermaidBlock';

/** ```mermaid 围栏：`lang` 可能是 `mermaid`，也可能带参数（如 `mermaid title=xx`），按词首匹配 */
const MERMAID_LANG_RE = /^\s*mermaid\b/i;

type CodeLikeProps = { block?: unknown; lang?: unknown; children?: unknown };

/** 是否是 ```mermaid 块级围栏（code / pre 两个替换组件共用同一判定） */
function isMermaidCode(props: CodeLikeProps): boolean {
  return !!props.block && MERMAID_LANG_RE.test(String(props.lang ?? ''));
}

/**
 * 替换 XMarkdown 的 `code` 元素。
 *
 * XMarkdown 在 code 组件上额外挂了 `block` / `lang` / `streamStatus`（见其 Parser 的
 * configureCodeRenderer + Renderer 的属性映射）：`streamStatus` 由**围栏是否闭合**决定，
 * 正好用来在流式期间拦住未完成的图表源码。
 */
export function MarkdownCode({ block, lang, streamStatus, className, children }: ComponentProps) {
  if (isMermaidCode({ block, lang })) {
    return <MermaidBlock code={typeof children === 'string' ? children : String(children ?? '')} closed={streamStatus !== 'loading'} />;
  }
  return <code className={typeof className === 'string' ? className : undefined}>{children as React.ReactNode}</code>;
}

/**
 * 替换 XMarkdown 的 `pre` 元素。
 *
 * 块级围栏被解析成 `<pre><code>…</code></pre>`，而 MermaidBlock 自带边框容器，
 * 再套一层 `<pre>` 会被代码块样式包住。这里靠「唯一子元素是不是套了 mermaid 围栏的 code」
 * 来剥离外壳。
 *
 * 注意：XMarkdown 的 Renderer 会 processChildren 递归替换，但拿到的 children 是**尚未渲染的
 * React 元素**（`type` 是 MarkdownCode 本身，不是 MermaidBlock），所以判定只能看它的 props。
 */
export function MarkdownPre({ children }: ComponentProps) {
  const items = React.Children.toArray(children as React.ReactNode).filter(
    (c) => !(typeof c === 'string' && c.trim() === ''),
  );
  if (items.length === 1 && React.isValidElement(items[0]) && isMermaidCode(items[0].props as CodeLikeProps)) {
    return <>{children as React.ReactNode}</>;
  }
  return <pre>{children as React.ReactNode}</pre>;
}
