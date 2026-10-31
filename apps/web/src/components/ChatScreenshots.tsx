import { useState } from 'react';
import { Button } from '@heroui/react';
import type { ChatImage } from '../store/db';
import { fmtUnitRef, type UnitKind } from '../materials/units';
import { fmtTime } from '../utils/vtt';
import ImageGallery from './ImageGallery';
import ImagePreview from './ImagePreview';

export default function ChatScreenshots({ images, materialKind, onSource }: {
  images: ChatImage[]; materialKind?: UnitKind; onSource: (image: ChatImage) => void;
}) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const selected = Math.min(index, images.length - 1);
  const image = images[selected];
  if (!image) return null;
  const labelOf = (shot: ChatImage) => shot.kind === 'page-selection' && materialKind
    ? fmtUnitRef(materialKind, shot.ts) : fmtTime(shot.ts);
  if (images.length === 1) return <div className="chat-shots">
    <span className="chat-shot">
      <button type="button" className="chat-shot__open" aria-label={`打开截图来源 ${labelOf(image)}`} onClick={() => onSource(image)}>
        <img src={image.thumb} alt="" className="chat-shot__img" />
      </button>
      <span className="chat-ts-chip">{labelOf(image)}</span>
    </span>
  </div>;
  return <div className="chat-shots" data-testid="chat-message-screenshots">
    <ImageGallery count={images.length}>
      <Button variant="ghost" className="chat-image" aria-label={`查看 ${images.length} 张图片`} onPress={() => { setIndex(0); setOpen(true); }}>
        <img src={images[0].thumb} alt={images[0].label || `截图 ${labelOf(images[0])}`} loading="lazy" decoding="async" />
      </Button>
    </ImageGallery>
    <ImagePreview isOpen={open} onOpenChange={setOpen} title={image.label || `截图 ${labelOf(image)}`} contentKey={String(selected)}
      content={{ kind: 'image', src: image.thumb }} navigation={{ index: selected, total: images.length, onChange: setIndex }}
      footer={<Button variant="tertiary" onPress={() => { setOpen(false); onSource(image); }}>打开来源 · {labelOf(image)}</Button>}
      testId="chat-screenshot-viewer" />
  </div>;
}
