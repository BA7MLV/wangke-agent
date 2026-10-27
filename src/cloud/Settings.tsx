import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { startRegistration } from '@simplewebauthn/browser';
import type { CloudConfig, CloudTask } from '../../packages/contracts/src/cloud';
import { cloud, cloudRequest } from './state';
import { applyCloudConfig, flushCloud, stopCloud, useCloudSync } from './sync';
import { serverClient } from '../api/serverClient';
import { confirmDialog } from '../ui';
import GatewaySettings from './GatewaySettings';
import BotManagement from './BotManagement';

export default function CloudSettings() {
  const [config, setConfig] = useState<CloudConfig>();
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [permissions, setPermissions] = useState<Array<{ id: string; capability: string; arguments: string; status: string }>>([]);
  const [passkeys, setPasskeys] = useState<Array<{ id: string; createdAt: string }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sync = useCloudSync();
  async function loadActivity() {
    const [a, b, c] = await Promise.all([
      cloudRequest<{ tasks: CloudTask[] }>('/tasks'),
      cloudRequest<{ permissions: typeof permissions }>('/permissions'),
      cloudRequest<{ passkeys: typeof passkeys }>('/passkeys'),
    ]);
    setTasks(a.tasks); setPermissions(b.permissions.filter(p => p.status === 'pending')); setPasskeys(c.passkeys);
  }
  useEffect(() => {
    if (!cloud.enabled) return;
    void cloudRequest<CloudConfig>('/config').then(setConfig).catch(e => setError(e.message));
    void serverClient.agents().then(r => setAgents(r.agents)).catch(e => setError(e.message));
    void loadActivity().catch(e => setError(e.message));
    const timer = setInterval(() => void loadActivity().catch(e => setError(e.message)), 3000);
    return () => clearInterval(timer);
  }, []);
  async function act(fn: () => Promise<unknown>, success = '已完成') {
    setBusy(true); setError(''); setMessage('');
    try { await fn(); setMessage(success); await loadActivity(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!cloud.enabled) return <p>云端管理需要通过部署后的服务器 URL 访问。</p>;
  if (!config) return <p role="status">正在读取服务器配置…{error}</p>;
  return <div className="flex flex-col gap-5">
    <h2 className="text-xl font-semibold">云端账号与权限</h2>
    <p className="text-sm text-muted">课程和学习记录按登录账号同步。Provider 与模型能力在「模型」设置中管理。</p>
    <h3 className="text-lg font-semibold">Agent 权限</h3>
    <div className="rounded-xl bg-background-secondary p-4 flex flex-col gap-3">
      <p className="text-sm">把工作环境交给 BOT：日常读写、建项目、切换模型和运行命令可自主进行；删除文件、敏感配置变更和明显危险命令仍需逐次批准。外部 MCP 工具暂时逐次确认。</p>
      <p className="text-sm text-muted">当前命令在隔离工作区运行，不能控制宿主机。命令检测不能识别任意脚本的全部影响，隔离仍是执行边界。</p>
      <Button variant="secondary" className="self-start" onPress={() => setConfig({ ...config, policy: { ...config.policy, read: 'allow', write: 'allow', shell: 'allow', remove: 'ask', network: 'allow' } })}>采用专用工作机权限</Button>
      <span className="text-xs text-muted">点击下方「保存服务器配置」后生效；项目仍遵循自己的权限设置。</span>
    </div>
    {(['read', 'write', 'remove', 'shell'] as const).map((capability, i) => <label key={capability} className="flex items-center justify-between gap-3">
      {['读取资料', '修改资料', '删除资料', '沙盒命令'][i]}<select className="input" value={config.policy[capability]} onChange={e => setConfig({ ...config, policy: { ...config.policy, [capability]: e.target.value } })}>
        <option value="allow">允许</option><option value="ask">每次审批</option><option value="deny">禁止</option>
      </select>
    </label>)}
    <label>沙盒联网<select className="input w-full" value={config.policy.network} onChange={e => setConfig({ ...config, policy: { ...config.policy, network: e.target.value as 'allow' | 'deny' } })}><option value="deny">禁止</option><option value="allow">允许（需部署启用沙盒网络）</option></select></label>
    <label>每任务最多步骤<input className="input w-full" type="number" min={1} max={1000} value={config.policy.maxSteps} onChange={e => setConfig({ ...config, policy: { ...config.policy, maxSteps: Number(e.target.value) } })} /></label>
    <fieldset className="flex flex-col gap-2"><legend>长期信任的 Bot</legend>
      <p className="text-sm text-muted">线程中所有 Bot 都受信任时，日常写入、建项目和命令可跳过逐次审批；删除与敏感配置仍需确认。“禁止”、联网开关和项目权限仍生效。</p>
      {agents.map(agent => <label key={agent.id} className="flex items-center gap-2"><input type="checkbox" checked={config.trustedAgentIds?.includes(agent.id) ?? false} onChange={e => setConfig({ ...config, trustedAgentIds: e.target.checked ? [...(config.trustedAgentIds ?? []), agent.id] : config.trustedAgentIds?.filter(id => id !== agent.id) })} />{agent.name}</label>)}
    </fieldset>
    <Button isDisabled={busy} onPress={() => void act(async () => {
      const latest = await cloudRequest<CloudConfig>('/config');
      const saved = await cloudRequest<CloudConfig>('/config', { method: 'PUT', body: JSON.stringify({ ...latest, policy: config.policy, trustedAgentIds: config.trustedAgentIds }) });
      setConfig(saved); applyCloudConfig(saved);
    }, '服务器配置已保存')}>保存服务器配置</Button>
    <GatewaySettings />
    <BotManagement />
    <h3 className="text-lg font-semibold">Passkey</h3>
    <p className="text-sm text-muted">使用 HTTPS 域名或 localhost 访问，并在安装时配置公开 URL。</p>
    <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => serverClient.passkeyRegisterVerify(await startRegistration({ optionsJSON: await serverClient.passkeyRegisterOptions() })), 'Passkey 已添加')}>添加当前设备 Passkey</Button>
    {passkeys.map(p => <div key={p.id} className="flex items-center justify-between gap-3"><span>{new Date(p.createdAt).toLocaleString()}</span><Button variant="secondary" onPress={() => void act(async () => { if (await confirmDialog({ headline: '移除 Passkey？', description: '这枚密钥将无法再登录，密码和其他 Passkey 仍可使用。', confirmText: '移除', danger: true })) await cloudRequest(`/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); })}>移除</Button></div>)}
    <h3 className="text-lg font-semibold">同步与迁移</h3>
    <p role="status">{sync.error || (sync.pending ? `${sync.pending} 项待同步` : '已同步到服务器')}</p>
    <Button variant="secondary" isDisabled={busy} onPress={() => void act(flushCloud, '同步完成')}>立即同步</Button>
    <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => {
      if (await confirmDialog({ headline: '导入旧浏览器数据？', description: '将此浏览器旧版课程、文件、聊天和学习记录复制到当前账号；仅支持空的云端库，旧数据会保留。', confirmText: '开始导入' })) {
        const { migrateLocalData } = await import('./migrate'); await migrateLocalData(setMessage);
      }
    }, '本机数据导入完成')}>导入旧版浏览器数据</Button>
    {sync.error.includes('冲突') && <Button variant="secondary" onPress={() => void act(async () => { const { resolveCloudConflict } = await import('./sync'); await resolveCloudConflict(); }, '本机冲突副本已下载，已采用服务器版本')}>下载冲突副本并采用服务器版本</Button>}
    <h3 className="text-lg font-semibold">待审批操作</h3>
    {permissions.length === 0 && <p className="text-muted">暂无待审批操作。Bot 命令审批也可在 Bot 会话中处理。</p>}
    {permissions.map(p => <div key={p.id} className="rounded-xl border border-border p-3"><p>{p.capability}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-sm">{p.arguments}</pre><div className="flex gap-2">{[true, false].map(approved => <Button key={String(approved)} isDisabled={busy} variant="secondary" onPress={() => void act(() => cloudRequest(`/permissions/${p.id}/resolve`, { method: 'POST', body: JSON.stringify({ approved }) }))}>{approved ? '批准一次' : '拒绝'}</Button>)}</div></div>)}
    <h3 className="text-lg font-semibold">服务器任务</h3>
    {tasks.slice(0, 30).map(t => <div key={t.id} className="rounded-xl border border-border p-3"><p>{t.kind} · {t.status}</p><p className="break-all text-sm text-muted">{t.error || String(t.progress?.message ?? t.resource)}</p>{['queued', 'running', 'waiting_user'].includes(t.status) && <Button variant="secondary" onPress={() => void act(() => cloudRequest(`/tasks/${t.id}/cancel`, { method: 'POST' }))}>停止任务</Button>}{t.result != null && <details><summary>任务结果</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(t.result, null, 2)}</pre></details>}</div>)}
    {error && <p role="alert" className="text-danger">{error}</p>}{message && <p role="status">{message}</p>}
    <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => { await flushCloud(); await serverClient.logout(); stopCloud(); })}>退出登录</Button>
  </div>;
}
