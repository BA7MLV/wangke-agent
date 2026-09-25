import { useCallback, useEffect, useRef, useState } from 'react';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import { useNavigate } from 'react-router-dom';
import { useAppNav } from '../components/appNav';
import { MarkdownCode, MarkdownPre } from '../components/mermaid/markdown';
import ModelPicker from '../components/ModelPicker';
import SkillPicker from '../components/SkillPicker';
import { StreamParagraph, ThinkLine } from '../components/motion';
import { supportsThinking } from '../api/modelCaps';
import { getSettings, useSettings } from '../store/settings';
import { db, type ChatSessionRow } from '../store/db';
import { estimateTokens, fitHistoryToBudget } from '../harness/context';
import { runAgentLoop } from '../harness/agent';
import { createToolExecutor, SKILL_TOOLS } from '../harness/tools';
import {
  type CourseContextItem,
  createLibraryAssistantExecutor,
  LIBRARY_ASSISTANT_ID,
  LIBRARY_ASSISTANT_TOOLS,
  libraryAssistantSystemPrompt,
} from '../harness/libraryAssistant';
import { loadSessionSkillMeta, skillMetaBlock } from '../skills/store';
import type { ChatMessage, ReasoningEffort } from '../api/siliconflow';
import { confirmDialog, PageShell, useMduiEvent } from '../ui';
import './course-chat.css';

interface AssistantMessage {
  key: string;
  role: 'user' | 'ai';
  content: string;
  reasoning?: string;
  hint?: string;
  streaming?: boolean;
  error?: boolean;
}

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
    icon: <mdui-sym-calendar-month />,
    label: '查看学习情况',
    prompt: '概括我的学习情况，包括课程进度和累计学习时间，并给一个接下来的学习建议。',
  },
] as const;

const COURSE_ASSISTANT_TOOLS = [...LIBRARY_ASSISTANT_TOOLS, ...SKILL_TOOLS];

let keySeq = 0;
const nextKey = () => `course-chat-${Date.now()}-${keySeq++}`;

function ReasoningBlock({ reasoning, active }: { reasoning: string; active: boolean }) {
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <div className="course-chat__reason">
      <button
        type="button"
        className="course-chat__reason-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <mdui-sym-chevron-right className={open ? 'course-chat__reason-icon course-chat__reason-icon--open' : 'course-chat__reason-icon'} />
        {active ? '思考中…' : '思考过程'}
      </button>
      {open && <div className="course-chat__reason-body">{reasoning}</div>}
    </div>
  );
}

