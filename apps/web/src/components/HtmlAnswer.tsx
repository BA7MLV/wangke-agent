import { useEffect, useId, useState } from 'react';
import { useSettings } from '../store/settings';
import { useResolvedDark } from '../ui/theme';
import StreamingHtmlPreview from './StreamingHtmlPreview';
import WidgetBlock from './WidgetBlock';
import { openLegacyHtmlWork } from '../store/legacyHtmlWorks';
import type { WidgetPayload } from '../harness/widgetRuntime';
import type { HtmlContentType } from '../utils/htmlContent';
import { Button } from '@heroui/react';
import { copyText } from '../utils/clipboard';
import { toast } from '../ui';
import type { ArtifactActions } from './ArtifactEditor';
import { useArtifactRowId } from './ArtifactEditor';
import CodeBlock from './CodeBlock';

/** Compatibility surface only. New works arrive as structured show_widget payloads. */
export default function HtmlAnswer({ source, streaming = false, editActions, allowPopout = true, contentType = 'example', persistLegacy = true }: {
  source: string; streaming?: boolean; editActions?: ArtifactActions | null; allowPopout?: boolean; contentType?: HtmlContentType; persistLegacy?: boolean;
}) {
  if (contentType !== 'interactive') return <HtmlSource source={source} />;
  if (streaming) return <StreamingHtmlPreview html={source} statusText="正在生成预览" />;
  return <LegacyHtmlAnswer key={source} source={source} editActions={editActions} allowPopout={allowPopout} persistLegacy={persistLegacy} />;
}

function HtmlSource({ source }: { source: string }) {
  return <div className="md-embedded-ui min-w-0" data-testid="html-code-example">
    <CodeBlock source={source} language="html" />
  </div>;
}

function LegacyHtmlAnswer({ source, editActions, allowPopout, persistLegacy }: {
  source: string; editActions?: ArtifactActions | null; allowPopout: boolean; persistLegacy: boolean;
}) {
  const dark = useResolvedDark(useSettings((state) => state.theme));
  const ownerRowId = useArtifactRowId();
  const rowId = persistLegacy ? ownerRowId : undefined;
  const [showSource, setShowSource] = useState(false);
  const sourceId = useId();
  const [payload, setPayload] = useState<WidgetPayload>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void openLegacyHtmlWork(source, rowId).then(value => { if (active) setPayload(value); }, reason => {
      if (active) { setPayload(undefined); setError(reason instanceof Error ? reason.message : String(reason)); }
    });
    return () => { active = false; };
  }, [source, rowId, attempt]);
  return <div className="md-embedded-ui min-w-0" data-testid="html-answer">
    {error ? <div role="alert"><p>预览失败：{error}</p>
      <Button size="sm" variant="tertiary" onPress={() => setAttempt(value => value + 1)}>重试预览</Button>
      <HtmlSource source={source} />
    </div> : !payload ? <p role="status">正在准备预览…</p> : <WidgetBlock payload={payload} dark={dark} disabled allowPopout={allowPopout} editActions={editActions}
      htmlActions={{
        sourceOpen: showSource, sourceId, toggleSource: () => setShowSource((value) => !value),
        copySource: () => void copyText(source).then((ok) => {
          if (ok) toast.success('HTML 源码已复制');
          else toast.error('复制失败');
        }),
      }} />}
    {showSource && <pre id={sourceId} aria-label="HTML 源码" className="my-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-default p-3 text-xs" data-testid="html-answer-source"><code>{source}</code></pre>}
  </div>;
}
