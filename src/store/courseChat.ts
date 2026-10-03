import { create } from 'zustand';
import { getSettings } from './settings';
import { db, type AskUserState, type ChatRow, type ChatSessionRow, type FolderPlanState } from './db';
import { estimateTokens, fitHistoryToBudget } from '../harness/context';
import { runAgentLoop, noAnswerNotice, type AgentStopInfo } from '../harness/agent';
import { resolveMaxRounds } from '../harness/loopGuard';
import { createToolExecutor, SKILL_TOOLS } from '../harness/tools';
import {
  type CourseContextItem,
  createLibraryAssistantExecutor,
  LIBRARY_ASSISTANT_ID,
  LIBRARY_ASSISTANT_TOOLS,
  libraryAssistantSystemPrompt,
} from '../harness/libraryAssistant';
import { applyFolderPlan, type AppliedPlanResult } from '../pipelines/folderPlan';
import { loadSessionSkillMeta, skillMetaBlock } from '../skills/store';
import { supportsThinking } from '../api/modelCaps';
import type { ChatMessage } from '../api/siliconflow';
import type { AskUserData } from '../harness/askUser';
import type { FolderPlan } from '../harness/folderPlan';

/**
 * 课程助手的全局会话状态。
 *
 * ## 为什么状态必须离开页面组件
 *
 * 原来这套逻辑全在 `pages/CourseChat.tsx` 里，于是「切到别的页面再回来」= 重新加载：
 * agent 循环的 `setMessages` 全打在已卸载的组件上，助手消息又因为还没流完而没落库，
 * 用户回来看到的是一句没头没尾的用户提问。**这不是体验问题，是数据丢失。**
 *
 * 搬到这里之后循环与页面解耦：路由卸载只卸载视图，回调照常写 store，回来时消息就在那。
 *
 * ## 刻意不做的事
 *
 * - **不 persist**。这里只有「正在跑的会话」的内存态，历史真源永远是 `chats` 表。
 *   持久化一份会立刻引入「两份真源」（刷新时以哪份为准？），而收益只是省一次读库。
 * - **不做「刷新后续跑」**。刷新会杀掉整个 JS 上下文，要续跑得把工具调用栈重建一遍，
 *   代价远大于收益。刷新后未作答的提问卡会退化成只读（见 CourseChat 里的说明文案）。
 */

/** 视图用的一条消息（比 `ChatRow` 多的是流式中间态） */
export interface CourseChatMessage {
  key: string;
  /** 落库后的行 id：需要就地更新（提问作答、方案落库）时用它 */
  rowId?: number;
  role: 'user' | 'ai';
  content: string;
  reasoning?: string;
  /** 流式过程中的工具提示（ThinkLine），结束即清 */
  hint?: string;
  streaming?: boolean;
  error?: boolean;
  /** 助手向用户提问的选项卡 */
  ask?: AskUserState;
  /** 目录整理方案卡 */
  folderPlan?: FolderPlanState;
}

/** 悬着的「等用户回答」：UI 点击时调 resolve，agent 循环靠它继续往下走 */
export interface PendingAsk {
  messageKey: string;
  resolve: (picked: string) => void;
}

/** 悬着的「等用户确认」 */
export interface PendingPlan {
  messageKey: string;
  resolve: (answer: { ok: boolean; result: AppliedPlanResult | null }) => void;
}

export interface CourseChatStore {
  ready: boolean;
  sessions: ChatSessionRow[];
  activeId: number | null;
  /** 本会话消息已从库里读完（false 时禁发：否则会基于空历史发第一轮） */
  loaded: boolean;
  messages: CourseChatMessage[];
  loading: boolean;
  /** 输入框草稿：切页面不该吃掉用户打了一半的字 */
  draft: string;
  courseCount: number | null;
  skillIds: number[] | undefined;
  contextCourses: CourseContextItem[];
  pendingAsk: PendingAsk | null;
  pendingPlan: PendingPlan | null;
  /**
   * 方案正在落库。
   *
   * 刻意与 `loading` 分开：循环「等用户确认」期间 `loading` 一直是 true，拿它当 busy 的话
   * 「确认执行」按钮会一直显示成 loading 且点不动 —— 循环在等用户，用户却在等按钮解锁。
   */
  planApplying: boolean;

