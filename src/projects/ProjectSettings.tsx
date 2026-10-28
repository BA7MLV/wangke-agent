import { useState } from 'react';
import { Button, Input, Label, Modal, TextArea, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { AgentProfileDto, ProjectDetailDto, ProjectPolicy, ProjectRole } from '@wangke/contracts';
import { serverClient } from '../api/serverClient';
import { MODAL_CONTAINER_CLASS, toast } from '../ui';
import { projectError } from './errors';
import { SettingSelect } from '../components/settings/controls';

export default function ProjectSettings({ project, agents, onChange, onClose }: {
  project: ProjectDetailDto; agents: AgentProfileDto[]; onChange: (project: ProjectDetailDto) => void; onClose: () => void;
}) {
  const { t } = useTranslation('projects');
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.instructions);
  const [policy, setPolicy] = useState(project.policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { onChange(await serverClient.updateProject(project.id, { name, instructions, policy })); toast.success(t('saved')); onClose(); }
    catch (error) { setError(projectError(error)); }
    finally { setBusy(false); }
  };
  const grant = async (agentId: string, role: string) => {
    setBusy(true); setError('');
    try { onChange(await serverClient.grantProject(project.id, agentId, role === 'none' ? null : role as ProjectRole)); }
    catch (error) { setError(projectError(error)); }
    finally { setBusy(false); }
  };
  return <Modal.Root isOpen onOpenChange={open => { if (!open && !busy) onClose(); }}><Modal.Backdrop><Modal.Container size="lg" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
    <Modal.Header><Modal.Heading>{t('settings')}</Modal.Heading></Modal.Header>
    <Modal.Body><div className="project-form">
      <TextField isRequired><Label>{t('name')}</Label><Input value={name} maxLength={100} onChange={e => setName(e.target.value)} /></TextField>
      <TextField><Label>{t('instructions')}</Label><TextArea value={instructions} rows={4} maxLength={16000} onChange={e => setInstructions(e.target.value)} /></TextField>
      <div>
        <SettingSelect label={t('shell')} value={policy.shell} options={(['ask', 'allow', 'deny'] as const).map(value => ({ id: value, label: t(value) }))}
          onChange={value => setPolicy(p => ({ ...p, shell: value as ProjectPolicy['shell'] }))} />
        <SettingSelect label={t('network')} value={policy.network} options={(['deny', 'allow'] as const).map(value => ({ id: value, label: t(value) }))}
          onChange={value => setPolicy(p => ({ ...p, network: value as ProjectPolicy['network'] }))} />
      </div>
      <h3>{t('grants')}</h3>
      <div>
        {agents.map(agent => <SettingSelect key={agent.id} label={agent.name} isDisabled={busy}
          value={project.grants.find(g => g.agentId === agent.id)?.role ?? 'none'}
          options={(['none', 'read', 'write', 'manage'] as const).map(role => ({ id: role, label: t(role) }))}
          onChange={role => void grant(agent.id, role)} />)}
      </div>
      <p className="project-path"><code>{project.workspacePath}</code></p>
      {error && <p className="project-error" role="alert">{error}</p>}
    </div></Modal.Body>
    <Modal.Footer><Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('cancel')}</Button><Button variant="primary" isDisabled={busy || !name.trim()} onPress={() => void save()}>{t('save')}</Button></Modal.Footer>
  </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root>;
}
