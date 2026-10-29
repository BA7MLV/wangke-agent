import { useEffect } from 'react';
import { Button, EmptyState } from '@heroui/react';
import { SectionCard, Sym, confirmDialog, toast } from '../../ui';
import { useCourseChat } from '../../store/courseChat';

/**
 * 设置 → 数据 →「已归档会话」卡片。
 *
 * **这张卡是「归档」这个动作能成立的前提**，不是附加功能：侧栏 Recent 的归档把那条会话
 * 从列表里收走了，用户若没有别的地方能找回它，归档就等于软删除 —— 用户以为
 * 「收起来了」其实再也看不到。见 docs/plans/2026-10-15-recent-会话操作菜单-design.md §4。
 *
 * 每条给两个出口：**恢复**（回到 Recent）与**删除**（真删，不可逆）。
 */
export default function ArchivedSessionsCard() {
  const sessions = useCourseChat((s) => s.archivedSessions);
  const refresh = useCourseChat((s) => s.refreshArchived);
  const setArchived = useCourseChat((s) => s.setArchived);
  const deleteSessionById = useCourseChat((s) => s.deleteSessionById);

  // 设置是「偶尔进」的界面，每次挂载重读一遍即可，不做订阅
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRestore = async (id: number) => {
    await setArchived(id, false);
    toast.success('已恢复到 Recent');
  };

  const onDelete = async (id: number, title: string) => {
    const ok = await confirmDialog({
      headline: '彻底删除这条会话？',
      description: `「${title}」会被永久删除，这次没法再找回来了。`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (ok) {
      await deleteSessionById(id);
      // `deleteSessionById` 改的是 Recent 那一侧的数组，这里自己这份要重新读
      await refresh();
    }
  };

  return (
    <SectionCard
      title="已归档会话"
      testId="card-archived-sessions"
    >
      {sessions.length === 0 ? (
        <EmptyState data-testid="archived-empty">还没有归档任何会话</EmptyState>
      ) : (
        <div className="flex flex-col">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center gap-3 border-b border-border py-3 last:border-b-0"
              data-testid={`archived-${session.id}`}
            >
              <span className="grid size-4 shrink-0 place-items-center text-muted" aria-hidden="true">
                <Sym name="archive" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="tertiary"
                  size="sm"
                  data-testid={`archived-restore-${session.id}`}
                  onPress={() => void onRestore(session.id!)}
                >
                  <Sym name="archive_restore" />
                  恢复
                </Button>
                <Button
                  variant="tertiary"
                  size="sm"
                  className="text-danger"
                  data-testid={`archived-delete-${session.id}`}
                  onPress={() => void onDelete(session.id!, session.title)}
                >
                  <Sym name="delete" />
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
