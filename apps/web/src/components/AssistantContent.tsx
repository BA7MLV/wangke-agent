import { Fragment, useMemo, type ReactNode } from 'react';
import { splitAssistantContent } from '../utils/streamingHtml';
import ArtifactEditor from './ArtifactEditor';
import HtmlAnswer from './HtmlAnswer';
import { InlineWidget } from './WidgetMessage';
import SvgBlock from './mermaid/SvgBlock';

/** Keep each delivered question in place while the assistant continues writing. */
export default function AssistantContent({ content, streaming = false, children }: {
  content: string;
  streaming?: boolean;
  children: (markdown: string, streaming: boolean) => ReactNode;
}) {
  const blocks = useMemo(() => splitAssistantContent(content), [content]);
  return blocks.map((block, index) => block.kind === 'html' ? (
    <ArtifactEditor key={`html-${block.start}`} kind="html" location={block.location} source={block.source} closed={block.closed}>
      {(actions) => <HtmlAnswer source={block.source} streaming={streaming && !block.closed} editActions={actions} />}
    </ArtifactEditor>
  ) : block.kind === 'svg' ? (
    <ArtifactEditor key={`svg-${block.start}`} kind="svg" location={block.location} source={block.source} closed={!streaming || block.closed}>
      <SvgBlock code={block.source} closed={!streaming || block.closed} />
    </ArtifactEditor>
  ) : block.kind === 'widget' ? (
    <InlineWidget key={`widget-${block.start}`} reference={block.source} closed={block.closed} />
  ) : (
    <Fragment key={`markdown-${block.start}`}>{children(block.source, streaming && index === blocks.length - 1)}</Fragment>
  ));
}
