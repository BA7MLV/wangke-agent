import { useCallback, useEffect, useRef, useState } from 'react';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import { useNavigate } from 'react-router-dom';
import { useAppNav } from '../components/appNav';
import { MarkdownCode, MarkdownPre } from '../components/mermaid/markdown';
import ModelPicker from '../components/ModelPicker';
import { StreamParagraph, ThinkLine } from '../components/motion';
import { supportsThinking } from '../api/modelCaps';
import { getSettings, useSettings } from '../store/settings';
import { db, type ChatSessionRow } from '../store/db';
import { estimateTokens, fitHistoryToBudget } from '../harness/context';
import { runAgentLoop } from '../harness/agent';
import {
  createLibraryAssistantExecutor,
  LIBRARY_ASSISTANT_ID,
  LIBRARY_ASSISTANT_TOOLS,
  libraryAssistantSystemPrompt,
} from '../harness/libraryAssistant';
import type { ChatMessage, ReasoningEffort } from '../api/siliconflow';
import { confirmDialog, PageShell, useMduiEvent } from '../ui';
import { formatStudyDuration } from '../utils/studyLog';
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

interface ScopeStats {
  courses: number;
  searchableCourses: number;
  inProgress: number;
  studySeconds: number;
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

async function loadScopeStats(): Promise<ScopeStats> {
  const [courses, segmentRows, blockRows, days] = await Promise.all([
    db.videos.toArray(),
    db.segments.filter((row) => row.status === 1 && !!row.text).toArray(),
    db.materialBlocks.toArray(),
    db.studyDays.toArray(),
  ]);

  const searchable = new Set<string>();
  for (const row of segmentRows) searchable.add(row.videoId);
  for (const row of blockRows) searchable.add(row.materialId);

  const inProgress = courses.filter((course) => {
    if (course.finished === 1) return false;
    return course.kind === 'material' ? (course.lastUnit ?? 0) > 0 : (course.lastPosition ?? 0) > 0;
  }).length;

  return {
    courses: courses.length,
    searchableCourses: searchable.size,
    inProgress,
    studySeconds: days.reduce((sum, day) => sum + day.seconds, 0),
  };
}

export default function CourseChat() {
  const navigate = useNavigate();
  const nav = useAppNav('chat');
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<ScopeStats | null>(null);
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
    void loadScopeStats().then(setStats);
  }, [ensureSessions]);

  useEffect(() => {
    if (activeId == null) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void db.chats.where('sessionId').equals(activeId).sortBy('createdAt').then((rows) => {
      if (cancelled) return;
      setMessages(rows.map((row) => ({
        key: `stored-${row.id}`,
        role: row.role === 'assistant' ? 'ai' : 'user',
        content: row.content,
        reasoning: row.reasoning,
      })));
    });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const createSession = async () => {
    if (loading) return;
    const now = Date.now();
    const id = (await db.chatSessions.add({
      videoId: LIBRARY_ASSISTANT_ID,
      title: '新会话',
      createdAt: now,
    })) as number;
    setSessions((current) => [...current, { id, videoId: LIBRARY_ASSISTANT_ID, title: '新会话', createdAt: now }]);
    setActiveId(id);
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
    if (!question || loading || activeId == null) return;
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
      const systemPrompt = libraryAssistantSystemPrompt();
      const history = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
      const budget = settings.contextWindow - estimateTokens(systemPrompt) - estimateTokens(question) - 4096;
      const recent = fitHistoryToBudget(history.slice(0, -1), Math.max(2000, budget));
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...recent.map((row) => ({ role: row.role, content: row.content }) as ChatMessage),
        { role: 'user', content: question },
      ];

      await runAgentLoop(
        chatMessages,
        LIBRARY_ASSISTANT_TOOLS,
        createLibraryAssistantExecutor(),
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
              if (name === 'get_learning_overview') hint = '正在汇总学习记录…';
              if (name === 'get_course_details') hint = '正在读取课程详情…';
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
      void loadScopeStats().then(setStats);
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
        <aside className="course-chat__scope" aria-label="课程助手数据范围">
          <div className="course-chat__scope-heading">
            <span className="course-chat__scope-mark" aria-hidden="true">
              <mdui-sym-forum filled />
            </span>
            <div>
              <div className="course-chat__scope-title">全课程上下文</div>
              <div className="course-chat__scope-subtitle">只读取当前浏览器里的学习数据</div>
            </div>
          </div>

          <div className="course-chat__scope-line" aria-hidden="true" />
          <div className="course-chat__scope-items">
            <div className="course-chat__scope-item">
              <span className="course-chat__scope-dot" />
              <span>课程目录</span>
              <strong>{stats?.courses ?? '—'}</strong>
            </div>
            <div className="course-chat__scope-item">
              <span className="course-chat__scope-dot" />
              <span>可检索课程</span>
              <strong>{stats?.searchableCourses ?? '—'}</strong>
            </div>
            <div className="course-chat__scope-item">
              <span className="course-chat__scope-dot" />
              <span>正在学习</span>
              <strong>{stats?.inProgress ?? '—'}</strong>
            </div>
            <div className="course-chat__scope-item">
              <span className="course-chat__scope-dot" />
              <span>累计学习</span>
              <strong>{stats ? formatStudyDuration(stats.studySeconds) : '—'}</strong>
            </div>
          </div>

          <div className="course-chat__scope-note">
            <mdui-sym-visibility />
            <span>回答会附课程入口和内容位置；修改、删除等操作不会自动执行。</span>
          </div>
        </aside>

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

          <div className="course-chat__messages" ref={listRef} data-testid="course-chat-messages">
            {messages.length === 0 && (
              <div className="course-chat__empty">
                <div className="course-chat__empty-mark" aria-hidden="true">
                  <mdui-sym-forum />
                </div>
                <h1>问你的整个课程库</h1>
                <p>
                  我会按需查询课程目录、字幕与材料正文、学习进度和学习统计，并把依据留在回答里。
                </p>
                {stats == null ? (
                  <div className="course-chat__empty-loading">正在读取课程库…</div>
                ) : stats.courses === 0 ? (
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
                        disabled={loading || activeId == null}
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
                disabled={activeId == null || loading}
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
                disabled={activeId == null || loading || !input.trim()}
                  onClick={() => void send(input)}
                >
                  <mdui-sym-send />
                </mdui-button-icon>
              </mdui-tooltip>
            </div>
            <div className="course-chat__composer-note">AI 会按当前课程库数据回答，请核对引用来源。</div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
