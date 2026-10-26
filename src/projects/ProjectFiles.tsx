import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Button, Input, Label, Modal, Spinner, TextArea, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { ProjectDto, ProjectFileDto } from '@wangke/contracts';
import { serverClient } from '../api/serverClient';
import { confirmDialog, MODAL_CONTAINER_CLASS, promptDialog, Sym, toast } from '../ui';
import { formatSize } from '../utils/format';
import { projectError } from './errors';

export default function ProjectFiles({ project }: { project: ProjectDto }) {
  const { t } = useTranslation('projects');
  const [directory, setDirectory] = useState('');
  const [files, setFiles] = useState<ProjectFileDto[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ path: string; text: string; revision: string | null } | null>(null);
  const [editorError, setEditorError] = useState('');
  const uploadInput = useRef<HTMLInputElement>(null);
  const join = (name: string) => directory ? `${directory}/${name}` : name;
  useEffect(() => {
    let ignore = false;
    setLoading(true); setError(''); setFiles([]);
    serverClient.projectFiles(project.id, directory).then(result => { if (!ignore) setFiles(result.files); })
      .catch(error => { if (!ignore) setError(projectError(error)); }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [project.id, directory, refresh]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])]; event.target.value = '';
    if (!selected.length) return;
    setBusy(true);
    try { for (const file of selected) await serverClient.uploadProjectFile(project.id, join(file.name), file); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); setRefresh(v => v + 1); }
  };
  const mkdir = async () => {
    const name = await promptDialog({ headline: t('newFolder'), placeholder: t('filename'), confirmText: t('save'), cancelText: t('cancel') });
    if (!name) return;
    setBusy(true);
    try { await serverClient.projectDirectory(project.id, join(name)); setRefresh(v => v + 1); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); }
  };
  const open = async (file: ProjectFileDto) => {
    if (file.kind === 'directory') { setDirectory(file.path); return; }
    setBusy(true); setEditorError('');
    try { const result = await serverClient.projectText(project.id, file.path); setEditor(result); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); }
  };
  const remove = async (file: ProjectFileDto) => {
    if (!await confirmDialog({ headline: t('deleteConfirm', { name: file.name }), confirmText: t('delete'), cancelText: t('cancel'), danger: true })) return;
    setBusy(true);
    try { await serverClient.deleteProjectFile(project.id, file.path, file.revision); setRefresh(v => v + 1); }
    catch (error) { toast.error(projectError(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!editor) return;
    setBusy(true); setEditorError('');
    try { await serverClient.writeProjectText(project.id, editor.revision === null ? join(editor.path) : editor.path, editor.text, editor.revision); setEditor(null); setRefresh(v => v + 1); }
    catch (error) { setEditorError(projectError(error)); }
    finally { setBusy(false); }
  };
  const breadcrumbs = directory ? directory.split('/') : [];
  return <section className="project-files" aria-label={t('files')}>
    <div className="project-controls">
      <Button size="sm" variant="secondary" isDisabled={busy || project.archived} onPress={() => uploadInput.current?.click()}><Sym name="upload" />{t('upload')}</Button>
      <Button size="sm" variant="tertiary" isDisabled={busy || project.archived} onPress={() => void mkdir()}><Sym name="create_new_folder" />{t('newFolder')}</Button>
      <Button size="sm" variant="tertiary" isDisabled={busy || project.archived} onPress={() => { setEditorError(''); setEditor({ path: '', text: '', revision: null }); }}><Sym name="edit" />{t('newFile')}</Button>
      <Button size="sm" variant="ghost" isDisabled={busy || loading} onPress={() => setRefresh(v => v + 1)}><Sym name="refresh" />{t('refresh')}</Button>
      {busy && <Spinner size="sm" />}
      <input ref={uploadInput} type="file" multiple hidden onChange={upload} />
    </div>
    <nav className="project-breadcrumbs" aria-label={t('workspace')}>
      <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setDirectory('')}>{project.name}</Button>
      {breadcrumbs.map((part, i) => <span key={i}><Sym name="chevron_right" /><Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setDirectory(breadcrumbs.slice(0, i + 1).join('/'))}>{part}</Button></span>)}
    </nav>
    {error ? <div className="project-error" role="alert">{error}<Button size="sm" onPress={() => setRefresh(v => v + 1)}>{t('retry')}</Button></div>
      : loading ? <div className="project-empty"><Spinner /></div>
      : files.length === 0 ? <p className="project-empty">{t('folderEmpty')}</p>
      : <ul className="project-file-list">{files.map(file => <li key={file.path}>
        <button className="project-file-open" disabled={busy} onClick={() => void open(file)} aria-label={file.kind === 'directory' ? file.name : `${t('edit')} · ${file.name}`}>
          <Sym name={file.kind === 'directory' ? 'folder' : 'description'} /><span>{file.name}<small>{file.kind === 'file' ? formatSize(file.size) : ''}</small></span>
        </button>
        {file.kind === 'file' && <a className="project-download" href={serverClient.projectDownloadUrl(project.id, file.path)} download aria-label={`${t('download')} · ${file.name}`}><Sym name="download" /></a>}
        <Button isIconOnly size="sm" variant="ghost" aria-label={`${t('delete')} · ${file.name}`} isDisabled={busy || project.archived} onPress={() => void remove(file)}><Sym name="delete" /></Button>
      </li>)}</ul>}
    {editor && <Modal.Root isOpen onOpenChange={open => { if (!open && !busy) setEditor(null); }}><Modal.Backdrop><Modal.Container size="lg" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
      <Modal.Header><Modal.Heading>{editor.revision === null ? t('newFile') : editor.path}</Modal.Heading></Modal.Header>
      <Modal.Body><div className="project-form">
        {editor.revision === null && <TextField isRequired><Label>{t('filename')}</Label><Input value={editor.path} onChange={e => setEditor({ ...editor, path: e.target.value })} placeholder="notes.md" /></TextField>}
        <TextField><Label>{t('content')}</Label><TextArea className="project-text-editor" value={editor.text} readOnly={project.archived} rows={15} onChange={e => setEditor({ ...editor, text: e.target.value })} /></TextField>
        {editorError && <p className="project-error" role="alert">{editorError}</p>}
      </div></Modal.Body>
      <Modal.Footer><Button variant="tertiary" isDisabled={busy} onPress={() => setEditor(null)}>{t('cancel')}</Button><Button variant="primary" isDisabled={busy || project.archived || !editor.path.trim()} onPress={() => void save()}>{t('save')}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root>}
  </section>;
}
