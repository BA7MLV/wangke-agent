import { Fragment, useMemo, type ReactNode } from 'react';
import { splitAssistantContent } from '../utils/streamingHtml';
import ArtifactEditor from './ArtifactEditor';
import StreamingHtmlPreview from './StreamingHtmlPreview';

/** Keep each delivered question in place while the assistant continues writing. */
export default function AssistantContent({ content, streaming = false, children }: {
  content: string;
  streaming?: boolean;
  children: (markdown: string, streaming: boolean) => ReactNode;
}) {
  const blocks = useMemo(() => splitAssistantContent(content), [content]);
  return blocks.map((block, index) => block.kind === 'html' ? (
    <ArtifactEditor key={`html-${block.start}`} kind="html" location={block.location} source={block.source} closed={block.closed}>
      <StreamingHtmlPreview html={block.source} isStreaming={streaming && !block.closed} statusText="正在解析 HTML" />
    </ArtifactEditor>
  ) : (
    <Fragment key={`markdown-${block.start}`}>{children(block.source, streaming && index === blocks.length - 1)}</Fragment>
  ));
}
