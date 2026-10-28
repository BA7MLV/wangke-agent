import { Fragment, type ReactNode } from 'react';
import type { CourseChatMessage } from '../store/courseChat';
import type { ResponseSegment } from '../utils/responseOrder';
import ResponseProcess from './ResponseProcess';

const LEGACY_SEGMENTS: ResponseSegment[] = [{ contentOffset: 0, reasoningOffset: 0, toolOffset: 0 }];

/** The same ordered transcript is used during streaming, continuation and history replay. */
export default function ResponseTimeline({ message, content, children }: {
  message: CourseChatMessage;
  content: string;
  children: (content: string, streaming: boolean) => ReactNode;
}) {
  const segments = message.responseSegments?.length ? message.responseSegments : LEGACY_SEGMENTS;
  const reasoning = message.reasoning ?? '';
  const calls = message.tools ?? [];
  const waiting = !!message.ask && !message.ask.picked || !!message.folderPlan && message.folderPlan.applied === 0;
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    const last = !next;
    const text = content.slice(segment.contentOffset, next?.contentOffset);
    const tools = calls.slice(segment.toolOffset, next?.toolOffset).map((call) => ({ ...call,
      reasoningOffset: call.reasoningOffset == null ? undefined : Math.max(0, call.reasoningOffset - segment.reasoningOffset),
    }));
    return <Fragment key={index}>
      <ResponseProcess reasoning={reasoning.slice(segment.reasoningOffset, next?.reasoningOffset)} calls={tools}
        streaming={last && !!message.streaming && (!message.responseSegments?.length || !text.trim() || message.processPhase === 'tool')}
        phase={message.processPhase} hint={last ? message.hint : undefined} waiting={last && waiting}
        since={segment.startedAt ?? message.processStartedAt ?? message.reasoningStartedAt}
        elapsedMs={segments.length === 1 ? message.reasoningMs : undefined} />
      {text && <><div aria-hidden="true" data-chat-answer-start="" />
        {children(text, last && !!message.streaming && (!message.processPhase || message.processPhase === 'answering'))}</>}
    </Fragment>;
  });
}
