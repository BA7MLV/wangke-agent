import { createContext, useContext, type ReactNode } from 'react';

/**
 * 「这段 Markdown 还在流式生成」的上下文。
 *
 * 为什么不用 XMarkdown 的 `streamStatus`：那个值只对**自定义标签**有意义
 * （`detectUnclosedComponentTags` 扫的是 components 映射里的标签）。标准 `<table>`
 * 在 HTML 里永远是闭合的，流到一半时 `streamStatus` 也照样是 `done`。
 *
 * 表格又必须知道这件事：流式期间只挂完整行、不挂展开按钮；生成结束后才进入
 * 可交互态。所以在 XMarkdown 外面套一层，`MarkdownTable` 从上下文里读。
 *
 * 默认 `false` —— 历史消息、题卡解析、材料阅读都没套 Provider，天然是静态表格。
 */
const MarkdownStreamingContext = createContext(false);

export function MarkdownStreamingProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}) {
  return (
    <MarkdownStreamingContext.Provider value={value}>
      {children}
    </MarkdownStreamingContext.Provider>
  );
}

export function useMarkdownStreaming(): boolean {
  return useContext(MarkdownStreamingContext);
}
