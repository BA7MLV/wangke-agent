/**
 * 来宾镜像页的问答面板（`/live` 详情页底部）。
 *
 * ## 它是什么、不是什么
 *
 * **是** `components/ChatPanel.tsx` 渲染契约的**来宾版**：同一套流式语义（旁白清空、
 * 工具提示、思考块、流式 Markdown、题卡/图卡）、同一批渲染件（`XMarkdown` +
 * `motion.tsx` 的 `ThinkLine`/`StreamParagraph`/`Collapse` + `QuizCard` + `WidgetBlock`）、
 * 同一份引用链接化（`utils/linkify.ts`）。两边渲染的不是两套东西，是同一套东西的两次装配。
 *
 * **不是** ChatPanel 本身。ChatPanel 的数据来自本机 Dexie、会话有 id、要落库、还要划词
 * 引用 / 截图 / 出题 / 会话切换 / 思考深度 —— 那些在镜像页一个入口都没有（来宾是只读
 * 镜像，见 LiveGuest.tsx 文件头不变量 9）。把它整份复制过来只会得到一个带 800 行死代码的
 * 组件，而且下一次改渲染语义时两份必然漂移。所以这里是**只保留渲染层**的窄组件。
 *
 * ## 数据从哪来：`turns` prop，不是自己订阅
 *
 * `LiveGuest` 的 `onTurn` / `onPendingOps` 是**构造期**回调（`livelink/guest.ts` 的
 * `LiveGuestOptions`），而那个 client 由页面在 `connect()` 里创建。要让面板自己订阅，
 * 就得改 guest.ts 的公开方法集合 —— 那是跨任务的契约文件，本任务不动它。于是页面把
 * `onTurn` 收到的**副本**攒成 `turns` 传下来：面板拿到的每一份都是 guest 侧 turn 的
 * 快照（guest.ts 保证「每次都给一份新副本」），UI 改不坏内部状态。
 * 面板自己只留**纯本地**的东西：输入框文本与题卡的选中态。
 *
 * ## 为什么直接渲染 `turn.content`，面板里不再清一次旁白
 *
 * agent 循环的既有约定是「`onRoundStart` 之后新清空正文，等最终回答」——上一轮流出来的
 * 只是检索旁白。`GuestCore.onChatEv` 的 `case 'round'` 已经做了这个 patch
 * （`turn.content = ''`，见 guest.ts 该处的注释）。面板若**再**清一次不会更安全，只会把
 * 这条约定抄成第二份、而它与 host 侧真正的事件顺序脱钩。这里因此把「旁白已清」当成
 * guest.ts 提供的不变量直接消费 —— 真要退回「两轮正文叠在一起」，改 guest.ts 那一处即可，
 * 面板不需要动。
 *
 * ## 样式复用（为什么不自带一套气泡 CSS）
 *
 * 气泡、思考块、时间戳链接、输入区的类名全部**沿用** `components/chat-panel.css` 里的
 * `.chat-*`，本组件只新增 `live-chat-panel.css` 里那几个真正新的壳（滚动区高度上限、
 * 离线提示、待补发提示）。理由是仓库自己的那条规矩：两套并存必然漂移。把同样的圆角 /
 * 颜色 / 字号抄一份到 `live-chat-panel.css`，下一次改气泡样式只改一处，来宾那边就永远停在
 * 旧版 —— 而「来宾的气泡和主机不一样」正是用户能一眼看出的那种不一致。
 * （这些 CSS 是全局的：路由全是静态 import，`chat-panel.css` 在应用启动时就已载入。）
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import type { GuestTurn, LiveGuest } from '../livelink/guest';
import type { UnitKind } from '../materials/units.ts';
import { validateQuiz, type QuizData } from '../harness/quiz';
import type { WidgetPayload } from '../harness/widgetRuntime';
import { linkifyFrames, linkifyTimestamps, linkifyUnits } from '../utils/linkify';
import { useSettings } from '../store/settings';
import { toast, Sym } from '../ui';
import { Button } from '@heroui/react';
import { useResolvedDark } from '../ui/theme';
import { ThinkLine, StreamParagraph, Collapse } from './motion';
import { MarkdownCode, MarkdownPre } from './mermaid/markdown';
import QuizCard from './QuizCard';
import WidgetBlock from './WidgetBlock';
import './live-chat-panel.css';

/** QuizCard 要的形状。**本地定义而不是 import store/db 的 QuizState**：guest 不碰 db
 * （不变量 9），连类型都从那儿长出来都让人误会 —— 这个文件里没有任何 db import。 */
