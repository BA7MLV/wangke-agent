import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { ComponentProps } from '@ant-design/x-markdown';
import { imageSourceKind, materialSourceHref, parseMaterialImageHref } from '../materials/imageRefs';
import type { LoadedMaterialImage } from '../materials/images';
import ImagePreview from './ImagePreview';
import './material-image.css';

/** Deduplicate simultaneous references, but retain neither file blobs nor blob URLs globally. */
const pending = new Map<string, Promise<LoadedMaterialImage>>();
const slots: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
let nextSlot = 0;
function load(courseId: string, key: string) {
  const id = JSON.stringify([courseId, key]);
  let promise = pending.get(id);
  if (!promise) {
    const slot = nextSlot++ % slots.length;
    promise = slots[slot].then(() => import('../materials/images')).then((m) => m.loadMaterialImage(courseId, key));
    slots[slot] = promise.catch(() => {});
    pending.set(id, promise);
    void promise.finally(() => pending.delete(id)).catch(() => {});
  }
  return promise;
}

/** Both ![](reference) and [](reference) resolve locally, including after reloading history. */
export function MaterialImage({ href, label, linkOnly = false, onSource }: {
  href: string; label?: React.ReactNode; linkOnly?: boolean; onSource?: (unit?: number) => void;
}) {
  const ref = useMemo(() => parseMaterialImageHref(href), [href]);
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [remoteAllowed, setRemoteAllowed] = useState(false);
  const [result, setResult] = useState<{ href: string; data?: LoadedMaterialImage; url?: string; error?: string }>();
  const current = result?.href === href ? result : undefined;
  const title = typeof label === 'string' && label ? label : current?.data?.image.label || '材料原图';
  const active = linkOnly ? open : visible || open;

  useEffect(() => {
    if (linkOnly || !root.current) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [href, linkOnly]);

  useEffect(() => {
    if (!active || !ref) return;
    let cancelled = false;
    let url = '';
    setResult(undefined);
    setRemoteAllowed(false);
    void load(ref.courseId, ref.key).then((data) => {
      if (cancelled) return;
      if (data.blob) url = URL.createObjectURL(data.blob);
      setResult({ href, data, url });
    }).catch((error: unknown) => {
      if (!cancelled) setResult({ href, error: error instanceof Error ? error.message : '图片读取失败' });
    });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [href, active, ref, attempt]);

  if (!ref) return <span>无效的原图引用</span>;
  const src = current?.url || (remoteAllowed ? current?.data?.remoteUrl : undefined);
  const sourceHref = materialSourceHref(ref.courseId, current?.data?.image.unit);
  const source = <a href={sourceHref} onClick={onSource && current?.data?.image.unit ? (e) => { e.preventDefault(); setOpen(false); onSource(current.data!.image.unit); } : undefined}>打开原文{current?.data?.image.unit ? ` · 第 ${current.data.image.unit} ${ref.key.startsWith('page-') ? '页' : '段'}` : ''}</a>;
  const status = current?.error ? <span className="material-image__status" role="status">{current.error}<Button size="sm" variant="tertiary" onPress={() => setAttempt((n) => n + 1)}>重试</Button></span>
    : current?.data?.remoteUrl && !remoteAllowed ? <span className="material-image__status">此图片来自 {new URL(current.data.remoteUrl).hostname}，加载会向该网站发送请求。<Button size="sm" variant="secondary" onPress={() => setRemoteAllowed(true)}>加载外链图片</Button></span>
      : !src ? <span className="material-image__placeholder" role="status" aria-label="正在读取原图">正在读取原图…</span> : null;
  const fail = () => setResult((r) => r?.href === href ? { ...r, error: '图片无法解码或加载失败，请重试或打开原文核对' } : r);
  const show = () => setOpen(true);
  const download = current?.url && !current.error ? () => {
    const a = document.createElement('a');
    a.href = current.url!;
    a.download = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.${current.data?.blob?.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`;
    a.click();
  } : undefined;
  return <span ref={root} className={linkOnly ? 'material-image-link' : 'material-image'} data-testid="material-image">
    {linkOnly ? <a href={href} onClick={(e) => { e.preventDefault(); show(); }}>{label || '查看原图'}</a> : <>
      {status}
      {src && !current?.error && <Button variant="tertiary" className="material-image__preview" aria-label={`放大查看：${title}`} onPress={show}><img src={src} alt={title} decoding="async" referrerPolicy="no-referrer" onError={fail} /></Button>}
      <span className="material-image__caption"><span>{title}</span>{source}</span>
    </>}
    <ImagePreview isOpen={open} onOpenChange={setOpen} title={title} contentKey={href}
      content={src && !current?.error ? { kind: 'image', src, onError: fail } : undefined}
      status={status} onDownload={download} testId="material-image-dialog"
      footer={<span className="material-image__origin">{current?.data?.courseName}{source}</span>} />
  </span>;
}

export function SourceImage({ src, alt }: Partial<ComponentProps> & { src?: string; alt?: string }) {
  if (src?.startsWith('#source-image/')) return <MaterialImage href={src} label={alt} />;
  if (!src) return <span>{alt || '图片地址缺失'}</span>;
  const kind = imageSourceKind(src);
  if (kind === 'remote') return <RemoteImage key={src} src={src} alt={alt} />;
  if (kind !== 'inline') return <span className="material-image__status">{alt ? `${alt}：` : ''}图片地址不可用，请打开原文查看</span>;
  return <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
}

function RemoteImage({ src, alt }: { src: string; alt?: string }) {
  const [allowed, setAllowed] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!allowed || failed) return <span className="material-image__status">{alt || '外链图片'} · {new URL(src).hostname}{failed ? ' · 图片加载失败' : ' · 加载会向该网站发送请求'}<Button size="sm" variant="secondary" onPress={() => { setFailed(false); setAllowed(true); }}>{failed ? '重试' : '加载外链图片'}</Button></span>;
  return <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function SourceImageLink({ href, children, title, target, rel }: ComponentProps & { href?: string }) {
  if (href?.startsWith('#source-image/')) return <MaterialImage href={href} label={children} linkOnly />;
  return <a href={href} title={typeof title === 'string' ? title : undefined} target={typeof target === 'string' ? target : undefined} rel={typeof rel === 'string' ? rel : undefined}>{children}</a>;
}
