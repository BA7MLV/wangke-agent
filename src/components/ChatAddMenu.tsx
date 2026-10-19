import { useRef, useState } from 'react';
import { Button, Checkbox, Dropdown, Input, Modal } from '@heroui/react';
import { useNavigate } from 'react-router-dom';
import { db } from '../store/db';
import { useCourseChat } from '../store/courseChat';
import { useChatAttachments } from '../store/chatAttachments';
import { CHAT_FILE_ACCEPT, CHAT_IMAGE_ACCEPT } from '../chat/attachments';
import { MAX_COURSE_CONTEXT } from '../harness/courseContext';
import { MODAL_CONTAINER_CLASS, Sym } from '../ui';
import SkillPicker from './SkillPicker';
import './chat-attachments.css';

export default function ChatAddMenu({ disabled }: { disabled?: boolean }) {
  const navigate = useNavigate();
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [coursesOpen, setCoursesOpen] = useState(false);
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const skillIds = useCourseChat((state) => state.skillIds);
  const setSkillIds = useCourseChat((state) => state.setSkillIds);
  const loading = useCourseChat((state) => state.loading);
  const addFiles = useChatAttachments((state) => state.add);
  const openCourses = async () => {
    setError(''); setBusy(true); setQuery(''); setCoursesOpen(true);
    setSelected(useCourseChat.getState().contextCourses.map((course) => course.id));
    try { setCourses((await db.videos.orderBy('createdAt').reverse().toArray()).map(({ id, name }) => ({ id, name }))); }
    catch { setError('课程列表读取失败，请关闭后重试'); }
    finally { setBusy(false); }
  };
  const saveCourses = async () => {
    setBusy(true); setError('');
    try { await useCourseChat.getState().setCourseContext(selected); setCoursesOpen(false); }
    catch { setError('课程选择保存失败，请重试'); }
    finally { setBusy(false); }
  };
  return <>
    <div className="chat-add-menu">
      <Dropdown>
        <Button isIconOnly size="sm" variant="tertiary" aria-label="添加课程、图片或文件" data-testid="chat-add" isDisabled={disabled}>
          <Sym name="add" />
        </Button>
        <Dropdown.Popover placement="top start">
          <Dropdown.Menu aria-label="添加到对话" disabledKeys={loading ? ['courses'] : []} onAction={(key) => {
            if (key === 'courses') void openCourses();
            else if (key === 'images') imageInput.current?.click();
            else if (key === 'files') fileInput.current?.click();
            else if (key === 'skills') setSkillsOpen(true);
          }}>
            <Dropdown.Item id="courses" textValue="添加课程"><Sym name="school" />添加课程</Dropdown.Item>
            <Dropdown.Item id="images" textValue="上传图片"><Sym name="image" />上传图片</Dropdown.Item>
            <Dropdown.Item id="files" textValue="上传文件"><Sym name="attach_file" />上传文件</Dropdown.Item>
            <Dropdown.Item id="skills" textValue="技能范围"><Sym name="extension" />技能范围{skillIds !== undefined ? ' · 已限定' : ''}</Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <input ref={imageInput} type="file" accept={CHAT_IMAGE_ACCEPT} multiple hidden data-testid="chat-image-input" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <input ref={fileInput} type="file" accept={CHAT_FILE_ACCEPT} multiple hidden data-testid="chat-file-input" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    </div>
    <SkillPicker value={skillIds} onChange={setSkillIds} isOpen={skillsOpen} onOpenChange={setSkillsOpen} hideTrigger />
    <Modal.Root isOpen={coursesOpen} onOpenChange={setCoursesOpen}>
      <Modal.Backdrop><Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
        <Modal.Dialog data-testid="chat-course-picker">
          <Modal.Header><Modal.Heading>添加课程</Modal.Heading></Modal.Header>
          <Modal.Body>
            <p className="text-sm text-muted">最多选择 {MAX_COURSE_CONTEXT} 门课程作为会话上下文；不选则由助手自动检索全库。</p>
            <Input aria-label="搜索课程" placeholder="搜索课程" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="chat-course-picker__list" aria-busy={busy}>
              {busy ? <p role="status">正在读取课程…</p> : courses.length === 0 ? <>
                <p>课程库还是空的</p><Button variant="secondary" onPress={() => { setCoursesOpen(false); navigate('/library'); }}>导入课程</Button>
              </> : courses.filter((course) => course.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((course) => (
                <Checkbox key={course.id} isSelected={selected.includes(course.id)} isDisabled={!selected.includes(course.id) && selected.length >= MAX_COURSE_CONTEXT}
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
            <Button variant="primary" isDisabled={busy || loading} onPress={() => void saveCourses()}>添加{selected.length ? ` ${selected.length} 门课程` : ''}</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container></Modal.Backdrop>
    </Modal.Root>
  </>;
}
