import { useEffect, useId, useRef, useState, useCallback } from 'react';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import { useNavigate } from 'react-router-dom';
import { useAppNav } from '../components/appNav';
import { useModelMetaRevision } from '../utils/useModelMeta';
import { MarkdownCode, MarkdownPre } from '../components/mermaid/markdown';
import ModelPicker from '../components/ModelPicker';
import SkillPicker from '../components/SkillPicker';
import { StreamParagraph, ThinkLine, Collapse } from '../components/motion';
import AskCard from '../components/AskCard';
import FolderPlanCard from '../components/FolderPlanCard';
import { hasThinkingDepth, supportsThinking } from '../api/modelCaps';
import { useSettings } from '../store/settings';
import { useCourseChat, type CourseChatMessage } from '../store/courseChat';
import type { ReasoningEffort } from '../api/siliconflow';
import { confirmDialog, PageShell, toast, useMduiEvent } from '../ui';
import './course-chat.css';

const STARTERS = [
  {
    icon: <mdui-sym-local-fire-department />,
    label: '推荐下一门课',
    prompt: '根据我的课程库和学习进度，推荐我下一门最值得学的课程，并说明理由。',
  },
  {
    icon: <mdui-sym-play-circle />,
    label: '看看未完成课程',
    prompt: '列出我还没学完的课程，按完成进度从高到低整理，并建议先完成哪一门。',
  },
  {
    icon: <mdui-sym-toc />,
    label: '梳理课程主题',
    prompt: '根据课程名称和已有内容，帮我梳理整个课程库覆盖了哪些主要主题。',
  },
  {
    icon: <mdui-sym-folder />,
    label: '整理课程库目录',
    prompt: '帮我把课程库目录整理一下：先看现有分类和全部课程，再按一个统一的主轴给出分类方案。',
  },
] as const;

function ReasoningBlock({ reasoning, active }: { reasoning: string; active: boolean }) {
  const [open, setOpen] = useState(active);
  const bodyId = useId();
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <div className="course-chat__reason">
      <button
        type="button"
        className="course-chat__reason-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <mdui-sym-chevron-right className={open ? 'course-chat__reason-icon course-chat__reason-icon--open' : 'course-chat__reason-icon'} />
        {active ? '思考中…' : '思考过程'}
      </button>
      <Collapse open={open} id={bodyId} innerClassName="course-chat__reason-body">
        {reasoning}
      </Collapse>
    </div>
  );
}

/**
 * 课程助手页。
 *
 * 这个组件**刻意只剩视图职责**：会话、消息、流式中间态、悬着的提问/确认全在
 * `store/courseChat.ts`。原因是「切到别的页面再回来也要接着跑」——状态跟着路由走的话，
 * 离开页面就等于把正在生成的对话扔了（详见该 store 顶部的说明）。
 */