  bootstrap: () => Promise<void>;
  loadSession: (id: number) => Promise<void>;
  createSession: () => Promise<void>;
  /** 删掉当前会话并切到剩下的最后一个；返回 false = 被拒（正在生成） */
  deleteSession: () => Promise<boolean>;
  setDraft: (text: string) => void;
  send: (text: string) => Promise<void>;
  setSkillIds: (ids: number[] | undefined) => void;
  clearCourseContext: () => void;
  /** 提问卡作答（同时把选择落成一条 user 消息） */
  answerAsk: (option: string) => Promise<void>;
  /** 停止生成：中断当前的 LLM 请求与 agent 循环（已流出的内容保留） */
  stop: () => void;
  /** 确认执行目录整理方案 */
  confirmPlan: () => Promise<{ ok: boolean; error?: string }>;
  /** 放弃目录整理方案（不落库） */
  cancelPlan: () => Promise<void>;
}

const COURSE_ASSISTANT_TOOLS = [...LIBRARY_ASSISTANT_TOOLS, ...SKILL_TOOLS];

let keySeq = 0;
const nextKey = () => `course-chat-${Date.now()}-${keySeq++}`;

/**
 * 正在跑的那一轮的 abort 句柄。
 *
 * 放**模块级**而不是 store state：它要在 React 渲染之外被 stop() 读到，
 * 塞进 state 只会平白多几次渲染（有没有在跑看 `loading` 就够）。
 */
let inflightAbort: AbortController | null = null;

