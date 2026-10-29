import { Suspense, lazy } from 'react';
import { Spinner } from '@heroui/react';
import StorageCard from '../StorageCard';
import MigrationCard from '../MigrationCard';
import ArchivedSessionsCard from './ArchivedSessionsCard';
import { buildInfoLabel } from '../../utils/buildInfo';
import { cloud } from '../../cloud/state';

const CloudDataSettings = lazy(() => import('../../cloud/DataSettings'));

/**
 * 「数据」模块：只关于「已积累的东西」。
 *
 * - 本机模式：存储占用、迁移包、已归档会话；
 * - 云端模式：服务器存储占用、同步、旧数据导入、已归档会话、Passkey、退出与重置。
 *   云端统计由服务器读取持久化目录与所在磁盘，不使用浏览器本机配额。
 *
 * Bot 权限、消息渠道和服务器任务以前也塞在这一屏，现在各自是独立模块（Bot / 消息渠道）。
 */
export default function DataModule() {
  return (
    <>
      {cloud.enabled ? (
        <Suspense fallback={<div className="grid min-h-40 place-items-center text-muted"><Spinner size="sm" color="current" /></div>}>
          <CloudDataSettings />
        </Suspense>
      ) : (
        <>
          <StorageCard />
          <MigrationCard />
          <ArchivedSessionsCard />
        </>
      )}

      {/* 构建信息：排障用（PWA 后台更新后判断当前跑的是哪个构建），见 docs/plans/2026-09-18-build-info-design.md */}
      <div className="my-1 text-center text-xs text-muted" data-testid="build-info">
        {buildInfoLabel(__BUILD_INFO__, import.meta.env.DEV)}
      </div>
    </>
  );
}
