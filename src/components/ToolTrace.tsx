import { useEffect, useState } from 'react';
import { Disclosure, Spinner } from '@heroui/react';
import { Sym } from '../ui';
import type { ChatToolCall } from '../store/db';
import { toolLabel } from '../utils/toolTrace';
import './tool-trace.css';

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
 * 收起态只留一个计数，**不留最后一个工具名** —— 计数是稳定的，工具名会随新调用跳动。
 *
 * ## 每行只放一个参数
 *
 * `detail` 由 `utils/toolTrace.ts` 从参数里挑一个最有信息量的（检索词 / 技能名 / 起始时间）。
 * 工具链是**清单**不是日志：一行放得下的东西才看得进去，要看全部参数请去看工具本身。
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

  const acting = calls.find((c) => c.status === 'running');
  const failed = calls.filter((c) => c.status === 'error').length;
  const title = acting
    ? `${toolLabel(acting.name)}…`
    : `已调用 ${calls.length} 个工具${failed > 0 ? ` · ${failed} 次失败` : ''}`;

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
          <span className="tool-trace__title">{title}</span>
          <Disclosure.Indicator className="tool-trace__caret" />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="tool-trace__body">
          <ol className="tool-trace__list">
            {calls.map((call, i) => (
              // 同一次工具在一轮里可能被调多次（换个关键词重查），所以键不能只用 name
              <li
                key={`${call.name}-${i}`}
                className="tool-trace__item"
                data-status={call.status}
                data-testid="tool-trace-item"
              >
                <span className="tool-trace__state" aria-hidden="true">
                  {call.status === 'running' ? (
                    <Spinner size="sm" color="current" />
                  ) : (
                    <Sym name={call.status === 'error' ? 'error' : 'check'} />
                  )}
                </span>
                <span className="tool-trace__action">
                  <span className="tool-trace__label">{toolLabel(call.name)}</span>
                  {call.detail && <span className="tool-trace__detail">{call.detail}</span>}
                </span>
                {call.ms != null && <span className="tool-trace__ms">{fmtMs(call.ms)}</span>}
                {call.result && <span className="tool-trace__result">{call.result}</span>}
              </li>
            ))}
          </ol>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
