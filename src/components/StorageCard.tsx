import { useCallback, useEffect, useState } from 'react';
import { Button, Card, List, Progress, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { getStorageStats, type StorageStats } from '../store/storageStats';
import { formatSize } from '../utils/format';

/** 设置页「存储占用」卡片：浏览器配额总览 + 应用内分类明细 */
export default function StorageCard() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await getStorageStats());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const percent = stats && stats.quota > 0 ? Math.min(100, (stats.usage / stats.quota) * 100) : 0;

  return (
    <Card
      title="存储占用"
      style={{ marginBottom: 16 }}
      extra={
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>
          刷新
        </Button>
      }
    >
      {stats && (
        <>
          <Progress
            percent={percent}
            size="small"
            status={percent > 90 ? 'exception' : 'normal'}
            format={() =>
              stats.quota > 0
                ? `已用 ${formatSize(stats.usage)} / 配额 ${formatSize(stats.quota)}`
                : `已用 ${formatSize(stats.usage)}`
            }
          />
          <div style={{ margin: '4px 0 12px' }}>
            {stats.persisted ? (
              <Tag color="success">已持久化，系统不会自动清理</Tag>
            ) : (
              <Tag color="warning">未持久化，系统空间紧张时可能清理数据</Tag>
            )}
          </div>
          <List
            size="small"
            dataSource={stats.categories}
            renderItem={(c) => (
              <List.Item>
                <Space size={8}>
                  <Typography.Text>{c.label}</Typography.Text>
                  {stats.usage > 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {((c.bytes / stats.usage) * 100).toFixed(0)}%
                    </Typography.Text>
                  )}
                </Space>
                <Typography.Text>{formatSize(c.bytes)}</Typography.Text>
              </List.Item>
            )}
          />
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
            视频文件存于浏览器 OPFS，字幕/讲义等存于 IndexedDB，仅保存在本机；清除站点数据会全部丢失。
          </Typography.Paragraph>
        </>
      )}
    </Card>
  );
}