export default function CourseChat() {
  const navigate = useNavigate();
  const nav = useAppNav('chat');
  const listRef = useRef<HTMLDivElement | null>(null);

  const ready = useCourseChat((s) => s.ready);
  const sessions = useCourseChat((s) => s.sessions);
  const activeId = useCourseChat((s) => s.activeId);
  const loaded = useCourseChat((s) => s.loaded);
  const messages = useCourseChat((s) => s.messages);
  const loading = useCourseChat((s) => s.loading);
  const draft = useCourseChat((s) => s.draft);
  const courseCount = useCourseChat((s) => s.courseCount);
  const skillIds = useCourseChat((s) => s.skillIds);
  const contextCourses = useCourseChat((s) => s.contextCourses);
  const pendingAsk = useCourseChat((s) => s.pendingAsk);
  const pendingPlan = useCourseChat((s) => s.pendingPlan);
  const planApplying = useCourseChat((s) => s.planApplying);
  const bootstrap = useCourseChat((s) => s.bootstrap);
  const loadSession = useCourseChat((s) => s.loadSession);
  const createSession = useCourseChat((s) => s.createSession);
  const deleteSession = useCourseChat((s) => s.deleteSession);
  const setDraft = useCourseChat((s) => s.setDraft);
  const send = useCourseChat((s) => s.send);
  const setSkillIds = useCourseChat((s) => s.setSkillIds);
  const clearCourseContext = useCourseChat((s) => s.clearCourseContext);
  const answerAsk = useCourseChat((s) => s.answerAsk);
  const stop = useCourseChat((s) => s.stop);
  const confirmPlan = useCourseChat((s) => s.confirmPlan);
  const cancelPlan = useCourseChat((s) => s.cancelPlan);

  const llmModel = useSettings((state) => state.llmModel);
  const thinking = useSettings((state) => state.thinkingEnabled);
  const effort = useSettings((state) => state.thinkingEffort);
  const updateSettings = useSettings((state) => state.update);

  // 思考深度能不能调取决于模型自己声明了什么，而元数据是启动后异步拉回来的
  useModelMetaRevision();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (ready && activeId != null && !loaded) void loadSession(activeId);
  }, [ready, activeId, loaded, loadSession]);

  const sessionRef = useMduiEvent('mdui-select', 'change', (_event, element) => {
    const id = Number(element.value);
    if (Number.isFinite(id)) void loadSession(id);
  });
  const effortRef = useMduiEvent('mdui-segmented-button-group', 'change', (_event, element) =>
    updateSettings({ thinkingEffort: element.value as ReasoningEffort }),
  );
  // 输入框的取值走 mdui 自己的 input 事件（而不是 React 的 onInput）：mdui-text-field 是
  // 自定义元素，value 挂在组件实例上，从原生事件的 target 里读会读到内部的 textarea。
  const composerRef = useMduiEvent('mdui-text-field', 'input', (_event, element) =>
    setDraft(element.value),
  );

  const onPlanConfirm = async () => {
    const result = await confirmPlan();
    if (result.error) toast.error(`整理方案执行失败：${result.error}`);
  };

  const onDeleteSession = async () => {
    const ok = await confirmDialog({
      headline: '删除当前会话？',
      description: '这段课程助手对话会被永久删除，课程和学习数据不会受影响。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (ok) await deleteSession();
  };

  const CourseLink = useCallback(
    ({ href, children }: ComponentProps & { href?: string }) => {
      const target = href ?? '';
      if (target.startsWith('#/player/')) {
        const courseId = decodeURIComponent(target.slice('#/player/'.length));
        return (
          <a
            href={target}
            onClick={(event) => {
              event.preventDefault();
              navigate(`/player/${courseId}`);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a href={target} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    [navigate],
  );

  const lastMessage = messages[messages.length - 1];
  const scrollSignal = [
    messages.length,
    lastMessage?.key ?? '',
    lastMessage?.content.length ?? 0,
    lastMessage?.reasoning?.length ?? 0,
    lastMessage?.hint ?? '',
    lastMessage?.ask ? `${lastMessage.ask.question}${lastMessage.ask.picked ?? ''}` : '',
    lastMessage?.folderPlan?.applied ?? '',
  ].join('|');
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const element = listRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [scrollSignal]);

  const iconButton = (label: string, icon: React.ReactNode, onClick: () => void, disabled?: boolean) => (
    <mdui-tooltip content={label}>
      <mdui-button-icon aria-label={label} onClick={onClick} disabled={disabled}>
        {icon}
      </mdui-button-icon>
    </mdui-tooltip>
  );

  const sessionReady = activeId != null && loaded;
  /** 本轮循环是否还活着：决定两张卡能不能交互（刷新后从库里读回的卡是「死的」） */
  const loopAlive = pendingAsk != null || pendingPlan != null;

  const renderCards = (message: CourseChatMessage) => (
    <>
      {message.ask && (
        <AskCard
          ask={message.ask}
          active={pendingAsk?.messageKey === message.key}
          onPick={(option) => void answerAsk(option)}
          // 「我自己说」只做一件事：把输入框交给用户。打字回车时 `send` 会把它
          // 当作这次提问的回答（见 store 里的 pendingAsk 分支），不会新起一轮。
          onCustom={() => composerRef.current?.focus()}
        />
      )}
      {message.folderPlan && (
        <FolderPlanCard
          plan={message.folderPlan}
          active={pendingPlan?.messageKey === message.key}
          busy={planApplying && pendingPlan?.messageKey === message.key}
          onConfirm={() => void onPlanConfirm()}
          onCancel={() => void cancelPlan()}
        />
      )}
    </>
  );

  return (
    <PageShell
      title="课程助手"
      fill
      rootClassName="page-course-chat"
      rail={nav.rail}
      bottomNav={nav.bottom}
    >
      <div className="course-chat" data-testid="course-chat-page">
        <section className="course-chat__main" aria-label="课程助手聊天">
          <div className="course-chat__toolbar" role="group" aria-label="会话与回答设置">
            <mdui-select
              ref={sessionRef}
              className="course-chat__session-select"
              value={activeId != null ? String(activeId) : undefined}
              // 生成中禁用：切会话会把正在流的那条消息换成库里读回来的版本（库里还没有它）
              disabled={loading}
              aria-label="切换会话"
            >
              {sessions.map((session) => (
                <mdui-menu-item key={session.id} value={String(session.id)}>
                  {session.title}
                </mdui-menu-item>
              ))}
            </mdui-select>
            {iconButton('新开会话', <mdui-sym-add />, () => void createSession(), loading)}
            <span className="course-chat__delete-action">
              {iconButton('删除当前会话', <mdui-sym-delete />, () => void onDeleteSession(), loading)}
            </span>
            <span className="course-chat__toolbar-divider" aria-hidden="true" />
            <ModelPicker slot="chat" field="llmModel" />
            <SkillPicker value={skillIds} onChange={setSkillIds} />
            {supportsThinking(llmModel) && (
              <mdui-tooltip content={thinking ? '关闭思考' : '开启思考'}>
                <mdui-button-icon
                  aria-label={thinking ? '关闭思考' : '开启思考'}
                  aria-pressed={thinking}
                  variant={thinking ? 'tonal' : 'standard'}
                  onClick={() => updateSettings({ thinkingEnabled: !thinking })}
                >
                  <mdui-sym-lightbulb />
                </mdui-button-icon>
              </mdui-tooltip>
            )}
            {/* 深度控件只在模型**声明了**档位或预算区间时出现：只有开关的模型
              （Qwen3.5 系、部分 DeepSeek）给不出深度，给个装饰性旋钮反而是骗人 */}
            {supportsThinking(llmModel) && thinking && hasThinkingDepth(llmModel) && (
              <span className="course-chat__effort-field">
                <span className="course-chat__effort-label">思考深度</span>
                <mdui-segmented-button-group ref={effortRef} selects="single" value={effort} className="course-chat__effort" aria-label="思考深度">
                  <mdui-segmented-button value="low">低</mdui-segmented-button>
                  <mdui-segmented-button value="high">高</mdui-segmented-button>
                  <mdui-segmented-button value="max">最大</mdui-segmented-button>
                </mdui-segmented-button-group>
              </span>
            )}
          </div>

          {/* 只在助手**真的选定**了课程时才出现这条信息栏：没有选中时一行字都是废话
              （曾经那里写着「助手自动选择」，说的就是「这里本来是空的」）。 */}
          {contextCourses.length > 0 && (
            <div className="course-chat__context" data-testid="course-chat-context">
              <span className="course-chat__context-label">
                <mdui-sym-toc aria-hidden="true" />
                课程上下文
              </span>
              <div className="course-chat__context-chips">
                {contextCourses.map((course) => (
                  <span className="course-chat__context-chip" key={course.id} title={course.name}>
                    {course.name}
                  </span>
                ))}
              </div>
              <mdui-tooltip content="清除课程上下文，恢复自动选择">
                <mdui-button-icon
                  className="course-chat__context-reset"
                  aria-label="恢复自动选择课程"
                  onClick={clearCourseContext}
                  disabled={loading}
                >
                  <mdui-sym-refresh />
                </mdui-button-icon>
              </mdui-tooltip>
            </div>
          )}

          <div className="course-chat__messages" ref={listRef} data-testid="course-chat-messages">
            {messages.length === 0 && (
              <div className="course-chat__empty">
                <div className="course-chat__empty-mark" aria-hidden="true">
                  <mdui-sym-forum />
                </div>
                <h2>问你的整个课程库</h2>
                <p>
                  我会先判断问题对应哪些课程，再读取相关内容；需要时也会调用当前会话允许的技能。
                </p>
                {courseCount == null ? (
                  <div className="course-chat__empty-loading">正在读取课程库…</div>
                ) : courseCount === 0 ? (
                  <button type="button" className="course-chat__import" onClick={() => navigate('/')}>
                    <mdui-sym-add />
                    先去导入课程
                  </button>
                ) : (
                  <div className="course-chat__starters" aria-label="快捷提问">
                    {STARTERS.map((starter) => (
                      <button
                        key={starter.label}
                        type="button"
                        className="course-chat__starter"
                        onClick={() => void send(starter.prompt)}
                        disabled={loading || !sessionReady}
                      >
                        <span aria-hidden="true">{starter.icon}</span>
                        <span>{starter.label}</span>
                        <mdui-sym-chevron-right aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {messages.map((message) => {
              const user = message.role === 'user';
              return (
                <article
                  key={message.key}
                  className={user ? 'course-chat__message course-chat__message--user' : 'course-chat__message course-chat__message--ai'}
                  data-error={message.error ? 'true' : undefined}
                >
                  {!user && (
                    <span className="course-chat__avatar" aria-hidden="true">
                      <mdui-sym-forum filled />
                    </span>
                  )}
                  <div className={user ? 'course-chat__bubble course-chat__bubble--user' : 'course-chat__bubble course-chat__bubble--ai'}>
                    {user ? (
                      message.content
                    ) : message.hint && !message.content && !message.ask && !message.folderPlan ? (
                      <ThinkLine text={message.hint} />
                    ) : (
                      <>
                        {message.reasoning && (
                          <ReasoningBlock reasoning={message.reasoning} active={!!message.streaming && !message.content} />
                        )}
                        {/* 卡片排在正文**之前**：卡片是「先发生的那个动作」（第 1 轮问 / 提方案），
                            正文是用户回应之后（第 2 轮）才流出来的。反过来排会读成
                            「先给结论、下面才是问题」。 */}
                        {renderCards(message)}
                        {message.content && (
                          <XMarkdown
                            content={message.content}
                            components={{
                              a: CourseLink,
                              p: StreamParagraph,
                              code: MarkdownCode,
                              pre: MarkdownPre,
                            }}
                            streaming={{ hasNextChunk: !!message.streaming, tail: !!message.streaming }}
                          />
                        )}
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="course-chat__composer-wrap">
            <div className="course-chat__composer">
              <mdui-text-field
                ref={composerRef}
                className="course-chat__input"
                variant="outlined"
                rows={2}
                value={draft}
                disabled={!sessionReady || (loading && pendingAsk == null)}
                placeholder={
                  pendingAsk
                    ? '直接输入就是你的回答，回车确认'
                    : '问课程、内容或学习进度，回车发送'
                }
                aria-label="给课程助手发送消息"
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  void send(draft);
                }}
              />
              {/* 生成中：发送按钮**变成**停止键，而不是并排加一个 ——
                  输入框此时是禁用的，并排两个按钮会让人以为发送还能用。
                  有提问卡悬着时例外：那时循环在等用户答，输入框必须留着。 */}
              {loading && !pendingAsk ? (
                <mdui-tooltip content="停止生成">
                  <mdui-button-icon
                    className="course-chat__send"
                    aria-label="停止生成"
                    variant="tonal"
                    data-testid="chat-stop"
                    onClick={stop}
                  >
                    <mdui-sym-stop />
                  </mdui-button-icon>
                </mdui-tooltip>
              ) : (
                <mdui-tooltip content={pendingAsk ? '确认这个回答' : '发送'}>
                  <mdui-button-icon
                    className="course-chat__send"
                    aria-label={pendingAsk ? '确认这个回答' : '发送'}
                    variant="filled"
                    loading={loading}
                    disabled={!sessionReady || !draft.trim() || (loading && pendingAsk == null)}
                    onClick={() => void send(draft)}
                  >
                    <mdui-sym-send />
                  </mdui-button-icon>
                </mdui-tooltip>
              )}
            </div>
            <div className="course-chat__composer-note">AI 会结合课程数据与所选技能回答，请核对引用来源。</div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
