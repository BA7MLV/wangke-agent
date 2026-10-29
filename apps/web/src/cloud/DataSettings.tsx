import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { cloud, cloudRequest } from './state';
import { clearCloudLocalData, flushCloud, resolveCloudConflict, stopCloud, useCloudSync } from './sync';
import { serverClient } from '../api/serverClient';
import { SectionCard, confirmDialog, promptDialog, toast } from '../ui';
import { SettingRow } from '../components/settings/controls';
import ArchivedSessionsCard from '../components/settings/ArchivedSessionsCard';
import { logoutCloud } from './logout';
import ServerStorageCard from './ServerStorageCard';

/**
 * 设置 → 数据（云端）。
 *
 * 只放「已积累的东西」：服务器存储、同步状态、旧数据导入、已归档会话、登录凭据，最后是退出与重置。
 * Bot 权限、消息渠道、任务各回各的模块，不再全部堆在这一屏。
 *
 * 处理逻辑：
 *   - 每个操作各自持有忙碌态，点「立即同步」不会把 Passkey 按钮一起灰掉；
 *   - 结果用 toast 报告，不在页面底部堆一行越积越旧的状态文字；
 *   - 退出前先把待同步的改动推上去，推不上去时明确问用户要不要丢弃；
 *   - 重置：先确认、再验密码，服务器清空成功后才清本机缓存，失败时本机数据原样保留。
 */
export default function DataSettings() {
  const sync = useCloudSync();
  const [busy, setBusy] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<Array<{ id: string; createdAt: string }>>([]);

  const loadPasskeys = useCallback(async () => {
    const result = await cloudRequest<{ passkeys: typeof passkeys }>('/passkeys');
    setPasskeys(result.passkeys);
  }, []);
  useEffect(() => { void loadPasskeys().catch(() => {}); }, [loadPasskeys]);

  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try { await action(); if (success) toast.success(success); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };

  const conflict = sync.error.includes('冲突');
  const syncLabel = conflict ? '有冲突' : sync.error ? '同步失败' : sync.pending ? `${sync.pending} 项待同步` : '已同步';

  const importLegacy = () => run('import', async () => {
    if (!await confirmDialog({ headline: '导入此浏览器的旧数据？', description: '仅支持空的云端库，旧数据保留在本机。', confirmText: '导入' })) return;
    const { migrateLocalData } = await import('./migrate');
    await migrateLocalData(() => {});
    toast.success('导入完成');
  });

  const addPasskey = () => run('passkey', async () => {
    if (!browserSupportsWebAuthn()) throw new Error('这个浏览器不支持 Passkey');
    await serverClient.passkeyRegisterVerify(await startRegistration({ optionsJSON: await serverClient.passkeyRegisterOptions() }));
    await loadPasskeys();
  }, 'Passkey 已添加');

  const removePasskey = (id: string) => run(`passkey:${id}`, async () => {
    if (!await confirmDialog({ headline: '移除这枚 Passkey？', confirmText: '移除', danger: true })) return;
    await cloudRequest(`/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadPasskeys();
  });

  const logout = () => run('logout', logoutCloud);

  const reset = () => run('reset', async () => {
    if (!await confirmDialog({
      headline: '重置云端数据？',
      description: '课程、学习记录、聊天、文件、模型配置、Bot 项目、任务和 Passkey 都会删除，且无法恢复。',
      confirmText: '继续',
      danger: true,
    })) return;
    const password = await promptDialog({
      headline: '输入访问密码',
      placeholder: '访问密码',
      inputType: 'password',
      trim: false,
      confirmText: '重置',
      validate: (value) => (value ? null : '请输入访问密码'),
    });
    if (password === null) return;
    const result = await serverClient.resetAccount(password);
    await clearCloudLocalData();
    location.hash = `/setup?secret=${encodeURIComponent(result.bootstrapSecret)}`;
    stopCloud();
  });

  return (
    <>
      {!cloud.worker && <ServerStorageCard />}
      <SectionCard title="同步" testId="cloud-sync-card">
        <SettingRow label="状态">
          <span className={`text-sm ${sync.error ? 'text-danger' : 'text-muted'}`} role="status">{syncLabel}</span>
          <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void run('sync', flushCloud, '已同步')}>立即同步</Button>
        </SettingRow>
        {conflict && (
          <SettingRow label="冲突">
            <Button size="sm" variant="secondary" isDisabled={busy !== null}
              onPress={() => void run('conflict', resolveCloudConflict, '已采用服务器版本，本机副本已下载')}>采用服务器版本</Button>
          </SettingRow>
        )}
        {!cloud.worker && (
          <SettingRow label="旧版浏览器数据">
            <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void importLegacy()}>导入</Button>
          </SettingRow>
        )}
      </SectionCard>

      <ArchivedSessionsCard />

      <SectionCard title="Passkey" testId="cloud-passkeys"
        actions={<Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void addPasskey()}>添加</Button>}>
        {passkeys.length === 0
          ? <p className="py-2 text-sm text-muted">没有 Passkey</p>
          : passkeys.map((p) => (
            <SettingRow key={p.id} label={new Date(p.createdAt).toLocaleString()}>
              <Button size="sm" variant="ghost" className="text-danger" isDisabled={busy !== null} onPress={() => void removePasskey(p.id)}>移除</Button>
            </SettingRow>
          ))}
      </SectionCard>

      <SectionCard title="账号" testId="cloud-account">
        <SettingRow label="退出登录">
          <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void logout()} data-testid="cloud-logout">退出</Button>
        </SettingRow>
        {!cloud.worker && (
          <SettingRow label="重置云端数据" testId="cloud-reset-card">
            <Button size="sm" variant="danger" isDisabled={busy !== null} onPress={() => void reset()} data-testid="cloud-reset-button">
              {busy === 'reset' ? '正在重置…' : '重置'}
            </Button>
          </SettingRow>
        )}
      </SectionCard>
    </>
  );
}
