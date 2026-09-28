import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, type FolderPlanState, type VideoRow } from '../store/db';
import './ask-cards.css';

/** 分类里最多列出的课程名：再多的用「还有 X 门」收起来，卡片不会变成一堵墙 */
const MAX_LISTED = 8;

interface Props {
  plan: FolderPlanState;
  /** 本轮 agent 循环是否还活着（决定「确认执行」可不可点） */
  active: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 目录整理方案卡：**先看后改**的唯一入口。
 *
 * 为什么要做成卡片而不是让助手直接改库：整理目录是一次「动很多门课」的操作，而助手对
 * 分类的判断只是它的判断。用户点一下「确认执行」之前，库里一个字节都不变。
 *
 * 课程名从 `videos` 现查（方案里只有 id）：模型给的 id 可能指向已删除的课程，也可能
 * 根本不存在 —— 显示不出来的行会以「1 门无法识别」计入数量，不静默消失。
 */
export default function FolderPlanCard({ plan, active, busy, onConfirm, onCancel }: Props) {
  const navigate = useNavigate();
  const [names, setNames] = useState<Map<string, VideoRow> | null>(null);
  const ids = plan.folders.flatMap((entry) => entry.courseIds);
  const idKey = ids.join('|');

  useEffect(() => {
    let cancelled = false;
    if (ids.length === 0) {
      setNames(new Map());
      return;
    }
    void db.videos.bulkGet(ids).then((rows) => {
      if (cancelled) return;
      const map = new Map<string, VideoRow>();
      rows.forEach((row) => {
        if (row) map.set(row.id, row);
      });
      setNames(map);
    });
    return () => {
      cancelled = true;
    };
    // idKey 而非 ids 本身：数组每次渲染都是新引用，会让这个 effect 每帧重查
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  const applied = plan.applied;
  const actionable = active && applied === 0 && !busy;
  const total = ids.length;

  return (
    <div className="plan-card" data-testid="plan-card" data-applied={applied}>
      <div className="plan-card__head">
        <mdui-sym-create-new-folder aria-hidden="true" />
        <span>课程库目录整理方案</span>
        <span className="plan-card__count">{plan.folders.length} 个分类 / {total} 门</span>
      </div>
      <p className="plan-card__summary">{plan.summary}</p>

      <div className="plan-card__folders">
        {plan.folders.map((entry) => {
          const known = entry.courseIds.filter((id) => names?.has(id));
          const unknown = entry.courseIds.length - known.length;
          return (
            <section key={entry.name} className="plan-folder">
              <h4 className="plan-folder__name">
                <mdui-sym-folder aria-hidden="true" />
                {entry.name}
                <span className="plan-folder__n">{entry.courseIds.length}</span>
              </h4>
              {entry.courseIds.length === 0 ? (
                <p className="plan-folder__empty">不归入任何课程（不会被创建）</p>
              ) : (
                <ul className="plan-folder__courses">
                  {names === null ? (
                    <li className="plan-folder__loading">正在读取课程名…</li>
                  ) : (
                    <>
                      {known.slice(0, MAX_LISTED).map((id) => {
                        const course = names.get(id)!;
                        return (
                          <li key={id}>
                            <button
                              type="button"
                              className="plan-folder__course"
                              onClick={() => navigate(`/player/${encodeURIComponent(id)}`)}
                              title="打开这门课"
                            >
                              {course.name}
                            </button>
                          </li>
                        );
                      })}
                      {known.length > MAX_LISTED && (
                        <li className="plan-folder__more">…另有 {known.length - MAX_LISTED} 门</li>
                      )}
                      {unknown > 0 && (
                        <li className="plan-folder__unknown" data-testid="plan-folder-unknown">
                          {unknown} 门无法识别（课程库里已不存在，执行时会跳过）
                        </li>
                      )}
                    </>
                  )}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {applied === 0 && (
        <p className="plan-card__gate">
          <mdui-sym-warning aria-hidden="true" />
          确认后才会真正建立文件夹并移动课程；取消则课程库保持原样。
        </p>
      )}
      {applied === 1 && (
        <p className="plan-card__done" data-testid="plan-card-applied">
          <mdui-sym-check aria-hidden="true" />
          已执行。到
          <button type="button" className="plan-card__link" onClick={() => navigate('/')}>
            课程库
          </button>
          就能看到新的分类。
        </p>
      )}
      {applied === 2 && (
        <p className="plan-card__cancel" data-testid="plan-card-cancelled">
          <mdui-sym-undo aria-hidden="true" />
          已放弃，课程库没有改动。
        </p>
      )}

      {applied === 0 && (
        <div className="plan-card__actions">
          <mdui-button variant="text" disabled={!actionable} onClick={onCancel} data-testid="plan-cancel">
            取消
          </mdui-button>
          <mdui-button
            variant="filled"
            disabled={!actionable}
            loading={busy}
            onClick={onConfirm}
            data-testid="plan-confirm"
          >
            <mdui-sym-check slot="icon" />
            确认执行
          </mdui-button>
        </div>
      )}
      {!active && applied === 0 && (
        <p className="plan-card__dead" data-testid="plan-card-expired">
          本次会话已结束，这份方案没法再执行。重新说一次「整理课程库」即可。
        </p>
      )}
    </div>
  );
}