export const useCourseChat = create<CourseChatStore>()((set, get) => ({
  ready: false,
  sessions: [],
  activeId: null,
  loaded: false,
  messages: [],
  loading: false,
  draft: '',
  courseCount: null,
  skillIds: undefined,
  contextCourses: [],
  pendingAsk: null,
  pendingPlan: null,
  planApplying: false,

  // ── 启动 / 会话装载 ────────────────────────────────────────────────────────
  bootstrap: async () => {
    if (get().ready) return;
    const [rows, count] = await Promise.all([
      db.chatSessions.where('videoId').equals(LIBRARY_ASSISTANT_ID).sortBy('createdAt'),
      db.videos.count(),
    ]);
    const sessions = rows.length > 0 ? rows : [await newSessionRow()];
    set({ sessions, ready: true, courseCount: count });
    const activeId = get().activeId;
    if (activeId == null || !sessions.some((row) => row.id === activeId)) {
      set({ activeId: sessions[sessions.length - 1].id! });
    }
  },

  loadSession: async (id) => {
    // 生成中不许切会话：`messages` 里有一条正在流的消息，切走再切回来会从库里重读，
    // 那条消息的内容会被整段丢掉（库里还没有它）。工具栏的会话选择器此时也是禁用的。
    if (get().loading) return;
    // 切走前把上一个会话悬着的提问/确认收掉：那个 promise 不会再有人 resolve，循环会永久挂着
    releasePending(get());
    set({ activeId: id, loaded: false, messages: [], skillIds: undefined, contextCourses: [] });
    const [session, rows] = await Promise.all([
      db.chatSessions.get(id),
      db.chats.where('sessionId').equals(id).sortBy('createdAt'),
    ]);
    if (get().activeId !== id) return; // 装载期间又切了会话
    const contextIds = session?.contextCourseIds ?? [];
    const contextRows = contextIds.length > 0
      ? await db.videos.where('id').anyOf(contextIds).toArray()
      : [];
    if (get().activeId !== id) return;
    const byId = new Map(contextRows.map((course) => [course.id, course.name]));
    set({
      skillIds: session?.skillIds,
      contextCourses: contextIds
        .filter((cid) => byId.has(cid))
        .map((cid) => ({ id: cid, name: byId.get(cid)! })),
      messages: rows.map(toMessage),
      loaded: true,
    });
  },

  createSession: async () => {
    if (get().loading) return;
    const row = await newSessionRow();
    set((s) => ({ sessions: [...s.sessions, row], contextCourses: [] }));
    await get().loadSession(row.id!);
  },

  deleteSession: async () => {
    const id = get().activeId;
    if (id == null || get().loading) return false;
    releasePending(get());
    await db.transaction('rw', db.chats, db.chatSessions, async () => {
      await db.chats.where('sessionId').equals(id).delete();
      await db.chatSessions.delete(id);
    });
    const rows = await db.chatSessions.where('videoId').equals(LIBRARY_ASSISTANT_ID).sortBy('createdAt');
    const sessions = rows.length > 0 ? rows : [await newSessionRow()];
    set({ sessions });
    await get().loadSession(sessions[sessions.length - 1].id!);
    return true;
  },

  // ── 设置类 ────────────────────────────────────────────────────────────────
  setDraft: (text) => set({ draft: text }),

  setSkillIds: (ids) => {
    const id = get().activeId;
    if (id == null) return;
    set({ skillIds: ids });
    void db.chatSessions.where('id').equals(id).modify((row) => {
      if (ids === undefined) delete row.skillIds;
      else row.skillIds = ids;
    });
  },

  clearCourseContext: () => {
    const id = get().activeId;
    if (id == null || get().contextCourses.length === 0) return;
    set({ contextCourses: [] });
    void db.chatSessions.where('id').equals(id).modify((row) => {
      delete row.contextCourseIds;
    });
  },

  // ── 发一轮 ────────────────────────────────────────────────────────────────
  send: async (rawText) => {
    const text = rawText.trim();
    const state = get();
    if (!text || state.loading || state.activeId == null || !state.loaded) return;

    // 有提问卡悬着时，输入框里的文字是**对这次提问的回答**，不是新一轮提问。
    // 另起一轮会有两个循环同时往同一个会话写消息，助手与用户消息会交错。
    if (state.pendingAsk) {
      await get().answerAsk(text);
      return;
    }

    const sessionId = state.activeId;
    const firstMessage = state.messages.length === 0;
    const userKey = nextKey();
    const aiKey = nextKey();
    let currentKey = aiKey;
    let answer = '';
    let reasoning = '';
    /**
     * 最后一轮流出的旁白 + 最后一次工具提示。
     *
     * 留着它们是因为 `onRoundStart` 会把当轮正文清空（旁白不是答案），而**轮次用尽时
     * 模型可能一个字都不说** —— 那时若只有 `answer`，用户看到的就是一片空白，
     * 六轮工具调用等于白跑（实测：只剩一句「（未获得回答）」）。
     */
    let lastNarration = '';
    let lastHint = '';
    /** 实际跑过的轮数（`onRoundStart` 记的）。兜底文案只能印真实值，不能拿设置里的上限顶 */
    let roundsRan = 0;
    /**
     * 护栏停下的情况（见 agent.ts 的 onStop）。
     *
     * 用数组而不是 `let x: T | null`：赋值发生在回调里，TS 的控制流分析在读它的地方
     * 仍然认为它是 `null`（于是 `x?.granted` 报「property does not exist on never」）。
     * 数组取下标不做这种收窄，是这里最省事又不会骗过编译器的写法。
     */
    const stopped: AgentStopInfo[] = [];
    const abort = new AbortController();
    inflightAbort = abort;
    const patchAi = (patch: Partial<CourseChatMessage>) => {
      set((s) => ({ messages: s.messages.map((m) => (m.key === currentKey ? { ...m, ...patch } : m)) }));
    };

    /**
     * 在「用户回应」处把消息**封口并另起一条**。
     *
     * 为什么要拆：提问卡（第 1 轮）与它的回答（第 2 轮）本来是两条消息的内容，挤在同一条里
     * 读起来是「先给结论、下面才是问题」，而用户点选的那句话还会落在回答之后 —— 因果全反。
     * 拆开后 transcript 是「卡片 → 用户的选择 → 回答」，与真实顺序一致。
     *
     * 顺带的好处：卡片那条**当场落库**，「问完就关掉浏览器」也不会把卡弄丢（否则助手消息要
     * 等整轮结束才写，中途退出 = 卡片与选择一起消失）。
     */
    const rotateAi = async () => {
      const message = get().messages.find((m) => m.key === currentKey);
      if (!message) return;
      const rowId = (await db.chats.add({
        videoId: LIBRARY_ASSISTANT_ID,
        sessionId,
        role: 'assistant',
        content: message.content,
        createdAt: Date.now(),
        reasoning: message.reasoning,
        ...(message.ask ? { ask: message.ask } : {}),
        ...(message.folderPlan ? { folderPlan: message.folderPlan } : {}),
      })) as number;
      const fresh = nextKey();
      set((s) => ({
        messages: [
          ...s.messages.map((m) =>
            m.key === currentKey ? { ...m, rowId, streaming: false, hint: undefined } : m,
          ),
          { key: fresh, role: 'ai', content: '', streaming: true },
        ],
      }));
      currentKey = fresh;
    };

    const holdAsk = (ask: AskUserData) =>
      new Promise<string>((resolve) => {
        patchAi({ ask: { ...ask } });
        set({
          pendingAsk: {
            messageKey: currentKey,
            resolve: async (picked) => {
              await rotateAi();
              resolve(picked);
            },
          },
        });
      });
    const holdPlan = (plan: FolderPlan) =>
      new Promise<{ ok: boolean; result: AppliedPlanResult | null }>((resolve) => {
        patchAi({ folderPlan: { ...plan, applied: 0 } });
        set({
          pendingPlan: {
            messageKey: currentKey,
            resolve: async (verdict) => {
              await rotateAi();
              resolve(verdict);
            },
          },
        });
      });

    set({ draft: '', loading: true });
    set((s) => ({
      messages: [
        ...s.messages,
        { key: userKey, role: 'user', content: text },
        { key: aiKey, role: 'ai', content: '', streaming: true },
      ],
    }));

    try {
      await db.chats.add({
        videoId: LIBRARY_ASSISTANT_ID,
        sessionId,
        role: 'user',
        content: text,
        createdAt: Date.now(),
      });

      if (firstMessage) {
        const title = text.length > 18 ? `${text.slice(0, 18)}…` : text;
        await db.chatSessions.update(sessionId, { title });
        set((s) => ({ sessions: s.sessions.map((row) => (row.id === sessionId ? { ...row, title } : row)) }));
      }

      const settings = getSettings();
      const [history, skillMetas] = await Promise.all([
        db.chats.where('sessionId').equals(sessionId).sortBy('createdAt'),
        loadSessionSkillMeta(state.skillIds),
      ]);
      const skillBlock = skillMetas.length > 0 ? skillMetaBlock(skillMetas) : undefined;
      const systemPrompt = libraryAssistantSystemPrompt(skillBlock, state.contextCourses);
      const budget = settings.contextWindow - estimateTokens(systemPrompt) - estimateTokens(text) - 4096;
      const recent = fitHistoryToBudget(history.slice(0, -1), Math.max(2000, budget));
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...recent.map((row) => ({ role: row.role, content: row.content }) as ChatMessage),
        { role: 'user', content: text },
      ];

      const libraryExecutor = createLibraryAssistantExecutor({
        contextCourseIds: state.contextCourses.map((course) => course.id),
        onContextChange: async (courses) => {
          set({ contextCourses: courses });
          await db.chatSessions.where('id').equals(sessionId).modify((row) => {
            if (courses.length === 0) delete row.contextCourseIds;
            else row.contextCourseIds = courses.map((course) => course.id);
          });
        },
        onAskUser: holdAsk,
        onPlanFolders: holdPlan,
      });
      const skillExecutor = createToolExecutor(LIBRARY_ASSISTANT_ID, { allowedSkillIds: state.skillIds });
      const executeTool = (name: string, args: Record<string, unknown>) =>
        name === 'use_skill' || name === 'read_skill_reference'
          ? skillExecutor(name, args)
          : libraryExecutor(name, args);

      await runAgentLoop(
        chatMessages,
        COURSE_ASSISTANT_TOOLS,
        executeTool,
        {
          thinkingEffort:
            settings.thinkingEnabled && supportsThinking(settings.llmModel) ? settings.thinkingEffort : undefined,
          onReasoningDelta: (delta) => {
            reasoning += delta;
            patchAi({ reasoning });
          },
          onDelta: (delta) => {
            answer += delta;
            patchAi({ content: answer, hint: undefined });
          },
          onRoundStart: () => {
            // 上一轮流出的只是检索旁白，答案要等后面的轮次 —— 但**存一份**：
            // 轮次用尽而模型不吭声时，它是用户唯一能看到「它干了什么」的线索
            if (answer.trim()) lastNarration = answer.trim();
            answer = '';
            roundsRan++;
            patchAi({ content: '', hint: undefined });
          },
          onToolStart: (name, argsJson) => {
            lastHint = toolHint(name, argsJson);
            patchAi({ hint: lastHint });
          },
          onStop: (info) => {
            stopped.push(info);
          },
          signal: abort.signal,
        },
        resolveMaxRounds(settings.agentRounds),
      );
      const closeOut = stopped[stopped.length - 1];
      const finalAnswer = answer.trim() || noAnswerNotice({
        // 没有 closeOut 只可能是「循环正常结束却一个字没说」——那正是 `empty` 这条闸管的事，
        // 猜成 `rounds` 会印出「已到轮次上限」这种从未发生过的原因（实测文案：0 次工具调用）
        reason: closeOut?.reason ?? 'empty',
        rounds: closeOut?.rounds ?? roundsRan,
        ...(closeOut?.detail ? { detail: closeOut.detail } : {}),
        requestedTools: closeOut?.requestedTools ?? [],
        narration: lastNarration,
        hint: lastHint,
      });
      patchAi({ content: finalAnswer, streaming: false, hint: undefined });
      // 落的是**当前这条**（`currentKey` 可能已经因提问/方案而轮换过一次），
      // 卡片状态也从 store 里这条消息读，而不是读闭包里的副本：用户可能在这期间点了选项
      // （ask.picked 变了）或确认了方案（applied 变了），那些更新只落在 store 上。
      const finalMessage = get().messages.find((m) => m.key === currentKey);
      const rowId = (await db.chats.add({
        videoId: LIBRARY_ASSISTANT_ID,
        sessionId,
        role: 'assistant',
        content: finalAnswer,
        createdAt: Date.now(),
        reasoning: reasoning || undefined,
        ...(finalMessage?.ask ? { ask: finalMessage.ask } : {}),
        ...(finalMessage?.folderPlan ? { folderPlan: finalMessage.folderPlan } : {}),
      })) as number;
      patchAi({ rowId });
    } catch (error) {
      // 用户按了停止：这不是错误。保留已经流出的内容，只补一句「已停止」——
      // 报成「回答失败：The user aborted a request」只会让人以为出问题了。
      // **必须落库**：停止之后这段内容要留住，否则刷新就没了，等于「停止」= 白生成一轮
      if (abort.signal.aborted) {
        const partial = answer.trim() || lastNarration.trim();
        const content = partial ? `${partial}\n\n_（已停止生成）_` : '_（已停止生成）_';
        patchAi({ streaming: false, hint: undefined, content });
        // 立刻恢复可输入：下面还要落一次库，等它落完才解锁的话，用户按完停止还得干等
        set({ loading: false });
        const rowId = (await db.chats.add({
          videoId: LIBRARY_ASSISTANT_ID,
          sessionId,
          role: 'assistant',
          content,
          createdAt: Date.now(),
          reasoning: reasoning || undefined,
        })) as number;
        patchAi({ rowId });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        patchAi({
          streaming: false,
          hint: undefined,
          error: true,
          content: answer.trim() ? `${answer}\n\n> 回答中断：${message}` : `回答失败：${message}`,
        });
      }
    } finally {
      // 悬着的提问/确认在这里一定已经有人 resolve 过（正常路径），但异常路径下可能还挂着 ——
      // releasePending 会把没 resolve 的收掉，绝不让某个 promise 永远等下去。
      releasePending(get());
      if (inflightAbort === abort) inflightAbort = null;
      set({ loading: false });
    }
  },

  // ── 停止生成 ──────────────────────────────────────────────────────────────
  stop: () => {
    // 只断 LLM 请求与循环。悬着的提问/方案由 releasePending 收掉（`finally` 里统一做）
    inflightAbort?.abort();
  },

  // ── 提问卡作答 ────────────────────────────────────────────────────────────
  answerAsk: async (option) => {
    const { pendingAsk, activeId } = get();
    if (!pendingAsk || activeId == null) return;
    const picked = option.trim();
    if (!picked) return;
    set((s) => ({
      messages: s.messages.map((m) =>
        m.key === pendingAsk.messageKey && m.ask
          ? { ...m, ask: { ...m.ask, picked } }
          : m,
      ),
    }));
    // 作答也要落成一条 user 消息：历史回放时这条消息旁边就有一张提问卡，
    // 只有卡上那一句选中项而没有对话行，读起来会像凭空冒出来的。
    // 同时要**插进内存里的消息列表**：只落库不插列表的话当前这一屏看不到「你回答了什么」，
    // 要刷新才冒出来 —— 卡片与对话行当场对不上。
    const rowId = (await db.chats.add({
      videoId: LIBRARY_ASSISTANT_ID,
      sessionId: activeId,
      role: 'user',
      content: picked,
      createdAt: Date.now(),
    })) as number;
    set((s) => ({
      messages: [...s.messages, { key: `stored-${rowId}`, rowId, role: 'user', content: picked }],
      pendingAsk: null,
    }));
    pendingAsk.resolve(picked);
  },

  // ── 目录整理方案 ──────────────────────────────────────────────────────────
  confirmPlan: async () => {
    const { pendingPlan } = get();
    if (!pendingPlan) return { ok: false };
    const plan = get().messages.find((m) => m.key === pendingPlan.messageKey)?.folderPlan;
    if (!plan) {
      set({ pendingPlan: null });
      pendingPlan.resolve({ ok: false, result: null });
      return { ok: false };
    }
    set({ planApplying: true });
    try {
      const result = await applyFolderPlan(plan);
      set((s) => ({
        planApplying: false,
        messages: s.messages.map((m) =>
          m.key === pendingPlan.messageKey && m.folderPlan
            ? { ...m, folderPlan: { ...m.folderPlan, applied: 1 } }
            : m,
        ),
      }));
      set({ pendingPlan: null });
      pendingPlan.resolve({ ok: true, result });
      return { ok: true };
    } catch (e) {
      // 落库失败要把卡片退回「待确认」：留在「已执行」上会骗用户说整理完成了
      set((s) => ({
        planApplying: false,
        messages: s.messages.map((m) =>
          m.key === pendingPlan.messageKey && m.folderPlan
            ? { ...m, folderPlan: { ...m.folderPlan, applied: 0 } }
            : m,
        ),
      }));
      set({ pendingPlan: null });
      pendingPlan.resolve({ ok: false, result: null });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  cancelPlan: async () => {
    const { pendingPlan } = get();
    if (!pendingPlan) return;
    set((s) => ({
      messages: s.messages.map((m) =>
        m.key === pendingPlan.messageKey && m.folderPlan
          ? { ...m, folderPlan: { ...m.folderPlan, applied: 2 } }
          : m,
      ),
    }));
    set({ pendingPlan: null });
    pendingPlan.resolve({ ok: false, result: null });
  },
}));

/** 新建一条会话行并落库 */
async function newSessionRow(): Promise<ChatSessionRow> {
  const now = Date.now();
  const id = (await db.chatSessions.add({
    videoId: LIBRARY_ASSISTANT_ID,
    title: '新会话',
    createdAt: now,
  })) as number;
  return { id, videoId: LIBRARY_ASSISTANT_ID, title: '新会话', createdAt: now };
}

/**
 * 收掉还悬着的提问 / 确认。
 *
 * 漏掉这一步的后果不是「多占点内存」：那个 promise 永远不 resolve，agent 循环就卡在
 * `await executeTool(...)` 上，`loading` 再也回不到 false，用户连发都发不出去。
 */
function releasePending(state: CourseChatStore) {
  const { pendingAsk, pendingPlan } = state;
  if (pendingAsk) pendingAsk.resolve('（用户已离开该会话）');
  if (pendingPlan) pendingPlan.resolve({ ok: false, result: null });
  if (pendingAsk || pendingPlan) useCourseChat.setState({ pendingAsk: null, pendingPlan: null });
}

function toMessage(row: ChatRow): CourseChatMessage {
  return {
    key: `stored-${row.id}`,
    rowId: row.id!,
    role: row.role === 'assistant' ? 'ai' : 'user',
    content: row.content,
    reasoning: row.reasoning,
    ask: row.ask,
    folderPlan: row.folderPlan,
  };
}

/** 工具开始时的状态提示。工具名对不上就退回通用文案（真正的错误由 executor 返回给模型） */
function toolHint(name: string, argsJson: string): string {
  const fallback = '正在读取课程库…';
  try {
    const args = JSON.parse(argsJson || '{}') as { query?: string };
    if (name === 'search_course_library' && args.query) return `正在跨课程检索：${args.query}`;
  } catch {
    return fallback;
  }
  switch (name) {
    case 'list_courses': return '正在整理课程清单…';
    case 'get_learning_overview': return '正在汇总学习记录…';
    case 'get_course_details': return '正在读取课程详情…';
    case 'set_course_context': return '正在选择相关课程…';
    case 'use_skill': return '正在加载技能规范…';
    case 'read_skill_reference': return '正在查阅技能参考资料…';
    case 'ask_user': return '等你选一个…';
    case 'list_folders': return '正在查看现有分类…';
    case 'propose_folder_plan': return '正在整理分类方案…';
    default: return fallback;
  }
}
