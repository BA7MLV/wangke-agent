import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import type { CloudConfig, CloudTask } from '../../packages/contracts/src/cloud';
import { cloud, cloudRequest } from './state';
import { applyCloudConfig } from './sync';
import { serverClient } from '../api/serverClient';
import { SectionCard, toast } from '../ui';
import { SettingNumber, SettingRow, SettingSelect, SettingSwitch } from '../components/settings/controls';
import BotManagement from './BotManagement';

type Policy = CloudConfig['policy'];
type Capability = 'read' | 'write' | 'remove' | 'shell';
const CAPABILITIES: Array<{ key: Capability; label: string }> = [
  { key: 'read', label: '读取资料' },
  { key: 'write', label: '修改资料' },
  { key: 'remove', label: '删除资料' },
  { key: 'shell', label: '运行命令' },
];
const DECISIONS = [
  { id: 'allow', label: '允许' },
  { id: 'ask', label: '每次询问' },
  { id: 'deny', label: '禁止' },
] as const;

/**
 * 设置 → Bot（云端）。
 *
 * 改动即时生效、即时保存（HIG：设置没有「保存」按钮）。每次写入先读服务器最新配置再合并，
 * 不会把别的设备刚改的模型配置盖掉；失败时回滚到服务器的值并提示。
 */
export default function BotSettings() {
  const [config, setConfig] = useState<CloudConfig>();
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [permissions, setPermissions] = useState<Array<{ id: string; capability: string; arguments: string; status: string }>>([]);
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [error, setError] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadActivity = useCallback(async () => {
    const [a, b] = await Promise.all([
      cloudRequest<{ tasks: CloudTask[] }>('/tasks'),
      cloudRequest<{ permissions: typeof permissions }>('/permissions'),
    ]);
    setTasks(a.tasks);
    setPermissions(b.permissions.filter((p) => p.status === 'pending'));
  }, []);

  useEffect(() => {
    if (!cloud.enabled) return;
    let alive = true;
    void cloudRequest<CloudConfig>('/config').then((value) => { if (alive) setConfig(value); }).catch((e) => alive && setError(e.message));
    void serverClient.agents().then((r) => { if (alive) setAgents(r.agents); }).catch(() => {});
    const tick = () => void loadActivity().catch(() => {});
    tick();
    // 后台标签页不轮询：回到前台时立刻补一次。
    const timer = setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 4000);
    document.addEventListener('visibilitychange', tick);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', tick); clearTimeout(saveTimer.current); };
  }, [loadActivity]);

  const persist = (next: CloudConfig, delay = 0) => {
    setConfig(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const latest = await cloudRequest<CloudConfig>('/config');
          const saved = await cloudRequest<CloudConfig>('/config', { method: 'PUT', body: JSON.stringify({ ...latest, policy: next.policy, trustedAgentIds: next.trustedAgentIds }) });
          setConfig(saved); applyCloudConfig(saved);
        } catch (e) {
          toast.error(`没有保存：${(e as Error).message}`);
          void cloudRequest<CloudConfig>('/config').then(setConfig).catch(() => {});
        }
      })();
    }, delay);
  };
  const setPolicy = (patch: Partial<Policy>, delay = 0) => config && persist({ ...config, policy: { ...config.policy, ...patch } }, delay);

  const resolve = async (id: string, approved: boolean) => {
    try { await cloudRequest(`/permissions/${id}/resolve`, { method: 'POST', body: JSON.stringify({ approved }) }); await loadActivity(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const cancel = async (id: string) => {
    try { await cloudRequest(`/tasks/${id}/cancel`, { method: 'POST' }); await loadActivity(); }
    catch (e) { toast.error((e as Error).message); }
  };

  if (!config) {
    return <div className="grid min-h-40 place-items-center text-muted">{error ? <p role="alert">{error}</p> : <Spinner size="sm" color="current" />}</div>;
  }
  const running = tasks.filter((task) => ['queued', 'running', 'waiting_user'].includes(task.status));
  const workstation = config.policy.read === 'allow' && config.policy.write === 'allow' && config.policy.shell === 'allow' && config.policy.remove === 'ask';

  return (
    <>
      {permissions.length > 0 && (
        <SectionCard title="等待批准" testId="bot-approvals">
          {permissions.map((p) => (
            <div key={p.id} className="flex flex-col gap-2 border-b border-border/70 py-3 last:border-b-0">
              <span className="text-sm font-medium">{p.capability}</span>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background-secondary p-2 text-xs">{p.arguments}</pre>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" className="min-h-11" onPress={() => void resolve(p.id, false)}>拒绝</Button>
                <Button variant="primary" className="min-h-11" onPress={() => void resolve(p.id, true)}>批准</Button>
              </div>
            </div>
          ))}
        </SectionCard>
      )}

      <SectionCard title="权限" testId="bot-policy">
        <SettingSwitch label="专用工作机" isSelected={workstation}
          onChange={(on) => setPolicy(on ? { read: 'allow', write: 'allow', shell: 'allow', remove: 'ask' } : { write: 'ask', shell: 'ask', remove: 'ask' })} />
        {CAPABILITIES.map(({ key, label }) => (
          <SettingSelect key={key} label={label} value={config.policy[key]} options={DECISIONS}
            onChange={(value) => setPolicy({ [key]: value } as Partial<Policy>)} />
        ))}
        <SettingSwitch label="命令可联网" isSelected={config.policy.network === 'allow'} onChange={(on) => setPolicy({ network: on ? 'allow' : 'deny' })} />
        <SettingNumber label="每个任务最多步数" min={1} max={1000} value={config.policy.maxSteps}
          onChange={(value) => value && setPolicy({ maxSteps: Math.min(1000, Math.max(1, Math.round(value))) }, 600)} />
      </SectionCard>

      {agents.length > 0 && (
        <SectionCard title="信任的 Bot" testId="bot-trusted">
          {agents.map((agent) => (
            <SettingSwitch key={agent.id} label={agent.name} isSelected={config.trustedAgentIds?.includes(agent.id) ?? false}
              onChange={(on) => persist({ ...config, trustedAgentIds: on ? [...(config.trustedAgentIds ?? []), agent.id] : (config.trustedAgentIds ?? []).filter((id) => id !== agent.id) })} />
          ))}
        </SectionCard>
      )}

      {running.length > 0 && (
        <SectionCard title="正在运行" testId="bot-tasks">
          {running.slice(0, 20).map((task) => (
            <SettingRow key={task.id} label={<span className="block truncate">{String(task.progress?.message ?? task.kind)}</span>}>
              <Button size="sm" variant="secondary" onPress={() => void cancel(task.id)}>停止</Button>
            </SettingRow>
          ))}
        </SectionCard>
      )}

      <BotManagement />
    </>
  );
}
