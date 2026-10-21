import { Sym } from '../ui/icons';
import type { ChatToolCall } from '../store/db';
import { processSteps, processTitle, type ProcessPhase } from '../utils/responseProcess';
import { toolDisplay } from '../utils/toolTrace';
import ReasoningChain from './ReasoningChain';
import { PendingReply } from './motion';
import './response-process.css';

const NO_CALLS: ChatToolCall[] = [];

/** 原来的思考链就是外壳；工具只是正文中穿插的轻量操作，不增加第二层折叠。 */
export default function ResponseProcess({
  reasoning = '', calls = NO_CALLS, streaming = false, phase, hint, waiting = false, since, elapsedMs,
}: {
  reasoning?: string;
  calls?: ChatToolCall[];
  streaming?: boolean;
  phase?: ProcessPhase;
  hint?: string;
  waiting?: boolean;
  since?: number;
  elapsedMs?: number;
}) {
  const title = processTitle({ streaming, phase, calls, hint, waiting });
  const failures = calls.filter((call) => call.status === 'error');
  const steps = processSteps(reasoning, calls);
  if (!steps.length) {
    return (streaming && phase !== 'answering') || waiting ? <PendingReply label={title} /> : null;
  }

  return (
    <ReasoningChain reasoning={reasoning} active={streaming} title={title}
      idleTitle={reasoning ? '思考过程' : '执行过程'} since={since}
      elapsedMs={calls.length ? undefined : elapsedMs} waiting={waiting} revision={calls}
      failure={failures.length ? failures[failures.length - 1].result || '工具调用失败，可展开查看。' : undefined}
      summary={<>
        {calls.length > 0 && <span className="reasoning-chain__summary">· {calls.length} 次工具调用</span>}
        {failures.length > 0 && <span className="reasoning-chain__errors">· {failures.length} 次失败</span>}
      </>}
    >
      {reasoning && calls.some((call) => call.reasoningOffset == null) && (
        <p className="response-process__note">早期记录未保存分析与工具的交错顺序</p>
      )}
      {steps.map((step) => {
        if (step.kind === 'reasoning') return <div key={step.key} className="response-process__text">{step.text}</div>;
        const { call } = step;
        const { label, detail } = toolDisplay(call.name, call.detail);
        const pending = call.status === 'running';
        const needsUser = pending && (call.name === 'ask_user' || call.name === 'propose_folder_plan');
        const status = pending
          ? needsUser && waiting ? call.name === 'ask_user' ? '等待回答' : '等待确认'
            : streaming && (!phase || phase === 'tool') ? '进行中' : '未完成'
          : call.status === 'error' ? '失败' : '完成';
        return (
          <div key={step.key} className="response-process__tool" data-status={call.status} data-testid="tool-trace-item">
            <span className="response-process__tool-icon" aria-hidden="true">
              <Sym name={call.status === 'error' ? 'error' : pending ? needsUser ? 'help' : 'more_horiz' : 'check'} />
            </span>
            <span className="response-process__action" title={detail}>
              {label}{detail ? ` · ${detail}` : ''}
            </span>
            {!pending && <span className="sr-only">{status}</span>}
            {pending && <span className="response-process__state">{status}</span>}
            {call.ms != null && <span className="response-process__duration">{call.ms < 1000 ? `${call.ms} ms` : `${(call.ms / 1000).toFixed(1)} s`}</span>}
            {call.result && <span className="response-process__result">{call.result}</span>}
          </div>
        );
      })}
    </ReasoningChain>
  );
}
