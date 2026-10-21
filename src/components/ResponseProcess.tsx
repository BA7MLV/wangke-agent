import { useState } from 'react';
import { Disclosure } from '@heroui/react';
import { Sym } from '../ui';
import type { ChatToolCall } from '../store/db';
import { processSteps, processTitle, type ProcessPhase } from '../utils/responseProcess';
import { toolDisplay } from '../utils/toolTrace';
import './response-process.css';

const NO_CALLS: ChatToolCall[] = [];

/** 一个回答只有一个过程入口。开合是用户选择，不因 token、工具切换或完成而重置。 */
export default function ResponseProcess({
  reasoning = '', calls = NO_CALLS, streaming = false, phase, hint, waiting = false,
}: {
  reasoning?: string;
  calls?: ChatToolCall[];
  streaming?: boolean;
  phase?: ProcessPhase;
  hint?: string;
  waiting?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = processTitle({ streaming, phase, calls, hint, waiting });
  const failures = calls.filter((call) => call.status === 'error');
  const steps = processSteps(reasoning, calls);
  const hasSteps = steps.length > 0;
  const legacy = reasoning && calls.some((call) => call.reasoningOffset == null);
  // 正文已在流出且没有过程记录时，不额外占一行重复的生成提示。
  if (!hasSteps && (!streaming || phase === 'answering') && !waiting) return null;

  return (
    <div className="response-process" data-testid="response-process" data-streaming={streaming || undefined}>
      {hasSteps && streaming && <span className="sr-only" role="status">{title}</span>}
      {hasSteps ? (
        <Disclosure isExpanded={expanded} onExpandedChange={setExpanded}>
          <Disclosure.Heading>
            <Disclosure.Trigger className="response-process__toggle" data-testid="response-process-toggle">
              <Sym name={waiting ? 'help' : streaming ? 'more_horiz' : 'toc'} aria-hidden="true" />
              <span className="response-process__title" title={title}>{title}</span>
              <span className="response-process__count">{calls.length ? `${calls.length} 次调用` : '分析记录'}</span>
              {failures.length > 0 && <span className="response-process__error-count">{failures.length} 次失败</span>}
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body>
              {legacy && <p className="response-process__note">早期记录未保存分析与工具的交错顺序</p>}
              <ol className="response-process__steps" aria-label="处理步骤">
                {steps.map((step, index) => {
                  if (step.kind === 'reasoning') {
                    const live = streaming && phase === 'thinking' && index === steps.length - 1;
                    return (
                      <li key={step.key} className="response-process__step">
                        <Sym name="lightbulb" aria-hidden="true" />
                        <Disclosure className="response-process__analysis">
                          <Disclosure.Heading>
                            <Disclosure.Trigger className="response-process__analysis-toggle">
                              <span>{live ? '正在分析' : '分析记录'}</span>
                              <Disclosure.Indicator />
                            </Disclosure.Trigger>
                          </Disclosure.Heading>
                          <Disclosure.Content>
                            <Disclosure.Body>
                              <div className="response-process__reasoning" tabIndex={0} role="region" aria-label="分析记录">
                                {step.text}
                              </div>
                            </Disclosure.Body>
                          </Disclosure.Content>
                        </Disclosure>
                      </li>
                    );
                  }
                  const { call } = step;
                  const { label, detail } = toolDisplay(call.name, call.detail);
                  const pending = call.status === 'running';
                  const needsUser = pending && (call.name === 'ask_user' || call.name === 'propose_folder_plan');
                  const status = pending
                    ? needsUser && waiting ? '等待确认' : streaming && phase === 'tool' ? '进行中' : '未完成'
                    : call.status === 'error' ? '失败' : '完成';
                  return (
                    <li key={step.key} className="response-process__step" data-status={call.status} data-testid="tool-trace-item">
                      <Sym name={call.status === 'error' ? 'error' : pending ? needsUser ? 'help' : 'more_horiz' : 'check'} aria-hidden="true" />
                      <div className="response-process__tool">
                        <div className="response-process__tool-heading">
                          <span className="response-process__label">{label}</span>
                          <span className="response-process__state">{status}</span>
                          {call.ms != null && <span className="response-process__duration">{call.ms < 1000 ? `${call.ms} ms` : `${(call.ms / 1000).toFixed(1)} s`}</span>}
                        </div>
                        {detail && <p className="response-process__detail">{detail}</p>}
                        {call.result && <p className="response-process__result">{call.result}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      ) : (
        <div className="response-process__pending" role="status">
          <Sym name={waiting ? 'help' : 'more_horiz'} aria-hidden="true" />
          <span>{title}</span>
        </div>
      )}
      {/* 即使过程收起，错误原因仍在动作附近可见；不把工具失败误称为整个回答失败。 */}
      {failures.length > 0 && !expanded && (
        <p className="response-process__failure" role="status">
          <Sym name="error" aria-hidden="true" />
          <span>{failures[failures.length - 1].result || '工具调用失败，可展开处理过程查看。'}</span>
        </p>
      )}
    </div>
  );
}
