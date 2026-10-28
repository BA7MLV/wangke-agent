import { useId, useMemo, useState } from 'react';
import { useSettings } from '../store/settings';
import { useResolvedDark } from '../ui/theme';
import StreamingHtmlPreview from './StreamingHtmlPreview';
import WidgetBlock from './WidgetBlock';
import { sanitizeHtmlAnswer } from '../utils/htmlAnswer';
import { copyText } from '../utils/clipboard';
import { toast } from '../ui';
import type { ArtifactActions } from './ArtifactEditor';

/** Keep CSS in an opaque sandbox, without granting ordinary code examples script/tool privileges. */
export default function HtmlAnswer({ source, streaming = false, editActions, allowPopout = true }: {
  source: string; streaming?: boolean; editActions?: ArtifactActions | null; allowPopout?: boolean;
}) {
  const dark = useResolvedDark(useSettings((state) => state.theme));
  const [showSource, setShowSource] = useState(false);
  const sourceId = useId();
  const html = useMemo(() => streaming ? '' : sanitizeHtmlAnswer(source), [source, streaming]);
  if (streaming) return <StreamingHtmlPreview html={source} statusText="正在解析 HTML" />;
  return <div className="md-embedded-ui min-w-0" data-testid="html-answer">
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
