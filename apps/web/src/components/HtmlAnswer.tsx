import { useId, useMemo, useState } from 'react';
import { useSettings } from '../store/settings';
import { useResolvedDark } from '../ui/theme';
import StreamingHtmlPreview from './StreamingHtmlPreview';
import WidgetBlock from './WidgetBlock';
import { prepareInteractiveHtml, sanitizeHtmlAnswer } from '../utils/htmlAnswer';
import type { HtmlContentType } from '../utils/htmlContent';
import { Button } from '@heroui/react';
import { copyText } from '../utils/clipboard';
import { toast } from '../ui';
import type { ArtifactActions } from './ArtifactEditor';

/** Works execute only in the opaque sandbox; examples need an explicit local user opt-in. */
export default function HtmlAnswer({ source, streaming = false, editActions, allowPopout = true, contentType = 'example' }: {
  source: string; streaming?: boolean; editActions?: ArtifactActions | null; allowPopout?: boolean; contentType?: HtmlContentType;
}) {
  const dark = useResolvedDark(useSettings((state) => state.theme));
  const [showSource, setShowSource] = useState(false);
  const sourceId = useId();
  const [runSource, setRunSource] = useState<string | null>(null);
  const interactive = contentType === 'interactive' || runSource === source;
  const html = useMemo(() => streaming ? '' : interactive ? prepareInteractiveHtml(source) : sanitizeHtmlAnswer(source), [source, streaming, interactive]);
  if (streaming) return <StreamingHtmlPreview html={source} statusText="正在解析 HTML" />;
  return <div className="md-embedded-ui min-w-0" data-testid="html-answer">
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span>{interactive ? '交互 HTML · 隔离运行，外部依赖受限' : 'HTML 示例 · 静态预览，脚本未运行'}</span>
      {!interactive && <Button size="sm" variant="tertiary" onPress={() => setRunSource(source)}>运行交互</Button>}
    </div>
    <WidgetBlock payload={{ html }} dark={dark} disabled allowPopout={allowPopout} editActions={editActions}
      htmlActions={{
        sourceOpen: showSource, sourceId, toggleSource: () => setShowSource((value) => !value),
        copySource: () => void copyText(source).then((ok) => {
          if (ok) toast.success('HTML 源码已复制');
          else toast.error('复制失败');
        }),
      }} />
    {showSource && <pre id={sourceId} aria-label="HTML 源码" className="my-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-default p-3 text-xs" data-testid="html-answer-source"><code>{source}</code></pre>}
  </div>;
}