export default function CourseChat() {
  const navigate = useNavigate();
  const nav = useAppNav('chat');
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadedSessionId, setLoadedSessionId] = useState<number | null>(null);
  const [skillIds, setSkillIds] = useState<number[] | undefined>(undefined);
  const [contextCourses, setContextCourses] = useState<CourseContextItem[]>([]);
  const [courseCount, setCourseCount] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const llmModel = useSettings((state) => state.llmModel);
  const thinking = useSettings((state) => state.thinkingEnabled);
  const effort = useSettings((state) => state.thinkingEffort);
  const updateSettings = useSettings((state) => state.update);

  const composerRef = useMduiEvent('mdui-text-field', 'input', (_event, element) => setInput(element.value));
  const sessionRef = useMduiEvent('mdui-select', 'change', (_event, element) => {
    const id = Number(element.value);
    if (Number.isFinite(id)) setActiveId(id);
  });
  const effortRef = useMduiEvent('mdui-segmented-button-group', 'change', (_event, element) =>
    updateSettings({ thinkingEffort: element.value as ReasoningEffort }),
  );

  const ensureSessions = useCallback(async () => {
    let rows = await db.chatSessions.where('videoId').equals(LIBRARY_ASSISTANT_ID).sortBy('createdAt');
    if (rows.length === 0) {
      const now = Date.now();
      const id = (await db.chatSessions.add({
        videoId: LIBRARY_ASSISTANT_ID,
        title: '新会话',
        createdAt: now,
      })) as number;
      rows = [{ id, videoId: LIBRARY_ASSISTANT_ID, title: '新会话', createdAt: now }];
    }
    setSessions(rows);
    setActiveId((current) => (current != null && rows.some((row) => row.id === current) ? current : rows[rows.length - 1].id!));
  }, []);

  useEffect(() => {
    void ensureSessions();
    void db.videos.count().then(setCourseCount);
  }, [ensureSessions]);

  useEffect(() => {
    setLoadedSessionId(null);
    setMessages([]);
    setSkillIds(undefined);
    setContextCourses([]);
    if (activeId == null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const [session, rows] = await Promise.all([
        db.chatSessions.get(activeId),
        db.chats.where('sessionId').equals(activeId).sortBy('createdAt'),
      ]);
      if (cancelled) return;
      const contextIds = session?.contextCourseIds ?? [];
      const contextRows = contextIds.length > 0
        ? await db.videos.where('id').anyOf(contextIds).toArray()
        : [];
      if (cancelled) return;
      const byId = new Map(contextRows.map((course) => [course.id, course.name]));
      setSkillIds(session?.skillIds);
      setContextCourses(
        contextIds
          .filter((id) => byId.has(id))
          .map((id) => ({ id, name: byId.get(id)! })),
      );
      setMessages(rows.map((row) => ({
        key: `stored-${row.id}`,
        role: row.role === 'assistant' ? 'ai' : 'user',
        content: row.content,
        reasoning: row.reasoning,
      })));
      setLoadedSessionId(activeId);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  /** 当前会话的技能范围：undefined=不限定，[]=明确禁用全部技能。 */
  const updateSkillIds = (next: number[] | undefined) => {
    if (activeId == null) return;
    setSkillIds(next);
    void db.chatSessions
      .where('id')
      .equals(activeId)
      .modify((row) => {
        if (next === undefined) delete row.skillIds;
        else row.skillIds = next;
      });
  };

  const createSession = async () => {
    if (loading) return;
    const now = Date.now();
    const id = (await db.chatSessions.add({
      videoId: LIBRARY_ASSISTANT_ID,
      title: '新会话',
      createdAt: now,
    })) as number;
    setSessions((current) => [...current, { id, videoId: LIBRARY_ASSISTANT_ID, title: '新会话', createdAt: now }]);
    setContextCourses([]);
    setActiveId(id);
  };

  const clearCourseContext = () => {
    if (activeId == null || contextCourses.length === 0) return;
    setContextCourses([]);
    void db.chatSessions
      .where('id')
      .equals(activeId)
      .modify((row) => {
        delete row.contextCourseIds;
      });
  };

  const deleteSession = async () => {
    if (activeId == null || loading) return;
    const ok = await confirmDialog({
      headline: '删除当前会话？',
      description: '这段课程助手对话会被永久删除，课程和学习数据不会受影响。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    const id = activeId;
    await db.transaction('rw', db.chats, db.chatSessions, async () => {
      await db.chats.where('sessionId').equals(id).delete();
      await db.chatSessions.delete(id);
    });
    setActiveId(null);
    await ensureSessions();
  };

  const send = async (rawQuestion: string) => {
    const question = rawQuestion.trim();
    if (!question || loading || activeId == null || loadedSessionId !== activeId) return;
    const sessionId = activeId;
    const firstMessage = messages.length === 0;
    const userKey = nextKey();
    const aiKey = nextKey();
    let answer = '';
    let reasoning = '';
    const patchAi = (patch: Partial<AssistantMessage>) => {
      setMessages((current) => current.map((message) => (message.key === aiKey ? { ...message, ...patch } : message)));
    };

    setInput('');
    setLoading(true);
    setMessages((current) => [
      ...current,
      { key: userKey, role: 'user', content: question },
      { key: aiKey, role: 'ai', content: '', streaming: true },
    ]);

    try {
      await db.chats.add({
        videoId: LIBRARY_ASSISTANT_ID,
        sessionId,
        role: 'user',
        content: question,
        createdAt: Date.now(),
      });

      if (firstMessage) {
        const title = question.length > 18 ? `${question.slice(0, 18)}…` : question;
        await db.chatSessions.update(sessionId, { title });
        setSessions((current) => current.map((session) => (session.id === sessionId ? { ...session, title } : session)));
      }

      const settings = getSettings();
      const [history, skillMetas] = await Promise.all([
        db.chats.where('sessionId').equals(sessionId).sortBy('createdAt'),
        loadSessionSkillMeta(skillIds),
      ]);
      const skillBlock = skillMetas.length > 0 ? skillMetaBlock(skillMetas) : undefined;
      const systemPrompt = libraryAssistantSystemPrompt(skillBlock, contextCourses);
      const budget = settings.contextWindow - estimateTokens(systemPrompt) - estimateTokens(question) - 4096;
      const recent = fitHistoryToBudget(history.slice(0, -1), Math.max(2000, budget));
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...recent.map((row) => ({ role: row.role, content: row.content }) as ChatMessage),
        { role: 'user', content: question },
      ];

      const libraryExecutor = createLibraryAssistantExecutor({
        contextCourseIds: contextCourses.map((course) => course.id),
        onContextChange: async (courses) => {
          setContextCourses(courses);
          await db.chatSessions
            .where('id')
            .equals(sessionId)
            .modify((row) => {
              if (courses.length === 0) delete row.contextCourseIds;
              else row.contextCourseIds = courses.map((course) => course.id);
            });
        },
      });
      const skillExecutor = createToolExecutor(LIBRARY_ASSISTANT_ID, { allowedSkillIds: skillIds });
      const executeTool = (name: string, args: Record<string, unknown>) =>
        name === 'use_skill' || name === 'read_skill_reference'
          ? skillExecutor(name, args)
          : libraryExecutor(name, args);

      await runAgentLoop(
        chatMessages,
        COURSE_ASSISTANT_TOOLS,
        executeTool,
        {
          thinkingEffort: thinking && supportsThinking(llmModel) ? effort : undefined,
          onReasoningDelta: (text) => {
            reasoning += text;
            patchAi({ reasoning });
          },
          onDelta: (text) => {
            answer += text;
            patchAi({ content: answer, hint: undefined });
          },
          onRoundStart: () => {
            answer = '';
            patchAi({ content: '', hint: undefined });
          },
          onToolStart: (name, argsJson) => {
            let hint = '正在读取课程库…';
            try {
              const args = JSON.parse(argsJson || '{}') as { query?: string };
              if (name === 'search_course_library' && args.query) hint = `正在跨课程检索：${args.query}`;
              if (name === 'list_courses') hint = '正在整理课程清单…';
              if (name === 'set_course_context') hint = '正在选择相关课程…';
              if (name === 'get_learning_overview') hint = '正在汇总学习记录…';
              if (name === 'get_course_details') hint = '正在读取课程详情…';
              if (name === 'use_skill') hint = '正在加载技能规范…';
              if (name === 'read_skill_reference') hint = '正在查阅技能参考资料…';
            } catch {
              // 工具参数不完整时仍保留通用提示，真正的错误由 executor 返回给模型。
            }
            patchAi({ hint });
          },
        },
        settings.agentRounds,
      );

      const finalAnswer = answer.trim() || '（未获得回答）';
      patchAi({ content: finalAnswer, streaming: false, hint: undefined });
      await db.chats.add({
        videoId: LIBRARY_ASSISTANT_ID,
        sessionId,
        role: 'assistant',
        content: finalAnswer,
        createdAt: Date.now(),
        reasoning: reasoning || undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchAi({
        streaming: false,
        hint: undefined,
        error: true,
        content: answer.trim() ? `${answer}\n\n> 回答中断：${message}` : `回答失败：${message}`,
      });
    } finally {
      setLoading(false);
    }
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
  const sessionReady = activeId != null && loadedSessionId === activeId;
  const scrollSignal = [
    messages.length,
    lastMessage?.key ?? '',
    lastMessage?.content.length ?? 0,
    lastMessage?.reasoning?.length ?? 0,
    lastMessage?.hint ?? '',
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
          <div className="course-chat__toolbar">
            <mdui-select
              ref={sessionRef}
              className="course-chat__session-select"
              value={activeId != null ? String(activeId) : undefined}
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
              {iconButton('删除当前会话', <mdui-sym-delete />, () => void deleteSession(), loading)}
            </span>
            <span className="course-chat__toolbar-divider" aria-hidden="true" />
            <ModelPicker slot="chat" field="llmModel" />
            <SkillPicker value={skillIds} onChange={updateSkillIds} />
            {supportsThinking(llmModel) && (
              <mdui-tooltip content={thinking ? '关闭思考' : '开启思考'}>
                <mdui-button-icon
                  aria-label={thinking ? '关闭思考' : '开启思考'}
                  variant={thinking ? 'filled' : 'standard'}
                  onClick={() => updateSettings({ thinkingEnabled: !thinking })}
                >
                  <mdui-sym-lightbulb />
                </mdui-button-icon>
              </mdui-tooltip>
            )}
            {supportsThinking(llmModel) && thinking && (
              <mdui-segmented-button-group ref={effortRef} selects="single" value={effort} className="course-chat__effort">
                <mdui-segmented-button value="low">低</mdui-segmented-button>
                <mdui-segmented-button value="high">高</mdui-segmented-button>
                <mdui-segmented-button value="max">最大</mdui-segmented-button>
              </mdui-segmented-button-group>
            )}
          </div>

          <div className="course-chat__context" data-testid="course-chat-context">
            <span className="course-chat__context-label">
              <mdui-sym-toc aria-hidden="true" />
              课程上下文
            </span>
            {contextCourses.length === 0 ? (
              <span className="course-chat__context-auto">助手自动选择</span>
            ) : (
              <div className="course-chat__context-chips">
                {contextCourses.map((course) => (
                  <span className="course-chat__context-chip" key={course.id} title={course.name}>
                    {course.name}
                  </span>
                ))}
              </div>
            )}
            {contextCourses.length > 0 && (
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
            )}
          </div>

          <div className="course-chat__messages" ref={listRef} data-testid="course-chat-messages">
            {messages.length === 0 && (
              <div className="course-chat__empty">
                <div className="course-chat__empty-mark" aria-hidden="true">
                  <mdui-sym-forum />
                </div>
                <h1>问你的整个课程库</h1>
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
                    ) : message.hint && !message.content ? (
                      <ThinkLine text={message.hint} />
                    ) : (
                      <>
                        {message.reasoning && (
                          <ReasoningBlock reasoning={message.reasoning} active={!!message.streaming && !message.content} />
                        )}
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
                value={input}
                disabled={!sessionReady || loading}
                placeholder="问课程、内容或学习进度，回车发送"
                aria-label="给课程助手发送消息"
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  void send(input);
                }}
              />
              <mdui-tooltip content="发送">
                <mdui-button-icon
                  className="course-chat__send"
                  aria-label="发送"
                  variant="filled"
                  loading={loading}
                  disabled={!sessionReady || loading || !input.trim()}
                  onClick={() => void send(input)}
                >
                  <mdui-sym-send />
                </mdui-button-icon>
              </mdui-tooltip>
            </div>
            <div className="course-chat__composer-note">AI 会结合课程数据与所选技能回答，请核对引用来源。</div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
