import { useEffect, useState } from 'react';
import { Button, Input, Label, Modal, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { createChatProject, listChatProjects, projectDisplayName, projectFolderName, type ChatProject } from '../projects/chatProjects';
import { projectError } from '../projects/errors';
import { MODAL_CONTAINER_CLASS, Sym } from '../ui';
import { FolderIcon } from './FolderIcon';

export default function ChatProjectPicker({ value, onSelect, onClose }: {
  value: ChatProject | null; onSelect: (project: ChatProject | null) => Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation('projects');
  const [projects, setProjects] = useState<ChatProject[]>([]);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let ignore = false;
    setLoading(true); setError('');
    listChatProjects().then(result => { if (!ignore) setProjects(result); })
      .catch(error => { if (!ignore) setError(projectError(error)); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [revision]);
  const select = async (project: ChatProject | null) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await onSelect(project); onClose(); }
    catch (error) { setError(projectError(error)); }
    finally { setBusy(false); }
  };
  let valid = false;
  try { projectFolderName(name); valid = true; } catch { /* Keep the form until a valid name is entered. */ }
  const visible = projects.filter(project => project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <Modal.Root isOpen onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Modal.Backdrop><Modal.Container size="md" className={MODAL_CONTAINER_CLASS}><Modal.Dialog data-testid="chat-project-picker">
      <Modal.Header><Modal.Heading>{t('selectProject')}</Modal.Heading></Modal.Header>
      <Modal.Body>
        <p className="text-sm text-muted">{t('projectHint')}</p>
        <Input fullWidth aria-label={t('searchProjects')} placeholder={t('searchProjects')} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="chat-project-picker__list" aria-busy={loading || busy}>
          {loading ? <p role="status">{t('loadingProjects')}</p> : visible.map(project => <Button key={project.folderId}
            variant="tertiary" className="chat-project-picker__item" isDisabled={busy} aria-pressed={value?.folderId === project.folderId}
            onPress={() => void select(project)}>
            <FolderIcon color={project.color} /><span>{projectDisplayName(project.name)}</span>
            {value?.folderId === project.folderId && <Sym name="check" />}
          </Button>)}
          {!loading && !visible.length && <p>{t(projects.length ? 'noProjectsMatch' : 'noProjects')}</p>}
        </div>
        {error && <p role="alert" className="chat-attachments__error">{error}<Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => setRevision(value => value + 1)}>{t('retry')}</Button></p>}
        <form className="chat-project-picker__create" onSubmit={event => {
          event.preventDefault();
          if (!valid || busy) return;
          setBusy(true); setError('');
          void createChatProject(name).then(async project => {
            setProjects(current => [...current, project]); setName('');
            await onSelect(project); onClose();
          }).catch(error => setError(projectError(error))).finally(() => setBusy(false));
        }}>
          <TextField><Label>{t('projectName')}</Label><Input placeholder={t('projectName')} value={name} maxLength={97} onChange={event => setName(event.target.value)} /></TextField>
          <Button type="submit" variant="secondary" isDisabled={busy || !valid} data-testid="chat-project-create"><Sym name="add" />{t('newProject')}</Button>
        </form>
      </Modal.Body>
      <Modal.Footer>
        {value && <Button variant="tertiary" isDisabled={busy} onPress={() => void select(null)}>{t('clearProject')}</Button>}
        <Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t('cancel')}</Button>
      </Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop>
  </Modal.Root>;
}