interface QuizState {
  data: QuizData;
  picks: number[];
}

export interface LiveChatPanelProps {
  /** 链路客户端：ask / stopTurn 都走它。LLM 跑在主机上（凭据不过链路，不变量 1） */
  guest: LiveGuest;
  /** 已发出的轮次快照，按发起顺序（页面的 onTurn 收集） */
  turns: GuestTurn[];
  videoId: string;
  videoName: string;
  /** 阅读材料（kind 决定走 linkifyUnits 而不是 linkifyTimestamps） */
  isMaterial?: boolean;
  /** 材料的定位单元类型；**不传 = 视频课程** */
  materialKind?: UnitKind;
  /** 正文/题卡里的 [mm:ss] 跳转。视频课传 seekTo；材料不传（没有播放器，见文件头取舍） */
  onSeek?: (t: number) => void;
  /** 材料页码/段号引用跳转。不给就是「点了说一句做不到」，不留死链 */
  onSeekUnit?: (unit: number) => void;
  /** 主机在不在席：false 时禁用输入框，并在它边上把「提问会失败」这句话说在前面 */
  online?: boolean;
  /** 一问真的发出去之后调一次（页面用它把「有人在操作」这条标记打上） */
  onAsk?: (text: string) => void;
}

/**
 * 思考链折叠块。
 *
 * ⚠️ ChatPanel 里的那个叫 `ReasoningBlock` 且**没有导出**（它是那个文件的私有件）。
 * 本任务不动 ChatPanel（改它会牵动主机的问答面板），所以这里按同一份渲染契约重写一个：
 * 同样用 `motion.tsx` 的 `Collapse` 做 0fr→1fr 的轨道、同样「流式中且正文未出时默认展开、
 * 之后自动收起、之后可手动展开」。结构与类名与 ChatPanel 一致，样式直接吃 chat-panel.css。
 */
function ReasoningChain({ reasoning, active }: { reasoning: string; active: boolean }) {
  const [open, setOpen] = useState(active);
  const bodyId = useId();
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <div className="chat-reason">
      <button
        type="button"
        className="chat-reason__toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <Sym name="chevron_right" className={open ? 'chat-reason__chevron chat-reason__chevron--open' : 'chat-reason__chevron'} />
        {active ? '思考中…' : '思考过程'}
      </button>
      <Collapse open={open} id={bodyId} innerClassName="chat-reason__body">
        {reasoning}
      </Collapse>
    </div>
  );
}

/**
 * 远端题卡载荷 → QuizCard 要的形状。
 *
 * **复用 `harness/quiz` 的 `validateQuiz`，不自己写一份字段校验**：校验规则只有那一份，
 * 且它就是主机侧 `present_quiz` 工具出口用的那一份 —— 两边判据一致，链路上的题卡不会
 * 因为「来宾这边多认了几个字段」而渲染出主机不认的东西。校验不过就整块不显示：畸形题卡
 * 渲染出来是空题干 + 四个空选项，比不显示更难懂。
 */
function toQuiz(raw: unknown): QuizState | null {
  const data = (raw as { data?: unknown } | null)?.data;
  const v = validateQuiz(data);
  return v.ok ? { data: v.quiz, picks: v.quiz.questions.map(() => -1) } : null;
}

/** 远端图卡载荷 → WidgetBlock 要的形状。html 不是字符串就整块不显示（buildWidgetDocument
 * 自己会抛，但那时已经渲染出一个空壳与一句错误，不如在进组件前就判掉）。 */
function toWidget(raw: unknown): WidgetPayload | null {
  const p = raw as { html?: unknown } | null;
  return p && typeof p.html === 'string' && p.html.trim() ? (p as WidgetPayload) : null;
}

