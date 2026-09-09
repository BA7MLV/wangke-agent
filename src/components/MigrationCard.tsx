import { useRef, useState } from 'react';
import { App, Button, Card, Checkbox, Modal, Space, Typography } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  exportMigrationZip,
  importMigrationZip,
  previewMigrationZip,
  type MigrationPreview,
} from '../store/migration';

/** 设置页「数据迁移」卡片：导出/导入迁移包（不含视频本体，含讲义帧） */
export default function MigrationCard() {
  const { message } = App.useApp();
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
      message.success(`迁移包已导出（${(blob.size / 1024 / 1024).toFixed(1)} MB）`);
    } catch (e) {
      message.error(`导出失败：${(e as Error).message}`);
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
      message.error((err as Error).message);
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
      message.success(`导入完成：${parts.join('，')}${details ? `（${details}）` : ''}`);
      setPending(null);
    } catch (err) {
      message.error(`导入失败：${(err as Error).message}`);
    } finally {
      setImporting(false);
      setStep('');
    }
  };

  const c = pending?.preview.manifest.counts ?? {};

  return (
    <Card title="数据迁移" style={{ marginBottom: 16 }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
          把字幕、讲义（含帧）、问答、卡片、弹幕、技能与设置打包成迁移包，换设备一键还原。
          不含视频本体（迁移后视频显示「文件已删」，重新导入即可播放）；API Key 不随包导出。
        </Typography.Paragraph>
        <Space wrap>
          <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void onExport()}>
            导出迁移包
          </Button>
          <Button icon={<UploadOutlined />} loading={importing} onClick={() => fileRef.current?.click()}>
            导入迁移包
          </Button>
          <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => void onPickFile(e)} />
        </Space>
        {(exporting || importing) && step && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {step}
          </Typography.Text>
        )}
      </Space>

      <Modal
        open={!!pending}
        title="导入迁移包"
        okText="开始导入"
        cancelText="取消"
        confirmLoading={importing}
        onOk={() => void onConfirmImport()}
        onCancel={() => !importing && setPending(null)}
      >
        {pending && (
          <Space direction="vertical" size={8}>
            <Typography.Text>
              导出于 {dayjs(pending.preview.manifest.exportedAt).format('YYYY-MM-DD HH:mm')}，包含：
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {c.videos ?? 0} 个视频 · {c.segments ?? 0} 条字幕 · {c.handouts ?? 0} 份讲义 ·{' '}
              {c.frames ?? 0} 张帧 · {c.chatSessions ?? 0} 个会话 · {c.cards ?? 0} 张卡片
            </Typography.Text>
            {pending.preview.existingVideos > 0 && (
              <Typography.Text type="warning" style={{ fontSize: 13 }}>
                其中 {pending.preview.existingVideos} 个视频本机已存在，将跳过（保留本机数据）。
              </Typography.Text>
            )}
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              迁入的视频标记为「文件已删」，字幕/讲义/问答/卡片可直接使用；重新导入视频本体后可播放。
            </Typography.Paragraph>
            <Checkbox
              checked={restoreSettings}
              onChange={(e) => setRestoreSettings(e.target.checked)}
            >
              同时恢复界面设置（模型、字号等；不含 API Key）
            </Checkbox>
          </Space>
        )}
      </Modal>
    </Card>
  );
}
