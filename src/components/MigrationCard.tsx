import { useRef, useState } from 'react';
import { SectionCard, toast, useMduiEvent } from '../ui';
import dayjs from 'dayjs';
import {
  exportMigrationZip,
  importMigrationZip,
  previewMigrationZip,
  type MigrationPreview,
} from '../store/migration';

/** 设置页「数据迁移」卡片：导出/导入迁移包（不含视频本体，含讲义帧） */
export default function MigrationCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [step, setStep] = useState('');
  const [pending, setPending] = useState<{ file: File; preview: MigrationPreview } | null>(null);
  const [restoreSettings, setRestoreSettings] = useState(true);

  // mdui 的 dialog 自己处理 Esc / 点遮罩关闭时只会把 open 属性拿掉，React 的 state 并不知道，
  // 不同步回来就会出现「关掉又自己弹回」。这里无条件同步（即使正在导入也允许关闭 ——
  // 导入在后台继续跑，完成时照样 toast 报结果，比「关不掉的弹窗」体验好）。
  const dlgRef = useMduiEvent('mdui-dialog', 'closed', () => setPending(null));
  const restoreRef = useMduiEvent('mdui-checkbox', 'change', (_e, el) => setRestoreSettings(el.checked));

  const onExport = async () => {
    setExporting(true);
    setStep('');
    try {
      const blob = await exportMigrationZip(setStep);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wangke-backup-${dayjs().format('YYYY-MM-DD')}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`迁移包已导出（${(blob.size / 1024 / 1024).toFixed(1)} MB）`);
    } catch (e) {
      toast.error(`导出失败：${(e as Error).message}`);
    } finally {
      setExporting(false);
      setStep('');
    }
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选同一文件
    if (!file) return;
    try {
      const preview = await previewMigrationZip(file);
      setPending({ file, preview });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const onConfirmImport = async () => {
    if (!pending) return;
    setImporting(true);
    setStep('');
    try {
      const r = await importMigrationZip(pending.file, { restoreSettings }, setStep);
      const parts = [`新增 ${r.videosAdded} 个视频`];
      if (r.videosSkipped) parts.push(`跳过已存在 ${r.videosSkipped} 个`);
      const details = Object.entries(r.rowsAdded)
        .filter(([t]) => t !== 'videos' && t !== 'folders')
        .map(([t, n]) => `${t} ${n}`)
        .join('、');
      toast.success(`导入完成：${parts.join('，')}${details ? `（${details}）` : ''}`);
      setPending(null);
    } catch (err) {
      toast.error(`导入失败：${(err as Error).message}`);
    } finally {
      setImporting(false);
      setStep('');
    }
  };

  const c = pending?.preview.manifest.counts ?? {};

  return (
    <SectionCard title="数据迁移" testId="card-migration">
      <div className="stack">
        <div className="text-secondary" style={{ fontSize: 13 }}>
          把字幕、讲义（含帧）、问答、卡片、弹幕、技能与设置打包成迁移包，换设备一键还原。
          不含视频本体（迁移后视频显示「文件已删」，重新导入即可播放）；API Key 不随包导出。
        </div>
        <div className="row">
          <mdui-button
            variant="tonal"
            loading={exporting}
            data-testid="btn-export"
            onClick={() => void onExport()}
          >
            <mdui-sym-download slot="icon" />
            导出迁移包
          </mdui-button>
          <mdui-button
            variant="tonal"
            loading={importing}
            data-testid="btn-import"
            onClick={() => fileRef.current?.click()}
          >
            <mdui-sym-upload slot="icon" />
            导入迁移包
          </mdui-button>
          <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => void onPickFile(e)} />
        </div>
        {(exporting || importing) && step && (
          <div className="text-secondary" data-testid="migration-step" style={{ fontSize: 12 }}>
            {step}
          </div>
        )}
      </div>

      <mdui-dialog
        ref={dlgRef}
        open={!!pending}
        headline="导入迁移包"
        data-testid="import-dialog"
        /* mdui 的 dialog 默认**不**响应 Esc 与点遮罩（close-on-esc / close-on-overlay-click 默认 false），
           而 antd 的 Modal 默认两者都响应 —— 显式打开，保持迁移前后的行为一致。
           这也让上面那个 closed 同步真正有用武之地。 */
        close-on-esc
        close-on-overlay-click
      >
        {pending && (
          <div className="stack">
            <div>
              导出于 {dayjs(pending.preview.manifest.exportedAt).format('YYYY-MM-DD HH:mm')}，包含：
            </div>
            <div className="text-secondary" style={{ fontSize: 13 }}>
              {c.videos ?? 0} 个视频 · {c.segments ?? 0} 条字幕 · {c.handouts ?? 0} 份讲义 ·{' '}
              {c.frames ?? 0} 张帧 · {c.chatSessions ?? 0} 个会话 · {c.cards ?? 0} 张卡片
            </div>
            {pending.preview.existingVideos > 0 && (
              <div style={{ fontSize: 13, color: 'rgb(var(--mdui-color-error))' }}>
                其中 {pending.preview.existingVideos} 个视频本机已存在，将跳过（保留本机数据）。
              </div>
            )}
            <div className="text-secondary" style={{ fontSize: 12 }}>
              迁入的视频标记为「文件已删」，字幕/讲义/问答/卡片可直接使用；重新导入视频本体后可播放。
            </div>
            <mdui-checkbox ref={restoreRef} checked={restoreSettings} data-testid="restore-settings">
              同时恢复界面设置（模型、字号等；不含 API Key）
            </mdui-checkbox>
          </div>
        )}
        <mdui-button slot="action" variant="text" onClick={() => !importing && setPending(null)}>
          取消
        </mdui-button>
        <mdui-button
          slot="action"
          variant="filled"
          loading={importing}
          data-testid="import-confirm"
          onClick={() => void onConfirmImport()}
        >
          开始导入
        </mdui-button>
      </mdui-dialog>
    </SectionCard>
  );
}
