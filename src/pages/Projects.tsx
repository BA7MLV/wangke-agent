import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { AgentProfileDto, ProjectDto } from '@wangke/contracts';
import { serverClient } from '../api/serverClient';
import { PageShell, promptDialog, Sym, toast } from '../ui';
import { useAppNav } from '../components/appNav';
import { projectError } from '../projects/errors';
import '../projects/projects.css';

export default function Projects() {
  const { t } = useTranslation('projects');
  const navigate = useNavigate();
  const nav = useAppNav('projects');
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [agents, setAgents] = useState<AgentProfileDto[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [archived, setArchived] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let ignore = false;
    setLoading(true); setError('');
    Promise.all([serverClient.projects(), serverClient.agents()]).then(([p, a]) => { if (!ignore) { setProjects(p.projects); setAgents(a.agents.filter(a => a.enabled)); } })
      .catch(error => { if (!ignore) setError(projectError(error)); }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [revision]);
  const create = async () => {
    const name = await promptDialog({ headline: t('create'), placeholder: t('name'), confirmText: t('create'), cancelText: t('cancel'), validate: value => !value.trim() || value.length > 100 ? t('errors.invalid_project_name') : null });
    if (!name || !agents[0]) return;
    setBusy(true);
    try { const project = await serverClient.createProject(name, agents[0].id); navigate(`/projects/${project.id}`); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); }
  };
  const archive = async (project: ProjectDto) => {
    setBusy(true);
    try { const updated = await serverClient.updateProject(project.id, { archived: !project.archived }); setProjects(old => old.map(p => p.id === updated.id ? updated : p)); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); }
  };
  const visible = projects.filter(p => archived || !p.archived);
  return <PageShell title={t('title')} rail={nav} wide actions={<Button variant="primary" size="sm" isDisabled={busy || !agents.length} onPress={() => void create()}><Sym name="add" />{t('create')}</Button>}>
    <div className="project-list-header"><p className="project-muted">{t('description')}</p><label><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> {t('showArchived')}</label></div>
    {error ? <div role="alert" className="project-error">{error}<Button onPress={() => setRevision(v => v + 1)}>{t('retry')}</Button></div>
      : loading ? <div className="project-empty"><Spinner /></div>
      : visible.length === 0 ? <div className="project-empty"><Sym name="folder_open" /><p>{t('empty')}</p><Button onPress={() => void create()} isDisabled={busy || !agents.length}>{t('create')}</Button></div>
      : <div className="project-grid">{visible.map(project => <article className="project-card" key={project.id}>
        <button className="project-card-open" onClick={() => navigate(`/projects/${project.id}`)}><Sym name="folder" /><h2>{project.name}</h2>{project.archived && <small>{t('archived')}</small>}</button>
        <code>{project.workspacePath}</code>
        <div className="project-controls"><Button variant="secondary" size="sm" onPress={() => navigate(`/projects/${project.id}`)}>{t('chat')}</Button><Button variant="tertiary" size="sm" onPress={() => navigate(`/projects/${project.id}/files`)}>{t('files')}</Button><Button variant="ghost" size="sm" isDisabled={busy} onPress={() => void archive(project)}>{t(project.archived ? 'restore' : 'archive')}</Button></div>
      </article>)}</div>}
  </PageShell>;
}
