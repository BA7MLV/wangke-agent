import { useRef, useState } from 'react';
import { Button, Checkbox, Modal, Spinner } from '@heroui/react';
import { SectionCard, Sym, toast, MODAL_CONTAINER_CLASS } from '../ui';
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
      <div className="flex flex-col gap-3">
        <div className="text-[13px] text-muted">
          把字幕、讲义（含帧）、问答、卡片、弹幕、技能与设置打包成迁移包，换设备一键还原。
          不含视频本体（迁移后视频显示「文件已删」，重新导入即可播放）；API Key 不随包导出。
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            isPending={exporting}
            data-testid="btn-export"
            onPress={() => void onExport()}
          >
            {({ isPending }) => (
              <>
                {isPending ? <Spinner size="sm" color="current" /> : <Sym name="download" />}
                导出迁移包
              </>
            )}
          </Button>
          <Button
            variant="secondary"
            isPending={importing}
            data-testid="btn-import"
            onPress={() => fileRef.current?.click()}
          >
            {({ isPending }) => (
              <>
                {isPending ? <Spinner size="sm" color="current" /> : <Sym name="upload" />}
                导入迁移包
              </>
            )}
          </Button>
          <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => void onPickFile(e)} />
        </div>
        {(exporting || importing) && step && (
          <div className="text-xs text-muted" data-testid="migration-step">
            {step}
          </div>
        )}
      </div>

      {/* HeroUI Modal 默认响应 Esc 与点遮罩（onOpenChange 同步回 state，不会「关掉又弹回」）。
          正在导入时也允许关闭 —— 导入在后台继续跑，完成时照样 toast 报结果。 */}
      <Modal.Root isOpen={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog data-testid="import-dialog">
              <Modal.Header>
                <Modal.Heading>导入迁移包</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                {pending && (
                  <div className="flex flex-col gap-3">
                    <div>
                      导出于 {dayjs(pending.preview.manifest.exportedAt).format('YYYY-MM-DD HH:mm')}，包含：
                    </div>
                    <div className="text-[13px] text-muted">
                      {c.videos ?? 0} 个视频 · {c.segments ?? 0} 条字幕 · {c.handouts ?? 0} 份讲义 ·{' '}
                      {c.frames ?? 0} 张帧 · {c.chatSessions ?? 0} 个会话 · {c.cards ?? 0} 张卡片
                      {c.studyDays ? ` · ${c.studyDays} 天学习记录` : ''}
                    </div>
                    {pending.preview.existingVideos > 0 && (
                      <div className="text-[13px] text-danger">
                        其中 {pending.preview.existingVideos} 个视频本机已存在，将跳过（保留本机数据）。
                      </div>
                    )}
                    <div className="text-xs text-muted">
                      迁入的视频标记为「文件已删」，字幕/讲义/问答/卡片可直接使用；重新导入视频本体后可播放。
                    </div>
                    <Checkbox
                      isSelected={restoreSettings}
                      onChange={setRestoreSettings}
                      data-testid="restore-settings"
                    >
                      <Checkbox.Content>同时恢复界面设置（模型、字号等；不含 API Key）</Checkbox.Content>
                    </Checkbox>
                  </div>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" onPress={() => !importing && setPending(null)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  isPending={importing}
                  data-testid="import-confirm"
                  onPress={() => void onConfirmImport()}
                >
                  {({ isPending }) => (
                    <>
                      {isPending && <Spinner size="sm" color="current" />}
                      开始导入
                    </>
                  )}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </SectionCard>
  );
}
