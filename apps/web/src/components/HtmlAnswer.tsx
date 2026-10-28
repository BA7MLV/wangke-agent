import { useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { useSettings } from '../store/settings';
import { useResolvedDark } from '../ui/theme';
import StreamingHtmlPreview from './StreamingHtmlPreview';
import WidgetBlock from './WidgetBlock';
import { sanitizeHtmlAnswer } from '../utils/htmlAnswer';
import { copyText } from '../utils/clipboard';
import { toast } from '../ui';

/** Keep CSS in an opaque sandbox, without granting ordinary code examples script/tool privileges. */
export default function HtmlAnswer({ source, streaming = false }: { source: string; streaming?: boolean }) {
  const dark = useResolvedDark(useSettings((state) => state.theme));
  const [showSource, setShowSource] = useState(false);
  const html = useMemo(() => streaming ? '' : sanitizeHtmlAnswer(source), [source, streaming]);
  if (streaming) return <StreamingHtmlPreview html={source} statusText="正在解析 HTML" />;
  return <div className="md-embedded-ui min-w-0" data-testid="html-answer">
    <div className="flex flex-wrap justify-end gap-2 py-1">
      <Button size="sm" variant="tertiary" onPress={() => void copyText(source).then((ok) => {
        if (ok) toast.success('HTML 源码已复制');
        else toast.error('复制失败');
      })}>复制 HTML</Button>
      <Button size="sm" variant="tertiary" aria-expanded={showSource} onPress={() => setShowSource((value) => !value)}>
        {showSource ? '收起 HTML 源码' : '查看 HTML 源码'}
      </Button>
    </div>
    <WidgetBlock payload={{ html }} dark={dark} disabled allowPopout={false} />
    {showSource && <pre className="my-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-default p-3 text-xs" data-testid="html-answer-source"><code>{source}</code></pre>}
  </div>;
}
