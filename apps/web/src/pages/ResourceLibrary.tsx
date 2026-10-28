import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input, Label, Modal, SearchField, Spinner, TextArea, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { AgentProfileDto, ProjectDetailDto } from '@wangke/contracts';
import type { ResourceDirectory, ResourceEntry } from '@wangke/contracts/resources';
import { request, serverClient } from '../api/serverClient';
import { useAppNav } from '../components/appNav';
import { useLibraryNavigation } from '../store/libraryNavigation';
import { db } from '../store/db';
import { flushCloud } from '../cloud/sync';
import { MoreMenu, PageShell, Sym, toast, promptDialog, confirmDialog, MODAL_CONTAINER_CLASS } from '../ui';
import { projectError } from '../projects/errors';
import ProjectSettings from '../projects/ProjectSettings';
import { formatSize } from '../utils/format';
import { probeDuration } from '../utils/mediaDuration';
import { useIsMobile } from '../utils/useMobile';
import './library.css';
import '../projects/projects.css';
import './resources.css';

const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const keyOf = (entry: ResourceEntry) => `${entry.projectId}:${entry.path}:${entry.courseId ?? ''}`;
const validName = (value: string) => !value.trim() || value === '.' || value === '..' || /[\\/\u0000-\u001f\u007f]/.test(value) || new TextEncoder().encode(value).length > 255;