export default function LiveChatPanel({
  guest,
  turns,
  videoId,
  videoName,
  isMaterial = false,
  materialKind,
  onSeek,
  onSeekUnit,
  online = true,
  onAsk,
}: LiveChatPanelProps) {
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  /**
   * 题卡的本地选中态：turnId → 每题下标。
   *
   * ⚠️ **只记在本地、刻意不写回**：作答回写（`card.decide` op 或本机的 chats.quiz 更新）
   * 不在 P2 范围。这里的取舍是「本轮会话内看得见自己选了什么、解析照常展开」，代价是
   * 刷新后这些选择消失、主机那边也不会记下这次作答。要改的话是给 `GuestTurn.quiz`
   * 补一条 op，而不是在这里偷偷写库 —— 写库是 guest 侧的结构性禁令。
   */
  const [picks, setPicks] = useState<Record<string, number[]>>({});

  // widget 的明暗是 JS 算的（mdui 的 auto 模式要问系统偏好），与 ChatPanel 同一取法
  const widgetDark = useResolvedDark(useSettings((s) => s.theme));

  /** 正在流的那一轮（停止键只停它）。host 侧问答全局串行，同时最多一轮。 */
  const streaming = turns.find((t) => t.state === 'streaming');

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || !videoId) return;
      // 离线时**不拦**：guest.ts 的 ask 会当场判错并抛一个 error 轮次（设计非目标里明确
      // 「不做 guest 端离线攒着待发的提问」——攒起来会让用户以为已经问出去了，而主机
      // 可能压根不在）。这里提前 return 反而会变成「按了没反应」，比显示一句明说更糟。
      guest.ask(videoId, text);
      setInput('');
      onAsk?.(text);
    },
    [guest, videoId, onAsk],
  );

  // 新内容/新轮次时滚到底：镜像页没有 ChatPanel 那套「用户自己往上翻就别拽回去」的判断，
  // 但问答本来就短，粘底是唯一合乎直觉的行为（也是 ChatPanel 的既有行为）。
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  /** 自定义链接渲染：`#seek-N` 跳播放器、`#unit-N` 跳材料页/段，其余外链新窗口开 */
  const SeekLink = useCallback(
    ({ href, children }: ComponentProps & { href?: string }) => {
      const h = href ?? '';
      if (h.startsWith('#seek-')) {
        const secs = Number(h.slice(6));
        return (
          <a
            className="chat-ts"
            onClick={(e) => {
              e.preventDefault();
              onSeek?.(secs);
            }}
          >
            {children}
          </a>
        );
      }
      if (h.startsWith('#unit-')) {
        const unit = Number(h.slice(6));
        return (
          <a
            className="chat-ts"
            onClick={(e) => {
              e.preventDefault();
              if (onSeekUnit) onSeekUnit(unit);
              // 镜像页还没有材料正文阅读器（P1 只送了 meta/content/cover）。宁可说一句
              // 「跳不过去」，也不要留一个点了没反应的死链 —— 那比不说更像坏了。
              else toast.info('这份材料的正文还没送上链路，暂时跳不过去');
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a href={h} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    [onSeek, onSeekUnit],
  );

  /**
   * 自定义图片渲染：`#frame-N`（由 linkifyFrames 生成）降级成**可点击的时间戳**。
   *
   * 与 ChatPanel 的 FrameThumb 不同的是：那张卡要从本机 `db.frames` 取缩略图，而 guest
   * 没有帧库（P1 明确不发 frames，见 payloads.ts 文件头「P1 为什么只发 meta/content/cover」）。
   * 渲染一个 `<img src="#frame-N">` 只会得到浏览器那个「图片加载失败」的小图标 ——
   * 所以走 ChatPanel 自己定下的那条降级路径：**匹配不到画面时降级为可点击的时间戳链接**。
   * `#frame-` 是 guest 侧第一个由 linkifyFrames 接管的钩子，将来链路支持单帧了只要在这里
   * 换成真的取帧，正文一侧一个字都不用改。
   */
  const FrameImage = useCallback(
    ({ src, alt }: ComponentProps & { src?: string; alt?: string }) => {
      if (src?.startsWith('#frame-')) {
        const secs = Number(src.slice(7));
        return (
          <a className="chat-ts" onClick={() => onSeek?.(secs)}>
            {alt || `画面 ${secs}s`}
          </a>
        );
      }
      return <img src={src} alt={alt} />;
    },
    [onSeek],
  );

  const components = useMemo(
    () => ({ a: SeekLink, p: StreamParagraph, img: FrameImage, code: MarkdownCode, pre: MarkdownPre }),
    [SeekLink, FrameImage],
  );

  /** 正文里的引用链接化。**三条分支与 ChatPanel 逐条一致**：材料只跑 linkifyUnits
   *（`#seek-`/`#frame-` 在材料语境里是死链），视频课跑 timestamps + frames。 */
  const linkify = useCallback(
    (text: string) => {
      if (isMaterial && materialKind) return linkifyUnits(text, materialKind);
      return linkifyTimestamps(linkifyFrames(text));
    },
    [isMaterial, materialKind],
  );

  const seekable = !isMaterial && !!onSeek;

  return (
    <div className="live-chat" data-testid="live-chat">
      <div className="chat-list-wrap live-chat__list" ref={listRef} data-testid="live-chat-list">
        {turns.length === 0 && (
          <div className="live-chat__empty" data-testid="live-chat-empty">
            针对《{videoName}》提问。回答在主机上生成后流回这台设备
            {/* 有播放器才提「点时间戳跳转」：材料没有播放器，写上去就是一句做不到的承诺 */}
            {onSeek ? '；正文里的 [03:25] 可以点一下跳转。' : '。'}
          </div>
        )}
        {turns.map((t) => {
          const quiz = toQuiz(t.quiz);
          const widget = toWidget(t.widget);
          const localPicks = picks[t.turnId] ?? quiz?.picks ?? [];
          // 错误轮的正文：已流出一半就保留并补一句中断说明，否则整体换成失败提示
          // （与 ChatPanel 的 catch 分支同一套形状）
          const failed = t.state === 'error';
          const body = failed
            ? t.content.trim()
              ? `${t.content}\n\n> 回答中断：${t.error ?? '未知原因'}`
              : `回答失败：${t.error ?? '未知原因'}`
            : t.content;
          return (
            <div className="live-chat__turn" key={t.turnId} data-testid="live-chat-turn">
              <div className="chat-msg chat-msg--user" data-testid="live-chat-user">
                <div className="chat-bubble chat-bubble--user">{t.question}</div>
              </div>
              <div
                className="chat-msg chat-msg--ai"
                data-testid="live-chat-ai"
                data-streaming={t.state === 'streaming' ? 'true' : undefined}
                data-error={failed ? 'true' : undefined}
                data-state={t.state}
              >
                <div className="chat-bubble chat-bubble--ai">
                  {t.toolHint && !t.content ? (
                    <ThinkLine text={t.toolHint} />
                  ) : (
                    <>
                      {t.reasoning && <ReasoningChain reasoning={t.reasoning} active={t.state === 'streaming' && !t.content} />}
                      <XMarkdown
                        content={linkify(body)}
                        components={components}
                        streaming={{ hasNextChunk: t.state === 'streaming', tail: t.state === 'streaming' }}
                      />
                      {quiz && (
                        <QuizCard
                          quiz={quiz.data}
                          picks={localPicks}
                          onAnswer={(qi, oi) =>
                            setPicks((prev) => {
                              // 基线取本轮已记的（没有就取题卡的初始全 -1）：QuizCard 会禁用
                              // 已答的题，所以这里永远只需要改一格
                              const next = (prev[t.turnId] ?? quiz.picks).slice();
                              next[qi] = oi;
                              return { ...prev, [t.turnId]: next };
                            })
                          }
                          {...(onSeek && !isMaterial ? { onSeek } : {})}
                          seekable={seekable}
                        />
                      )}
                      {widget && (
                        <WidgetBlock
                          payload={widget}
                          dark={widgetDark}
                          onPrompt={(text) => send(text)}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="chat-composer" data-testid="live-chat-composer">
        {/* 离线态：把话说在输入框边上，而不是让人发出去之后才看到一条错误气泡 */}
        {!online && (
          <div className="live-chat__note" role="status" data-testid="live-chat-offline">
            <Sym name="warning" />
            <span>主机不在线，提问会失败。主机重新打开「实时链路」后会自动恢复。</span>
          </div>
        )}
        <div className="chat-composer__row">
          <textarea
            className="chat-input"
            data-testid="live-chat-input"
            rows={2}
            placeholder={online ? '输入问题，回车发送' : '主机不在线，暂时不能提问'}
            disabled={!online}
            value={input}
            aria-label="输入问题"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              if (e.nativeEvent.isComposing) return; // 中文输入法选词的回车不是提交意图
              e.preventDefault();
              send(input);
            }}
          />
          {/* 生成中：发送键**变成**停止键（与 ChatPanel 同一形状）。停止走 chat.stop op，
              主机侧 abort 那一轮，已流出的内容保留。 */}
          {streaming ? (
              <Button isIconOnly
                className="chat-send"
                data-testid="live-chat-stop"
                aria-label="停止生成"
                variant="secondary"
                onClick={() => guest.stopTurn(streaming.turnId)}
              >
                <Sym name="stop" />
              </Button>
          ) : (
              <Button isIconOnly
                className="chat-send"
                data-testid="live-chat-send"
                aria-label="发送"
                variant="primary"
                isDisabled={!online}
                onClick={() => send(input)}
              >
                <Sym name="send" />
              </Button>
          )}
        </div>
      </div>
    </div>
  );
}
