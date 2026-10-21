import { useEffect, useMemo, useState } from 'react';
import Dexie, { liveQuery } from 'dexie';
import { useNavigate } from 'react-router-dom';
import { db } from '../store/db';
import { useCourseChat } from '../store/courseChat';
import { confirmDialog, promptDialog, Sym, toast } from '../ui';
import type { RecentItem } from '../ui/layout';

// 页面切换会重挂 hook，但最近会话不应因此退回空态。
// 只缓存查询结果；每次挂载仍订阅 liveQuery，删除、后台消息等会继续实时更新。
let cachedActivity: Map<number, number> | null = null;

/** 主页和资料页共用会话筛选、排序、状态与操作；只有主页显示当前会话高亮。 */
export function useRecentChats(showActive = false) {
  const navigate = useNavigate();
  const sessions = useCourseChat((s) => s.sessions);
  const activeId = useCourseChat((s) => s.activeId);
  const runningIds = useCourseChat((s) => s.runningIds);
  const awaitingIds = useCourseChat((s) => s.awaitingIds);
  const ready = useCourseChat((s) => s.ready);
  const [activity, setActivity] = useState(() => cachedActivity);

  useEffect(() => {
    if (!ready) return;
    // 仅展示发送过消息的会话，后台回答和跨标签页更新也刷新排序。
    const subscription = liveQuery(async () => new Map(await Promise.all(
      sessions.filter((session) => session.id != null).map(async (session) => {
        const query = () => db.chats.where('[sessionId+createdAt+id]').between(
          [session.id!, Dexie.minKey, Dexie.minKey],
          [session.id!, Dexie.maxKey, Dexie.maxKey],
        ).reverse();
        const [user, latest] = await Promise.all([
          query().filter((message) => message.role === 'user').first(),
          query().first(),
        ]);
        return [session.id!, user ? latest!.createdAt : 0] as const;
      }),
    ))).subscribe({
      next: (next) => {
        cachedActivity = next;
        setActivity(next);
      },
      error: () => toast.error('最近会话加载失败，请刷新重试'),
    });
    return () => subscription.unsubscribe();
  }, [sessions, ready]);

  // 不改变 store 顺序：bootstrap 和删除后的落脚点依赖原有顺序。
  const recentSessions = useMemo(() => {
    if (!activity) return [];
    return sessions
    .filter((session) => activity.has(session.id!) && activity.get(session.id!) !== 0)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)
      || activity.get(b.id!)! - activity.get(a.id!)!
      || b.createdAt - a.createdAt || b.id! - a.id!);
  }, [sessions, activity]);

  const remove = async (id: number, title: string) => {
    const ok = await confirmDialog({
      headline: '删除这条会话？',
      description: `「${title}」会被永久删除，课程和学习数据不会受影响。`,
      confirmText: '删除', cancelText: '取消', danger: true,
    });
    if (ok) await useCourseChat.getState().deleteSessionById(id);
  };
  const rename = async (id: number, title: string) => {
    const next = await promptDialog({
      headline: '重命名会话',
      description: '给这段对话起个名字，方便以后在 Recent 里认出来。',
      defaultValue: title, placeholder: '会话标题', confirmText: '保存',
      validate: (value) => value.length > 60 ? '标题太长了，60 个字以内就行' : null,
    });
    if (next) await useCourseChat.getState().renameSession(id, next);
  };
  const archive = async (id: number, title: string) => {
    const ok = await confirmDialog({
      headline: '归档这条会话？',
      description: `「${title}」会从 Recent 里收起来，之后可以在「设置 → 数据 → 已归档会话」里找回来。`,
      confirmText: '归档', cancelText: '取消',
    });
    if (ok) await useCourseChat.getState().setArchived(id, true);
  };
  const fork = async (id: number) => {
    const newId = await useCourseChat.getState().forkSession(id);
    if (newId == null) toast.warning('这条会话还没有内容，无法分支');
    else {
      toast.success('已分支出新会话');
      if (!showActive) navigate('/');
    }
  };

  const items: RecentItem[] = recentSessions.map((session) => {
    const id = session.id!;
    const busy = runningIds.includes(id);
    const pin = () => void useCourseChat.getState().setPinned(id, !session.pinned);
    return {
      id: String(id), label: session.title,
      active: showActive && id === activeId,
      pendingReply: busy && !awaitingIds.includes(id),
      pinned: !!session.pinned,
      onUnpin: () => void useCourseChat.getState().setPinned(id, false),
      onClick: () => {
        void useCourseChat.getState().loadSession(id);
        if (!showActive) navigate('/');
      },
      testId: `chat-recent-${id}`,
      menu: [
        { key: 'rename', label: '重命名', icon: <Sym name="edit" />, onAction: () => void rename(id, session.title) },
        { key: 'pin', label: session.pinned ? '取消置顶' : '置顶', icon: <Sym name={session.pinned ? 'pin_off' : 'pin'} />, onAction: pin },
        { key: 'fork', label: '分支出新会话', icon: <Sym name="fork" />, isDisabled: busy, onAction: () => void fork(id) },
        { key: 'archive', label: '归档', icon: <Sym name="archive" />, isDisabled: busy, onAction: () => void archive(id, session.title) },
        { key: 'delete', label: '删除', icon: <Sym name="delete" />, danger: true, isDisabled: busy, onAction: () => void remove(id, session.title) },
      ],
      onDelete: () => void remove(id, session.title),
      deleteLabel: `删除会话 ${session.title}`,
      deleteTestId: `chat-recent-delete-${id}`,
      deleteDisabled: busy,
    };
  });
  return { label: '最近', items, loading: !ready || activity === null };
}