/** The server filesystem is the browser's directory listing, not a second library. */
export default function ResourceLibrary({ onImport }: { onImport: (folderId?: number) => void }) {
  const { t } = useTranslation('projects');
  const navigate = useNavigate();
  const nav = useAppNav('home');
  const mobile = useIsMobile();
  const [search, setSearch] = useSearchParams();
  const projectId = search.get('folder') ?? undefined;
  const directory = search.get('path') ?? '';
  const [data, setData] = useState<ResourceDirectory | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [view, setView] = useState<'icons' | 'list'>('icons');
  const [settings, setSettings] = useState<{ project: ProjectDetailDto; agents: AgentProfileDto[] } | null>(null);
  const [editor, setEditor] = useState<{ projectId: string; path: string; text: string; revision: string | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const locationKey = `${projectId ?? ''}:${directory}`;
  const loadedLocation = useRef('');
  const refresh = () => setRevision(n => n + 1);
  useEffect(() => {
    if (projectId) useLibraryNavigation.getState().setFolderHistory(h => h.entries[h.index]?.startsWith('system') ? { entries: [null], index: 0 } : h);
  }, [projectId]);
  useEffect(() => {
    let ignore = false;
    if (loadedLocation.current !== locationKey) { setLoading(true); setData(null); }
    const params = new URLSearchParams({ path: directory, archived: String(archived) });
    if (projectId) params.set('projectId', projectId);
    request<ResourceDirectory>(`/resources?${params}`).then(result => {
      if (!ignore) { setData(result); setError(''); loadedLocation.current = locationKey; }
    }).catch(error => { if (!ignore) setError(projectError(error)); }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [projectId, directory, archived, revision, locationKey]);
  useEffect(() => {
    const update = () => { if (!document.hidden) setRevision(n => n + 1); };
    const timer = setInterval(update, 5000);
    window.addEventListener('focus', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); };
  }, []);
  const openDirectory = (id?: string, path = '') => {
    setQuery('');
    setSearch(id ? { folder: id, ...(path ? { path } : {}) } : {});
  };
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); refresh(); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); }
  };
  const createFolder = async () => {
    const name = await promptDialog({ headline: t('newFolder'), confirmText: t('save'), cancelText: t('cancel'), validate: value => validName(value) ? t('errors.invalid_project_path') : null });
    if (!name) return;
    await perform(async () => {
      if (projectId) await serverClient.projectDirectory(projectId, join(directory, name.trim()));
      else await request('/resources/folders', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    });
  };
  const uploadFiles = async (files: File[]) => {
    if (!data || !files.length) return;
    await perform(async () => {
      const errors: string[] = [];
      for (const file of files) {
        try {
          const id = projectId ?? data.rootId;
          await serverClient.uploadProjectFile(id, join(directory, file.name), file);
          if (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|flv|ts|m2ts|mpeg|mpg|wmv|3gp|rmvb|rm)$/i.test(file.name)) {
            const listing = await request<ResourceDirectory>(`/resources?${new URLSearchParams({ projectId: id, path: directory })}`);
            const entry = listing.entries.find(entry => entry.name === file.name);
            if (entry?.courseId) {
              const duration = await probeDuration(file);
              await flushCloud();
              if (duration) await db.videos.update(entry.courseId, { duration });
            }
          }
        }
        catch (error) { errors.push(`${file.name}: ${projectError(error)}`); }
      }
      if (errors.length) throw new Error(errors.join('\n'));
    });
  };
  const upload = (event: ChangeEvent<HTMLInputElement>) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void uploadFiles(files); };
  const open = async (entry: ResourceEntry) => {
    if (entry.kind === 'directory') { openDirectory(entry.projectId, entry.path); return; }
    await perform(async () => {
      if (entry.courseId) {
        await flushCloud();
        const course = await db.videos.get(entry.courseId);
        if (course?.kind === 'material' && course.status === 'new' && course.materialFormat && !entry.missing) {
          const { startMaterialJob } = await import('../pipelines/materialJob');
          void startMaterialJob(course.id, course.materialFormat).catch(error => toast.error(projectError(error)));
        }
        navigate(`/player/${encodeURIComponent(entry.courseId)}`, { state: { libraryReturn: `/library${search.size ? `?${search}` : ''}` } });
      } else {
        const file = await serverClient.projectText(entry.projectId, entry.path);
        setEditor({ ...file, projectId: entry.projectId });
      }
    });
  };
  const editSettings = async (id: string) => perform(async () => {
    const [project, { agents }] = await Promise.all([serverClient.project(id), serverClient.agents()]);
    setSettings({ project, agents: agents.filter(a => a.enabled) });
  });
  const rename = async (entry: ResourceEntry) => {
    const name = await promptDialog({ headline: t('rename'), defaultValue: entry.name, confirmText: t('save'), cancelText: t('cancel'), validate: value => validName(value) ? t('errors.invalid_project_path') : null });
    if (!name || name === entry.name) return;
    await perform(() => entry.scope ? serverClient.updateProject(entry.projectId, { name }) : request('/resources/move', { method: 'POST', body: JSON.stringify({ projectId: entry.projectId, path: entry.path, targetProjectId: entry.projectId, target: join(directory, name), revision: entry.revision }) }));
  };
  const remove = async (entry: ResourceEntry) => {
    if (entry.scope) {
      await perform(() => serverClient.updateProject(entry.projectId, { archived: !entry.scope!.archived }));
      return;
    }
    if (!await confirmDialog({ headline: t('deleteConfirm', { name: entry.name }), description: t('removeHint'), confirmText: t('delete'), cancelText: t('cancel'), danger: true })) return;
    await perform(() => serverClient.deleteProjectFile(entry.projectId, entry.path, entry.revision));
  };
  const moveInto = (event: React.DragEvent, id: string, path: string) => {
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer.files.length) { if (id === (projectId ?? data?.rootId) && path === directory) void uploadFiles([...event.dataTransfer.files]); return; }
    try {
      const entry = JSON.parse(event.dataTransfer.getData('application/x-resource-entry')) as ResourceEntry;
      if (!entry.path || entry.scope || (entry.projectId === id && entry.path === join(path, entry.name))) return;
      void perform(() => request('/resources/move', { method: 'POST', body: JSON.stringify({ projectId: entry.projectId, path: entry.path, targetProjectId: id, target: join(path, entry.name), revision: entry.revision }) }));
    } catch { /* Unrelated drag payload. */ }
  };
  const entries = (data?.entries ?? []).filter(entry => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const breadcrumbs = directory.split('/').filter(Boolean);
  const readOnly = Boolean(data?.project?.archived);
  return <PageShell title={t('resources')} rail={nav} fill rootClassName="page-library">
    <section className="finder-window resource-window" data-mobile={mobile || undefined} aria-label={t('resources')}
      onDragOver={e => { if (!busy && !readOnly) e.preventDefault(); }} onDrop={e => { if (data && !busy && !readOnly) moveInto(e, projectId ?? data.rootId, directory); }}>
      <header className="finder-toolbar">
        <div className="finder-navigation"><Button isIconOnly variant="ghost" aria-label={t('back')} isDisabled={!projectId} onPress={() => openDirectory(directory ? projectId : undefined, breadcrumbs.slice(0, -1).join('/'))}><Sym name="chevron_left" /></Button></div>
        <h2 className="finder-title">{breadcrumbs.at(-1) ?? data?.project?.name ?? t('resources')}</h2>
        <div className="finder-tools">
          <Button isIconOnly variant="ghost" aria-label={t('changeView')} onPress={() => setView(v => v === 'icons' ? 'list' : 'icons')}><Sym name={view === 'icons' ? 'list' : 'grid_view'} /></Button>
          <Button isIconOnly variant="ghost" data-testid="btn-new-folder" aria-label={t('newFolder')} isDisabled={busy || readOnly || loading} onPress={() => void createFolder()}><Sym name="create_new_folder" /></Button>
          <Button isIconOnly variant="ghost" aria-label={t('upload')} isDisabled={busy || readOnly || loading} onPress={() => input.current?.click()}><Sym name="upload" /></Button>
          <MoreMenu label={t('more')} actions={[
            { key: 'import', label: t('importMaterials'), icon: <Sym name="link" />, disabled: busy || readOnly || !data, onAction: () => onImport(data?.folderId) },
            { key: 'new', label: t('newFile'), icon: <Sym name="edit" />, disabled: busy || readOnly || !data, onAction: () => setEditor({ projectId: projectId ?? data!.rootId, path: '', text: '', revision: null }) },
            { key: 'refresh', label: t('refresh'), icon: <Sym name="refresh" />, onAction: refresh },
            ...(projectId ? [
              { key: 'chat', label: t('botChat'), icon: <Sym name="chat" />, onAction: () => navigate(`/library/folders/${projectId}/chat`) },
              { key: 'settings', label: t('settings'), icon: <Sym name="tune" />, onAction: () => void editSettings(projectId) },
            ] : [{ key: 'archived', label: t(archived ? 'hideArchived' : 'showArchived'), icon: <Sym name="archive" />, onAction: () => setArchived(v => !v) }]),
          ]} />
        </div>
        <SearchField className="finder-search" aria-label={t('searchFolder')} value={query} onChange={setQuery}><SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder={t('searchFolder')} /><SearchField.ClearButton /></SearchField.Group></SearchField>
        <input ref={input} type="file" multiple hidden onChange={upload} />
      </header>
      {error && <div role="alert" className="project-error resource-notice">{error}<Button size="sm" onPress={refresh}>{t('retry')}</Button></div>}
      {readOnly && <p className="resource-notice">{t('readOnly')}</p>}
      <div className="finder-canvas" data-testid="resource-list" aria-busy={loading || busy}>
        {loading ? <div className="project-empty"><Spinner /></div> : <>
          <ul className="resource-grid" data-view={view}>
            {!projectId && !query && <li className="resource-tile" data-testid="system-folder"><button className="resource-open" onClick={() => useLibraryNavigation.getState().setFolderHistory(h => ({ entries: [...h.entries.slice(0, h.index + 1), 'system'], index: h.index + 1 }))}><Sym name="folder" /><span>system</span><small>{t('systemFiles')}</small></button></li>}
            {entries.map(entry => <li key={keyOf(entry)} className="resource-tile" data-kind={entry.kind} data-testid="resource-entry"
              draggable={!entry.scope && !entry.missing && !busy && !readOnly} onDragStart={e => { e.dataTransfer.setData('application/x-resource-entry', JSON.stringify(entry)); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={e => { if (entry.kind === 'directory' && !entry.scope?.archived) e.preventDefault(); }} onDrop={e => { if (entry.kind === 'directory' && !busy && !entry.scope?.archived) moveInto(e, entry.projectId, entry.path); }}>
              <button className="resource-open" disabled={busy} onClick={() => void open(entry)} title={entry.scope?.workspacePath ?? entry.path}>
                <Sym name={entry.kind === 'directory' ? 'folder' : 'description'} />
                <span>{entry.name}</span><small>{entry.scope?.archived ? t('archived') : entry.kind === 'directory' ? t('folder') : entry.missing ? t('learningRecord') : formatSize(entry.size)}</small>
              </button>
              <MoreMenu className="resource-more" label={`${t('more')} · ${entry.name}`} actions={[
                ...(!entry.missing ? [{ key: 'rename', label: t('rename'), icon: <Sym name="edit" />, disabled: busy || readOnly, onAction: () => void rename(entry) }] : []),
                ...(entry.scope ? [
                  { key: 'chat', label: t('botChat'), icon: <Sym name="chat" />, onAction: () => navigate(`/library/folders/${entry.projectId}/chat`) },
                  { key: 'settings', label: t('settings'), icon: <Sym name="tune" />, onAction: () => void editSettings(entry.projectId) },
                ] : entry.kind === 'file' && !entry.missing ? [{ key: 'download', label: t('download'), icon: <Sym name="download" />, onAction: () => { const link = document.createElement('a'); link.href = serverClient.projectDownloadUrl(entry.projectId, entry.path); link.download = entry.name; link.click(); } }] : []),
                ...(!entry.missing ? [{ key: 'remove', label: entry.scope ? t(entry.scope.archived ? 'restore' : 'archive') : t('delete'), icon: <Sym name={entry.scope ? 'archive' : 'delete'} />, danger: !entry.scope, disabled: busy || readOnly, onAction: () => void remove(entry) }] : []),
              ]} />
            </li>)}
          </ul>
          {!entries.length && (projectId || query) && !error && <div className="project-empty">{query ? t('noResults') : t('folderEmpty')}</div>}
        </>}
      </div>
      <footer className="finder-footer"><nav className="finder-path" aria-label={t('workspace')}><Button variant="ghost" size="sm" onPress={() => openDirectory()}>{t('resources')}</Button>
        {projectId && <><Sym name="chevron_right" /><Button variant="ghost" size="sm" onPress={() => openDirectory(projectId)}>{data?.project?.name}</Button></>}
        {breadcrumbs.map((part, i) => <span key={i}><Sym name="chevron_right" /><Button variant="ghost" size="sm" onPress={() => openDirectory(projectId, breadcrumbs.slice(0, i + 1).join('/'))}>{part}</Button></span>)}
      </nav><div className="finder-status"><span className="resource-count">{busy ? t('working') : t('itemCount', { count: entries.length })}</span>{data?.project && <code>{data.project.workspacePath}{directory ? `/${directory}` : ''}</code>}</div></footer>
    </section>
    {settings && <ProjectSettings project={settings.project} agents={settings.agents} onClose={() => setSettings(null)} onChange={project => { setSettings(s => s && ({ ...s, project })); refresh(); }} />}
    {editor && <Modal.Root isOpen onOpenChange={open => { if (!open && !busy) setEditor(null); }}><Modal.Backdrop><Modal.Container size="lg" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
      <Modal.Header><Modal.Heading>{editor.revision === null ? t('newFile') : editor.path}</Modal.Heading></Modal.Header>
      <Modal.Body><div className="project-form">
        {editor.revision === null && <TextField><Label>{t('filename')}</Label><Input value={editor.path} onChange={e => setEditor({ ...editor, path: e.target.value })} placeholder="notes.md" /></TextField>}
        <TextField><Label>{t('content')}</Label><TextArea className="project-text-editor" rows={15} value={editor.text} readOnly={readOnly} onChange={e => setEditor({ ...editor, text: e.target.value })} /></TextField>
      </div></Modal.Body>
      <Modal.Footer><Button variant="tertiary" isDisabled={busy} onPress={() => setEditor(null)}>{t('cancel')}</Button><Button variant="primary" isDisabled={busy || readOnly || !editor.path.trim() || (editor.revision === null && validName(editor.path))} onPress={() => void perform(async () => {
        await serverClient.writeProjectText(editor.projectId, editor.revision === null ? join(directory, editor.path.trim()) : editor.path, editor.text, editor.revision); setEditor(null);
      })}>{t('save')}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root>}
  </PageShell>;
}
