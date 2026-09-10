import { useCallback, useEffect, useRef, useState } from 'react';
import { SectionCard, Field, toast, confirmDialog, useMduiEvent } from '../ui';
import { db, type SkillRow } from '../store/db';
import { ensureBuiltinSkills, importSkillFile } from '../skills/store';
import { BUILTIN_SKILLS } from '../skills/builtin';

interface Draft {
  id?: number; // 编辑已有 skill 时携带
  builtin: boolean;
  name: string;
  description: string;
  body: string;
}

/** 设置页「写作技能」卡片：管理可注入讲义生成与问答的 skill（SKILL.md 单文件或含 references/ 的 zip 包） */
export default function SkillsCard() {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [refCounts, setRefCounts] = useState<Record<number, number>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // dialog 自己处理 Esc / 点遮罩关闭时只把 open 拿掉，React 不知道，必须同步回 state
  const dlgRef = useMduiEvent('mdui-dialog', 'closed', () => setDraft(null));

  const reload = useCallback(async () => {
    await ensureBuiltinSkills();
    setSkills(await db.skills.orderBy('id').toArray());
    const refs = await db.skillRefs.toArray();
    const counts: Record<number, number> = {};
    for (const r of refs) counts[r.skillId] = (counts[r.skillId] ?? 0) + 1;
    setRefCounts(counts);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (skill: SkillRow, enabled: boolean) => {
    await db.skills.update(skill.id!, { enabled: enabled ? 1 : 0 });
    void reload();
  };

  const importFiles = async (files: File[]) => {
    let ok = 0;
    for (const f of files) {
      try {
        const { name, refCount } = await importSkillFile(f);
        toast.success(`已导入「${name}」${refCount > 0 ? `（含 ${refCount} 篇参考文档）` : ''}`);
        ok++;
      } catch (e) {
        toast.error(`导入 ${f.name} 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (ok > 0) void reload();
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许重复选同一文件
    if (files.length) void importFiles(files);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const body = draft.body.trim();
    if (!name || !body) {
      toast.warning('名称和正文不能为空');
      return;
    }
    const row = { name, description: draft.description.trim(), body, updatedAt: Date.now() };
    if (draft.id != null && !draft.builtin) {
      await db.skills.update(draft.id, row);
    } else {
      // 新建，或编辑内置 skill → 存为副本（内置原版保留可重置）
      await db.skills.add({ ...row, enabled: 1, builtin: 0 });
    }
    setDraft(null);
    toast.success('已保存');
    void reload();
  };

  const removeSkill = async (skill: SkillRow) => {
    await db.transaction('rw', [db.skills, db.skillRefs], async () => {
      await db.skillRefs.where('skillId').equals(skill.id!).delete();
      await db.skills.delete(skill.id!);
    });
    void reload();
  };

  const resetBuiltin = async (skill: SkillRow) => {
    const src = BUILTIN_SKILLS.find((s) => s.name === skill.name);
    if (!src) return;
    await db.skills.update(skill.id!, {
      description: src.description,
      body: src.body,
      updatedAt: Date.now(),
    });
    toast.success('已重置为内置版本');
    void reload();
  };

  return (
    <SectionCard
      title="写作技能"
      testId="card-skills"
      actions={
        <>
          <mdui-button
            variant="tonal"
            data-testid="btn-skill-import"
            onClick={() => fileRef.current?.click()}
          >
            <mdui-sym-upload slot="icon" />
            导入
          </mdui-button>
          <mdui-button
            variant="filled"
            data-testid="btn-skill-new"
            onClick={() => setDraft({ builtin: false, name: '', description: '', body: '' })}
          >
            <mdui-sym-add slot="icon" />
            新建
          </mdui-button>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.zip"
            multiple
            hidden
            onChange={onPickFiles}
          />
        </>
      }
    >
      <div className="text-secondary" style={{ marginBottom: 12 }}>
        启用的技能按相关性自动注入讲义生成与课程问答。支持 SKILL.md 单文件（.md）或含 references/
        参考文档的 zip 包；技能正文会注入提示词，请只导入可信来源。
      </div>

      {skills.length === 0 ? (
        <div data-testid="skill-empty">暂无技能</div>
      ) : (
        <div className="skill-list">
          {skills.map((skill) => (
            <SkillItem
              key={skill.id}
              skill={skill}
              refCount={refCounts[skill.id!] ?? 0}
              onToggle={(enabled) => void toggle(skill, enabled)}
              onEdit={() =>
                setDraft({
                  id: skill.id,
                  builtin: !!skill.builtin,
                  name: skill.name,
                  description: skill.description,
                  body: skill.body,
                })
              }
              onReset={async () => {
                if (await confirmDialog({ headline: '重置为内置版本？', confirmText: '重置' })) {
                  void resetBuiltin(skill);
                }
              }}
              onDelete={async () => {
                if (
                  await confirmDialog({
                    headline: `删除技能「${skill.name}」？`,
                    confirmText: '删除',
                  })
                ) {
                  void removeSkill(skill);
                }
              }}
            />
          ))}
        </div>
      )}

      <mdui-dialog
        ref={dlgRef}
        open={draft != null}
        headline={
          draft?.id == null
            ? '新建技能'
            : draft.builtin
            ? `查看「${draft.name}」`
            : `编辑「${draft.name}」`
        }
        data-testid="skill-dialog"
        /* mdui 的 dialog 默认**不**响应 Esc 与点遮罩（两个属性默认 false），而 antd 的 Modal 默认都响应 ——
           显式打开以保持迁移前后的行为一致，也让上面的 closed 同步真正生效。 */
        close-on-esc
        close-on-overlay-click
      >
        {draft && (
          <>
            {draft.builtin && (
              <div className="text-secondary">
                内置技能不可直接修改，保存时将创建副本，原版可随时重置恢复。
              </div>
            )}
            <Field label="名称">
              <mdui-text-field
                value={draft.name}
                data-testid="skill-name"
                onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              />
            </Field>
            <Field label="描述">
              <mdui-text-field
                value={draft.description}
                placeholder="一句话说明这个技能的用途"
                data-testid="skill-desc"
                onInput={(e) => setDraft({ ...draft, description: e.currentTarget.value })}
              />
            </Field>
            <Field label="正文（Markdown，将作为写作规范注入讲义生成）">
              <mdui-text-field
                rows={14}
                value={draft.body}
                style={{ fontFamily: 'monospace' }}
                data-testid="skill-body"
                onInput={(e) => setDraft({ ...draft, body: e.currentTarget.value })}
              />
            </Field>
          </>
        )}
        <mdui-button slot="action" variant="text" data-testid="skill-cancel" onClick={() => setDraft(null)}>
          取消
        </mdui-button>
        <mdui-button
          slot="action"
          variant="filled"
          data-testid="skill-save"
          onClick={() => void saveDraft()}
        >
          {draft?.builtin ? '存为副本' : '保存'}
        </mdui-button>
      </mdui-dialog>
    </SectionCard>
  );
}

/**
 * 单个技能行。
 *
 * 为什么不用 `mdui-list-item`：它的 `custom` 插槽是**覆盖式**的 —— 源码里
 * `<slot name="custom">…预设内容…</slot>`，只要放一个 `slot="custom"` 的子元素，
 * 标题 / 描述 / end-icon 三个插槽的内容就全部不再渲染（实测踩到：整行只剩两个按钮）。
 * 而这一行需要「标题 + 描述 + 开关 + 两个操作按钮」四组内容，预设布局塞不下
 * （end-icon 只有一个槽位，且 headline 默认单行截断会切掉按钮），
 * 所以直接把这一行用 div + 设计令牌搭出来，行为与视觉都完全可控。
 *
 * 开关走 mdui-switch 的 `change`（自定义事件，用 useMduiEvent 拿 el.checked）。
 */
function SkillItem({
  skill,
  refCount,
  onToggle,
  onEdit,
  onReset,
  onDelete,
}: {
  skill: SkillRow;
  refCount: number;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const swRef = useMduiEvent('mdui-switch', 'change', (_e, el) => onToggle(el.checked));
  return (
    <div className="skill-row" data-testid="skill-row" data-skill-id={skill.id}>
      <div className="skill-row__main">
        <div className="skill-row__name">
          <span className="skill-row__title">{skill.name}</span>
          {!!skill.builtin && <span className="tag-mini">内置</span>}
          {refCount > 0 && <span className="tag-mini">{refCount} 篇参考文档</span>}
        </div>
        <div className="skill-row__desc text-secondary">{skill.description || '（无描述）'}</div>
      </div>
      <mdui-switch ref={swRef} checked={!!skill.enabled} data-testid="skill-toggle" />
      <mdui-button variant="text" data-testid="skill-edit" onClick={onEdit}>
        <mdui-sym-edit slot="icon" />
        {skill.builtin ? '查看' : '编辑'}
      </mdui-button>
      {skill.builtin ? (
        <mdui-button-icon data-testid="skill-reset" aria-label="重置为内置版本" onClick={onReset}>
          <mdui-sym-refresh />
        </mdui-button-icon>
      ) : (
        <mdui-button-icon data-testid="skill-delete" aria-label="删除技能" onClick={onDelete}>
          <mdui-sym-delete />
        </mdui-button-icon>
      )}
    </div>
  );
}
