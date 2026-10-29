import type { ArtifactKind, ArtifactLocation } from '../utils/artifactEdit';
import type { WidgetLib } from '../harness/widgetRuntime';
import JsonDiagramBlock from './mermaid/JsonDiagramBlock';
import MermaidBlock from './mermaid/MermaidBlock';
import SvgBlock from './mermaid/SvgBlock';
import HtmlAnswer from './HtmlAnswer';
import WidgetBlock from './WidgetBlock';

/** Use exactly the original rendering boundary, without persistence, popouts or paid follow-ups. */
export default function ArtifactPreview({ kind, source, location, libraries, dark, htmlContentType }: {
  kind: ArtifactKind; source: string; location: ArtifactLocation; libraries?: readonly WidgetLib[]; dark: boolean;
  htmlContentType?: 'example' | 'interactive';
}) {
  if (kind === 'diagram') return <JsonDiagramBlock code={source} closed />;
  if (kind === 'mermaid') return <MermaidBlock code={source} closed />;
  if (kind === 'svg') return <SvgBlock code={source} closed />;
  if (location === 'widget') return <WidgetBlock payload={{ html: source, libs: libraries ? [...libraries] : undefined }} dark={dark} disabled allowPopout={false} />;
  return <HtmlAnswer source={source} contentType={htmlContentType ?? 'example'} allowPopout={false} persistLegacy={false} />;
}
