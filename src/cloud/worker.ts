import { cloud, cloudRequest, withToolPermission } from './state';
import { flushCloud } from './sync';
import type { CloudTask } from '../../packages/contracts/src/cloud';
import { useCourseChat } from '../store/courseChat';
import { useJobStore } from '../store/jobs';
import { targetOfSlot, getSettings, useSettings } from '../store/settings';

declare global { interface Window { __runCloudTask: (task: CloudTask) => Promise<unknown> } }
window.__runCloudTask = async (task) => {
  cloud.taskId = task.id;
  const input = task.input as any;
  if (input.modelRef && getSettings().providers.some(p => p.id === input.modelRef.providerId) && typeof input.modelRef.model === 'string') {
    useSettings.setState({ llmModel: input.modelRef });
  }
  // Task payloads never supply network destinations or credentials.
  if (task.kind === 'qa') delete input.modelTarget;
  let progress: Record<string, unknown> = {};
  let reporting: Promise<void> | undefined;
  const report = () => {
    if (reporting) return reporting;
    reporting = cloudRequest<void>(`/tasks/${task.id}/report`, { method: 'POST', body: JSON.stringify({ progress }) }).finally(() => { reporting = undefined; });
    return reporting;
  };
  const onProgress = (value: any) => { progress = value; };
  let commandBusy = false;
  const timer = setInterval(() => { void report().catch(() => {}); }, 500);
  const commands = setInterval(async () => {
    if (commandBusy || task.kind !== 'chat') return;
    commandBusy = true;
    try {
      const result = await cloudRequest<{ commands: Array<{ action: string; value: any }> }>(`/tasks/${task.id}/commands/claim`, { method: 'POST' });
      for (const cmd of result.commands) {
        const store = useCourseChat.getState();
        if (cmd.action === 'answerAsk') await store.answerAsk(cmd.value);
        if (cmd.action === 'confirmPlan') await store.confirmPlan();
        if (cmd.action === 'cancelPlan') await store.cancelPlan();
      }
    } catch (error) { progress = { ...progress, commandError: (error as Error).message }; }
    finally { commandBusy = false; }
  }, 500);
  const unsubscribe = useCourseChat.subscribe(s => {
    if (task.kind === 'chat') progress = { view: { messages: s.messages, loading: s.loading, pendingAsk: s.pendingAsk, pendingPlan: s.pendingPlan, queued: s.queued } };
  });
  const unsubscribeJobs = useJobStore.subscribe(s => { if (s.jobs[input.videoId]) progress = { ...s.jobs[input.videoId] }; });
  try {
    let result: unknown;
    if (task.kind === 'chat' || task.kind === 'qa') {
      await withToolPermission('read', { tool: 'prepare_task_context', kind: task.kind, resource: task.resource }, async () => {});
    }
    switch (task.kind) {
      case 'chat':
        await useCourseChat.getState().bootstrap();
        await useCourseChat.getState().loadSession(input.sessionId);
        if (input.action === 'continue') await useCourseChat.getState().retryMessage(input.messageKey);
        else await useCourseChat.getState().send(input.text, input.mode, input.sessionId, input.resume, input.attachments ?? []);
        result = null; break;
      case 'qa': result = await (await import('../harness/qaRunner')).runQa(input, {
        onDelta: text => onProgress({ ...progress, content: String(progress.content ?? '') + text }),
        onReasoning: text => onProgress({ ...progress, reasoning: String(progress.reasoning ?? '') + text }),
        onRoundStart: () => onProgress({ ...progress, content: '' }),
      }); break;
      case 'transcribe': result = await (await import('../pipelines/transcribe')).runTranscription(input.videoId, onProgress); break;
      case 'handout': result = await (await import('../pipelines/handout')).runHandout(input.videoId, onProgress); break;
      case 'cards': result = await (await import('../pipelines/cards')).runCards(input.videoId, onProgress); break;
      case 'comments': result = await (await import('../pipelines/comments')).runComments(input.videoId, onProgress); break;
      case 'danmaku': result = await (await import('../pipelines/danmaku')).runDanmaku(input.videoId, onProgress); break;
      case 'material': result = await (await import('../pipelines/materialJob')).startMaterialJob(input.videoId, input.format); break;
      case 'cover': result = await (await import('../pipelines/cover')).ensureCover(input.videoId, input.options); break;
      case 'artifactEdit': result = await (await import('../pipelines/artifactEdit')).editArtifact({ ...input, signal: new AbortController().signal }); break;
      case 'handoutEdit': result = await (await import('../pipelines/handoutEdit')).rewriteBlockWithLLM(input.original, input.instruction, input.ctx); break;
      case 'modelOnce': {
        const target = targetOfSlot(getSettings(), 'chat');
        const provider = getSettings().providers.find(p => p.id === input.providerId);
        if (!provider) throw new Error('模型服务不存在');
        result = await (await import('../api/siliconflow')).chatOnce({ ...target, ...provider, model: input.model }, input.options); break;
      }
      default: throw new Error('未知任务');
    }
    await flushCloud();
    if (reporting) await reporting;
    await report();
    return result ?? null;
  } finally {
    clearInterval(timer); clearInterval(commands); unsubscribe(); unsubscribeJobs();
  }
};
