import { useState } from 'react';
import { Button } from '@heroui/react';
import StorageCard from '../StorageCard';
import MigrationCard from '../MigrationCard';
import ArchivedSessionsCard from './ArchivedSessionsCard';
import { buildInfoLabel } from '../../utils/buildInfo';
import { cloud } from '../../cloud/state';
import { clearCloudLocalData, stopCloud } from '../../cloud/sync';
import { serverClient } from '../../api/serverClient';
import { confirmDialog, promptDialog } from '../../ui';

function ResetCloudDataCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!cloud.enabled || cloud.worker) return null;

  const reset = async () => {
    if (!await confirmDialog({
      headline: '重置云端数据？',
      description: '这会删除课程、学习记录、聊天、文件、模型配置、Bot 项目和任务，并退出当前登录。Passkey 也会被删除。此操作不可撤销。',
      confirmText: '继续重置',
      danger: true,
    })) return;
    const password = await promptDialog({
      headline: '输入当前访问密码',
      description: '验证成功后，服务器会回到首次初始化状态。',
      placeholder: '当前访问密码',
      inputType: 'password',
      trim: false,
      confirmText: '重置并退出',
      validate: value => value ? null : '请输入访问密码',
    });
    if (password === null) return;
    setBusy(true); setError('');
    try {
      const result = await serverClient.resetAccount(password);
      await clearCloudLocalData();
      location.hash = `/setup?secret=${encodeURIComponent(result.bootstrapSecret)}`;
      stopCloud();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return <section className="rounded-xl border border-danger/40 p-4 flex flex-col gap-3" data-testid="cloud-reset-card">
    <h3 className="text-lg font-semibold">重置</h3>
    <p className="text-sm text-muted">清空这套部署的全部云端数据，回到首次打开时的初始化页面。部署目录和服务器运行环境不会删除。</p>
    <Button variant="danger" className="self-start" isDisabled={busy} onPress={() => void reset()} data-testid="cloud-reset-button">{busy ? '正在重置…' : '重置云端数据'}</Button>
    {error && <p className="text-danger text-sm" role="alert">重置失败：{error}</p>}
  </section>;
}

/**
 * 「数据」模块：存储占用、迁移包、已归档会话，以及云端部署的危险重置操作。
 *
 * 这几件事的共同点是**都关于「已积累的东西」** —— 用户进这一屏的动机是
 * 「看看我攒了多少 / 搬个家 / 把收起来的对话找回来」，而不是「调一个开关」。
 * 每张卡各自是独立组件（各自管自己的加载态），这里只负责排版与页脚。
 */
export default function DataModule() {
  return (
    <>
      <StorageCard />
      <MigrationCard />
      {/* 放最后：这是一张「平时不看、有事才回来」的卡，最不打扰 */}
      <ArchivedSessionsCard />
      <ResetCloudDataCard />

      {/* 页脚：构建信息。用途是排障，不是装饰 —— PWA 的 autoUpdate 会在后台更新 SW
          但不刷新当前页面，iPad 上「改了怎么还是老的」时，靠这一行判断当前跑的是哪个构建
          （时间戳单独一个没有参照物，所以带上 commit 短哈希）。详见
          docs/plans/2026-09-18-build-info-design.md */}
      <div
        className="my-1 text-center text-xs text-muted"
        data-testid="build-info"
      >
        {buildInfoLabel(__BUILD_INFO__, import.meta.env.DEV)}
      </div>
    </>
  );
}
