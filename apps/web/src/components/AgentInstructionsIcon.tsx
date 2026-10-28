import { useEffect, useState } from 'react';
import { useSettings } from '../store/settings';

/** AGENTS.md uses the same cover painter and document shape as other Markdown. */
export function AgentInstructionsIcon() {
  const content = useSettings(state => state.agentInstructions);
  const [cover, setCover] = useState<{ content: string; url: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    void (async () => {
      const [{ mdCoverText }, { paintTextCover }] = await Promise.all([
        import('../materials/md'),
        import('../media/textCover'),
      ]);
      if (cancelled) return;
      const { title, preview } = mdCoverText(content);
      const { blob } = await paintTextCover({ title: title ?? 'AGENTS', preview });
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setCover({ content, url: objectUrl });
    })().catch(() => {
      if (!cancelled) setCover(null);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [content]);

  return <span className="finder-document" aria-hidden="true">
    {cover?.content === content ? <img src={cover.url} alt="" loading="lazy" decoding="async" /> : <span className="finder-file-placeholder"><i /><i /><i /><i /><i /><i /></span>}
    <span className="finder-file-extension">MD</span>
  </span>;
}
