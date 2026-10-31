import { useEffect, useState } from 'react';
import { Disclosure } from '@heroui/react';
import { Sym } from '../ui';
import { MatrixDots } from './motion';
import { IconSwap, Shimmer, TextSwap } from './motion';
import type { ChatToolCall } from '../store/db';
import { toolDisplay } from '../utils/toolTrace';
import './tool-trace.css';
import WebSources from '../web-search/WebSources';

/** 单个工具的耗时：不到一秒报毫秒（「它卡了 800ms」看得见），过了就报秒 */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 会话里的工具链：agent 这一轮调了哪些工具、每次拿到了什么。
 *
 * ## 为什么要有这一块
 *
 * 在此之前，一次工具调用在界面上只表现为**一行会消失的状态字**（「正在检索：傅里叶」）——
 * 它被下一个 delta 清掉，且从不落库。于是用户回看历史时会问「它到底查没查我的课程」，
 * 而答案是「查过，但证据已经没了」。工具链把这件事变成可回看的过程记录：
 * 每一次调用一行，含动作、对象、耗时、结果摘要。
 *
 * ## 与思考链同一套「过程不该占着答案的位置」
 *
 * 跑的时候展开（那时候它就是屏幕上唯一在动的东西，用户要看着它知道模型没卡住），
 * 跑完自动收起（收起来之后答案才是主角）。用户可以自己点开逐条看。
 * 收起态保留计数与成功加载的技能，方便回看这次回答采用了哪些技能。
 *
 * ## 每行只放一个参数
 *
 * `detail` 由 `utils/toolTrace.ts` 从参数里挑一个最有信息量的（检索词 / 技能名 / 起始时间）。
 * 工具链是**清单**不是日志：一行放得下的东西才看得进去，要看全部参数请去看工具本身。
 *
 * ## 时序（这一块在动效上刻意做成「有先后」的）
 *
 * 读取工具可以并行；每一行按调用身份独立更新状态与耗时：
 *
 * - **标题**在真的有工具在跑（`status === 'running'`）时用 shimmer 高光扫过 ——
 *   与思考链的状态行同一套语言（`.t-shimmer`），一眼看出「现在这一步在做什么」。
 *   判据是**行**的状态而不是 `running`（整轮是否还在流）：一轮里工具跑完、正文还在写
 *   的那一段，标题该是「已调用 N 个工具」的平静口吻，不该继续闪。
 * - **每一行**按序号错开入场（`--tool-i`），流式时新起的那条从下方浮起、去模糊，
 *   顺序读起来就是「先检索、再读取、最后出题」。
 * - **状态格**用 `IconSwap` 做转圈 → 勾/叹号 的交叉淡出淡入，完成那一刻有个交代。
 * - **耗时与结果摘要**在拿到的那一刻各自淡入 —— 它们不是行的一部分，是行的**产出**。
 */
export default function ToolTrace({
  calls,
  running,
}: {
  calls: ChatToolCall[];
  /** 这条回答还在流式中（用它决定「跑的时候展开、跑完收起」） */
  running: boolean;
}) {
  const [open, setOpen] = useState(running);

  // 与思考链同一条规则：状态翻转那一下才动，之后尊重用户自己的开合
  useEffect(() => {
    setOpen(running);
  }, [running]);

  // 有内容才占位置：没调过工具的回答不该凭空多出一行「已调用 0 个工具」
  if (calls.length === 0) return null;

  const activeCalls = calls.filter((c) => c.status === 'running');
  const acting = activeCalls[0];
  const waitingForUser = acting?.name === 'ask_user';
  const failed = calls.filter((c) => c.status === 'error').length;
  const displays = calls.map((call) => toolDisplay(call.name, call.detail));
  const loadedSkills = [...new Set(displays.flatMap((display, i) =>
    calls[i].status === 'done' && display.label === '加载技能' && display.detail ? [display.detail] : []))];
  const activeDisplay = acting ? toolDisplay(acting.name, acting.detail) : undefined;
  const title = waitingForUser ? '等待你的回答' : activeCalls.length > 1 ? `正在并行调用 ${activeCalls.length} 个工具…` : activeDisplay
    ? `${activeDisplay.label}${activeDisplay.detail ? `：${activeDisplay.detail}` : '…'}`
    : `已调用 ${calls.length} 个工具${failed > 0 ? ` · ${failed} 次失败` : ''}${loadedSkills.length ? ` · 已加载技能：${loadedSkills.slice(0, 2).join('、')}${loadedSkills.length > 2 ? ` 等 ${loadedSkills.length} 个` : ''}` : ''}`;

  return (
    <Disclosure
      className="tool-trace"
      data-running={running ? 'true' : undefined}
      isExpanded={open}
      onExpandedChange={setOpen}
      data-testid="tool-trace"
    >
      <Disclosure.Heading>
        <Disclosure.Trigger className="tool-trace__toggle" data-testid="tool-trace-toggle">
          {/* 跑动中那颗扳手是主色，跑完转灰 —— 一眼分得出「还在查」和「查完了」 */}
          <Sym name="build" className="tool-trace__icon" />
          {/* 真的在跑才闪：跑完那一句是平静的计数，闪光只属于「正在进行」 */}
          {acting && !waitingForUser ? (
            <Shimmer className="tool-trace__title" text={title} />
          ) : (
            <TextSwap className="tool-trace__title" text={title} />
          )}
          <Disclosure.Indicator className="tool-trace__caret" />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="tool-trace__body">
          <ol className="tool-trace__list">
            {calls.map((call, i) => (
              // 同一次工具在一轮里可能被调多次（换个关键词重查），所以键不能只用 name
              <li
                key={call.id ?? `${call.name}-${i}`}
                className="tool-trace__item"
                data-status={call.status}
                data-testid="tool-trace-item"
                // 入场延迟按序号递进；封顶 4 步（最多 160ms），免得第 12 条工具等半秒才出现
                style={{ ['--tool-i' as string]: Math.min(i, 4) }}
              >
                <span className="tool-trace__state" aria-hidden="true">
                  <IconSwap
                    a={call.name === 'ask_user' ? <Sym name="help" /> : <MatrixDots />}
                    b={<Sym name={call.status === 'error' ? 'error' : 'check'} />}
                    active={call.status === 'running' ? 'a' : 'b'}
                  />
                </span>
                <span className="tool-trace__action">
                  <span className="tool-trace__label">{displays[i].label}</span>
                  {displays[i].detail && <span className="tool-trace__detail">{displays[i].detail}</span>}
                </span>
                {call.ms != null && <span className="tool-trace__ms">{fmtMs(call.ms)}</span>}
                {call.result && <span className="tool-trace__result">{call.result}</span>}
                {call.webSearch ? <div className="tool-trace__sources"><WebSources result={call.webSearch} /></div> : null}
              </li>
            ))}
          </ol>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
