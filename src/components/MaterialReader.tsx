import { useCallback, useEffect, useRef, useState } from 'react';
import { db, type VideoRow } from '../store/db';
import { getMaterialFile } from '../store/fileStore';
import { formatCaughtError } from '../utils/errorText';
import { Sym, toast, useSkeletonGate } from '../ui';
import type { HtmlView, MaterialReaderHandle } from '../materials/types';
import PdfReader from './PdfReader';
import DocxReader from './DocxReader';
import DocSkeleton from './DocSkeleton';
import MdReader from './MdReader';
import HtmlReader from './HtmlReader';
import { MaterialInkProvider } from './MaterialInk';
import '../materials/material-reader.css';

/**
 * 阅读材料容器：按格式分发到 PDF / Word / Markdown / HTML 阅读器，并兜住文件读取与断点续读。
 *
 * 定位是**薄壳**：具体的渲染与选区逻辑都在两个子阅读器里，
 * 这里只负责三件跨格式的事：取文件、存阅读位置、把不开检索的原因讲清楚。
 */

interface Props {
  material: VideoRow;
  handleRef: React.RefObject<MaterialReaderHandle | null>;
}

export default function MaterialReader({ material, handleRef }: Props) {
  const [fileUrl, setFileUrl] = useState<string>('');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);

  const format = material.materialFormat ?? 'pdf';
  const materialId = material.id;
  /**
   * 材料打开的等待是**真等待**（OPFS 取字节），所以骨架走延迟门控：
   * 本机快路径（小文件）一个灰块都不出，慢文件（大 PDF / 首次冷启动）才露脸。
   * 与面板不同 —— 面板读的是亚毫秒级的 IndexedDB，骨架几乎只为慢设备准备。
   */
  const showSkeleton = useSkeletonGate(loading);

  useEffect(() => {
    let url = '';
    let cancelled = false;
    setLoading(true);
    setMissing(false);
    (async () => {
      const b = await getMaterialFile(materialId);
      if (cancelled) return;
      if (!b) {
        setMissing(true);
        setLoading(false);
        return;
      }
      setBlob(b);
      if (format === 'pdf') {
        url = URL.createObjectURL(b);
        setFileUrl(url);
      }
      setLoading(false);
    })().catch((e) => {
      if (cancelled) return;
      setMissing(true);
      setLoading(false);
      toast.error(`读取材料失败：${formatCaughtError(e)}`);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [materialId, format]);

  /** 断点续读：阅读位置写回 videos.lastUnit（与视频的 lastPosition 对称） */
  const onUnitChange = useCallback(
    (unit: number) => {
      void db.videos.update(materialId, { lastUnit: unit });
    },
    [materialId],
  );

  /** HTML 的阅读视图（原样 / 分段）写回 videos.htmlView —— 非索引字段，与 lastUnit 同一惯例 */
  const onHtmlViewChange = useCallback(
    (htmlView: HtmlView) => {
      void db.videos.update(materialId, { htmlView });
    },
    [materialId],
  );

  if (loading) {
    return (
      <div className="mr-shell">
        <div className="mr-root" data-testid="material-loading">
          <div className="mr-scroll">
            {showSkeleton && (
              <DocSkeleton variant={format === 'md' || format === 'html' ? 'column' : 'page'} />
            )}
          </div>
        </div>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="mr-shell">
        <div className="mr-root">
          <div className="mr-hint" data-testid="reader-file-missing">
            <Sym name="error" />
            材料文件已删除，问答记录仍然保留。
          </div>
        </div>
      </div>
    );
  }

  return (
    <MaterialInkProvider key={materialId} materialId={materialId}>
    <div className="mr-shell">
      {/*
        「不能检索」必须显式说明：否则用户会以为「问答坏了」，而真实原因在材料自己身上。
        扫描件（仅 PDF：有页面但无文本层）与无正文（压根没内容）是两回事，
        话术不能混用 —— 判定与理由见 chunk.ts 的 judgeMaterialText。
      */}
      {material.scanned === 1 && (
        <div className="mr-hint" data-testid="material-scan-hint">
          <Sym name="warning" />
          <span>
            这份材料<strong>没有文本层</strong>（扫描件），无法参与问答检索；
            但仍可在页面上划词或框选区域提问。
          </span>
        </div>
      )}
      {material.empty === 1 && (
        <div className="mr-hint" data-testid="material-empty-hint">
          <Sym name="warning" />
          <span>
            这份材料<strong>没有正文</strong>，没有可供检索或提问的内容。
          </span>
        </div>
      )}
      {format === 'pdf' ? (
        fileUrl && (
          <PdfReader
            fileUrl={fileUrl}
            initialUnit={material.lastUnit}
            handleRef={handleRef}
            onUnitChange={onUnitChange}
          />
        )
      ) : format === 'md' ? (
        blob && (
          <MdReader
            blob={blob}
            materialId={materialId}
            initialUnit={material.lastUnit}
            handleRef={handleRef}
            onUnitChange={onUnitChange}
          />
        )
      ) : format === 'html' ? (
        blob && (
          <HtmlReader
            blob={blob}
            materialId={materialId}
            initialUnit={material.lastUnit}
            initialView={material.htmlView ?? 'raw'}
            onViewChange={onHtmlViewChange}
            handleRef={handleRef}
            onUnitChange={onUnitChange}
          />
        )
      ) : (
        // Word 走 blob（docx-preview 直接吃 Blob）；blob 未就绪时先不挂载，
        // 否则 blob 引用一变就会整篇重排
        blob && (
          <DocxReader
            blob={blob}
            materialId={materialId}
            initialUnit={material.lastUnit}
            handleRef={handleRef}
            onUnitChange={onUnitChange}
          />
        )
      )}
    </div>
    </MaterialInkProvider>
  );
}
