import { useEffect, useState } from 'react';
import type { ResourceEntry } from '@wangke/contracts/resources';
import { serverClient } from '../api/serverClient';
import { db } from '../store/db';
import { useCoverRevision } from '../store/covers';
import { Sym } from '../ui';

/** Keep the original Finder document/cover appearance in the filesystem library. */
export function ResourceFileIcon({ entry }: { entry: ResourceEntry }) {
  const { projectId, path, name, courseId, revision, missing } = entry;
  const coverRevision = useCoverRevision();
  const [cover, setCover] = useState<{ key: string; url: string } | null>(null);
  const markdown = /\.(md|markdown)$/i.test(name);
  const video = /\.(mp4|mov|m4v|webm|mkv|avi|flv|ts|m2ts|mpeg|mpg|wmv|3gp|rmvb|rm)$/i.test(name);
  const image = /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name);
  const key = JSON.stringify([projectId, path, courseId, revision, missing]);

  useEffect(() => {
    if (image && !missing) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    void (async () => {
      const stored = courseId ? await db.covers.get(courseId).catch(() => undefined) : undefined;
      let blob = stored?.blob;
      // Markdown is live filesystem content. Repaint on its file revision, rather
      // than showing an old derived cover after a reader/Bot edit. User covers win.
      if (markdown && !missing && stored?.source !== 'user') {
        const [file, { mdCoverText }, { paintTextCover }] = await Promise.all([
          serverClient.projectText(projectId, path),
          import('../materials/md'),
          import('../media/textCover'),
        ]);
        if (cancelled) return;
        const { title, preview } = mdCoverText(file.text);
        blob = (await paintTextCover({ title: title ?? name.replace(/\.(md|markdown)$/i, ''), preview })).blob;
      }
      if (cancelled) return;
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        setCover({ key, url: objectUrl });
      } else setCover(null);
    })().catch(() => {
      // A missing/unreadable file must still have a usable document icon.
      if (!cancelled) setCover(null);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, path, name, courseId, revision, missing, key, markdown, image, coverRevision]);

  const src = image && !missing ? serverClient.projectDownloadUrl(projectId, path) : cover?.key === key ? cover.url : null;
  const extension = markdown ? 'MD' : name.includes('.') ? name.split('.').pop()!.toUpperCase() : video ? 'VIDEO' : 'FILE';
  return <span className="resource-file-icon" aria-hidden="true">
    <span className={video ? 'finder-video' : 'finder-document'}>
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <span className="finder-file-placeholder">{video ? <Sym name="play_circle" /> : <><i /><i /><i /><i /><i /><i /></>}</span>}
      <span className="finder-file-extension">{extension}</span>
    </span>
  </span>;
}
