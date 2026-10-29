import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { AgentProfileDto, ProjectDto } from '@wangke/contracts';
import { serverClient } from '../api/serverClient';
import { MoreMenu, PageShell, promptDialog, Sym, toast } from '../ui';
import { projectError } from '../projects/errors';
import { formatListTime } from './botMessages';
import '../projects/projects.css';
import './bot.css';
import './projects-home.css';

/*
 * 「项目」模式的首页：一张 iOS 分组列表，每个项目一行；右上角「新建项目」。
 * 项目里面是会话 + 文件（BotWorkspace 的项目模式），Bot 的结果在那里做富渲染。
 */
export default function Projects() {
  const { t } = useTranslation('projects');
  const { t: tc, i18n } = useTranslation();
  const navigate = useNavigate();
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
  const visible = projects.filter(p => archived || !p.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const filter = [{ key: 'archived', label: tc(archived ? 'botHome.hideArchived' : 'botHome.showArchived'), icon: <Sym name="archive" />, onAction: () => setArchived(v => !v) }];
  const createButton = (
    <Button isIconOnly variant="ghost" className="rounded-full" aria-label={t('create')} data-testid="project-create" isDisabled={busy || !agents.length} onPress={() => void create()}>
      <Sym name="add" />
    </Button>
  );

  return (
    <PageShell title={t('title')} fill rootClassName="page-projects"
      actions={<><MoreMenu label={tc('botHome.more')} actions={filter} />{createButton}</>}>
      <div className="ph">
        <div className="ph-scroll">
          {error ? <div role="alert" className="bh-inline-error">{error}<Button size="sm" variant="secondary" onPress={() => setRevision(v => v + 1)}>{t('retry')}</Button></div>
            : loading ? <div className="ph-empty"><Spinner color="current" /></div>
            : visible.length === 0 ? (
              <div className="ph-empty">
                <span className="ph-empty__icon" aria-hidden="true"><Sym name="folder" /></span>
                <Button variant="primary" className="ph-empty__cta" onPress={() => void create()} isDisabled={busy || !agents.length}>{t('create')}</Button>
              </div>
            ) : (
              <ul className="ph-list">
                {visible.map(project => (
                  <li key={project.id} className="ph-row" data-archived={project.archived || undefined}>
                    <button type="button" className="ph-row__open" onClick={() => navigate(`/projects/${project.id}`)}>
                      <span className="ph-row__icon" aria-hidden="true"><Sym name="folder" /></span>
                      <span className="ph-row__body">
                        <span className="ph-row__name">{project.name}</span>
                        {project.archived && <span className="ph-row__meta">{t('archived')}</span>}
                      </span>
                      <time className="ph-row__time" dateTime={project.updatedAt}>{formatListTime(project.updatedAt, i18n.language)}</time>
                    </button>
                    <MoreMenu label={tc('botHome.more')} className="ph-row__more" actions={[
                      { key: 'files', label: t('files'), icon: <Sym name="folder_open" />, onAction: () => navigate(`/projects/${project.id}/files`) },
                      { key: 'archive', label: t(project.archived ? 'restore' : 'archive'), icon: <Sym name={project.archived ? 'archive_restore' : 'archive'} />, disabled: busy, onAction: () => void archive(project) },
                    ]} />
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </PageShell>
  );
}
