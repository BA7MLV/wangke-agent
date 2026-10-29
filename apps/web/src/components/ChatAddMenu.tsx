import { useRef, useState } from 'react';
import { Button, Checkbox, Dropdown, Input, Label, Modal } from '@heroui/react';
import { useNavigate } from 'react-router-dom';
import { db } from '../store/db';
import { useCourseChat } from '../store/courseChat';
import { useChatAttachments } from '../store/chatAttachments';
import { CHAT_FILE_ACCEPT, CHAT_IMAGE_ACCEPT } from '../chat/attachments';
import { MAX_COURSE_CONTEXT } from '../harness/courseContext';
import { folderCourseScope } from '@wangke/study-core/folder-scope';
import { projectDisplayName } from '../projects/chatProjects';
import { MODAL_CONTAINER_CLASS, Sym, toast } from '../ui';
import { handoutDraft, prepareHandoutPrompt } from '../skills/handout';
import SkillPicker from './SkillPicker';
import ModelPicker from './ModelPicker';
import './chat-attachments.css';
import { useTranslation } from 'react-i18next';

export default function ChatAddMenu({ disabled, onSelectProject }: { disabled?: boolean; onSelectProject?: () => void }) {
  const { t } = useTranslation('settings');
  const { t: tp } = useTranslation('projects');
  const navigate = useNavigate();
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [coursesOpen, setCoursesOpen] = useState(false);
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [handoutPreparing, setHandoutPreparing] = useState(false);
  const skillIds = useCourseChat((state) => state.skillIds);
  const setSkillIds = useCourseChat((state) => state.setSkillIds);
  const mcpServerIds = useCourseChat((state) => state.mcpServerIds);
  const setMcpServerIds = useCourseChat((state) => state.setMcpServerIds);
  const loading = useCourseChat((state) => state.loading);
  const contextCourses = useCourseChat((state) => state.contextCourses);
  const project = useCourseChat((state) => state.project);
  const projectLabel = project ? `${tp('selectProject')} · ${projectDisplayName(project.name)}` : tp('selectProject');
  const contextLabel = contextCourses.length ? `课程引用 · ${contextCourses.length} 门` : '课程引用';
  const addFiles = useChatAttachments((state) => state.add);
  const openCourses = async () => {
    setError(''); setBusy(true); setQuery(''); setCoursesOpen(true);
    setSelected(useCourseChat.getState().contextCourses.map((course) => course.id));
    try {
      const [rows, folders] = await Promise.all([db.videos.orderBy('createdAt').reverse().toArray(), db.folders.toArray()]);
      const scope = folderCourseScope(folders, rows, project?.folderId);
      setCourses(rows.filter(row => !scope || scope.has(row.id)).map(({ id, name }) => ({ id, name })));
    }
    catch { setError('课程列表读取失败，请关闭后重试'); }
    finally { setBusy(false); }
  };
  const saveCourses = async () => {
    setBusy(true); setError('');
    try { await useCourseChat.getState().setCourseContext(selected); setCoursesOpen(false); }
    catch { setError('课程选择保存失败，请重试'); }
    finally { setBusy(false); }
  };
  const addHandout = async () => {
    const session = useCourseChat.getState();
    if (session.loading || handoutPreparing) return;
    setHandoutPreparing(true);
    try {
      const prepared = await prepareHandoutPrompt(session.skillIds);
      const current = useCourseChat.getState();
      if (current.activeId !== session.activeId) return;
      if (prepared.skillIds !== session.skillIds) current.setSkillIds(prepared.skillIds);
      current.setDraft(handoutDraft(current.draft, prepared.prompt));
      toast.info('已添加讲义提示词，可修改后发送');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '讲义提示词加载失败，请重试');
    } finally {
      setHandoutPreparing(false);
    }
  };
  return <>
    <div className="chat-add-menu">
      <Dropdown isOpen={addOpen} onOpenChange={setAddOpen}>
        <Button className="chat-add-menu__trigger" isIconOnly size="sm" variant="tertiary" aria-label={`添加内容或调整模型${contextCourses.length ? `，已引用 ${contextCourses.length} 门课程` : ''}`} data-testid="chat-add" isDisabled={disabled}>
          <Sym name="add" />
          {contextCourses.length > 0 && <span className="chat-add-menu__context-dot" data-testid="chat-context-dot" aria-hidden="true" />}
        </Button>
        <Dropdown.Popover placement="top start">
          <div className="px-2 py-1">
            <ModelPicker slot="chat" field="llmModel" variant="chip" showThinking thinkingDepthDisabled={loading} onClose={() => setAddOpen(false)} />
          </div>
          <Dropdown.Menu aria-label="添加到对话" disabledKeys={[...(loading ? ['handout', 'project'] : []), ...(handoutPreparing ? ['handout'] : [])]} onAction={(key) => {
            if (key === 'courses') void openCourses();
            else if (key === 'images') imageInput.current?.click();
            else if (key === 'files') fileInput.current?.click();
            else if (key === 'skills') setSkillsOpen(true);
            else if (key === 'handout') void addHandout();
            else if (key === 'project') { setAddOpen(false); onSelectProject?.(); }
          }}>
            {onSelectProject && <Dropdown.Item id="project" textValue={projectLabel} data-testid="chat-select-project"><Sym name="folder" /><Label>{projectLabel}</Label></Dropdown.Item>}
            <Dropdown.Item id="courses" textValue={contextLabel} data-testid="course-chat-context">
              <Sym name="school" />
              <Label>{contextLabel}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="images" textValue="上传图片"><Sym name="image" />上传图片</Dropdown.Item>
            <Dropdown.Item id="files" textValue="上传文件"><Sym name="attach_file" />上传文件</Dropdown.Item>
            <Dropdown.Item id="handout" textValue="生成讲义" data-testid="handout-prompt"><Sym name="description" />生成讲义</Dropdown.Item>
            <Dropdown.Item id="skills" textValue={t('mcp.scopeTitle')}><Sym name="extension" />{t('mcp.scopeTitle')}{skillIds !== undefined || mcpServerIds !== undefined ? ' · 已限定' : ''}</Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <input ref={imageInput} type="file" accept={CHAT_IMAGE_ACCEPT} multiple hidden data-testid="chat-image-input" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <input ref={fileInput} type="file" accept={CHAT_FILE_ACCEPT} multiple hidden data-testid="chat-file-input" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    </div>
    <SkillPicker value={skillIds} onChange={setSkillIds} mcpValue={mcpServerIds} onMcpChange={setMcpServerIds} isOpen={skillsOpen} onOpenChange={setSkillsOpen} hideTrigger />
    <Modal.Root isOpen={coursesOpen} onOpenChange={setCoursesOpen}>
      <Modal.Backdrop><Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
        <Modal.Dialog data-testid="chat-course-picker">
          <Modal.Header><Modal.Heading>课程引用</Modal.Heading></Modal.Header>
          <Modal.Body>
            <Input aria-label="搜索课程" placeholder="搜索课程" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="chat-course-picker__selection">
              <span aria-label={`已选择 ${selected.length} 门，最多 ${MAX_COURSE_CONTEXT} 门`}>{selected.length} / {MAX_COURSE_CONTEXT}</span>
              <Button size="sm" variant="tertiary" data-testid="chat-context-reset" isDisabled={busy || loading || selected.length === 0} onPress={() => setSelected([])}>{selected.length ? '恢复自动选择' : '自动选择'}</Button>
            </div>
            {loading && <p className="text-sm text-muted">回复完成后可修改课程引用。</p>}
            <div className="chat-course-picker__list" aria-busy={busy}>
              {busy ? <p role="status">正在读取课程…</p> : courses.length === 0 ? <>
                <p>课程库还是空的</p><Button variant="secondary" onPress={() => { setCoursesOpen(false); navigate('/library'); }}>导入课程</Button>
              </> : courses.filter((course) => course.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((course) => (
                <Checkbox key={course.id} isSelected={selected.includes(course.id)} isDisabled={loading || (!selected.includes(course.id) && selected.length >= MAX_COURSE_CONTEXT)}
                  onChange={(checked) => setSelected((current) => checked ? [...current, course.id] : current.filter((id) => id !== course.id))}>
                  <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span>{course.name}</span></Checkbox.Content>
                </Checkbox>
              ))}
              {!busy && courses.length > 0 && !courses.some((course) => course.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p>没有匹配的课程</p>}
            </div>
            {error && <p role="alert" className="chat-attachments__error">{error}</p>}
          </Modal.Body>
          <Modal.Footer>
            {courses.length > 0 && <Button variant="tertiary" onPress={() => { setCoursesOpen(false); navigate('/library'); }}>导入新课程</Button>}
            <Button variant="tertiary" onPress={() => setCoursesOpen(false)}>取消</Button>
            <Button variant="primary" isDisabled={busy || loading} onPress={() => void saveCourses()}>保存</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container></Modal.Backdrop>
    </Modal.Root>
  </>;
}
