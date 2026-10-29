import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Chip, EmptyState, Input, Modal, Switch, TextArea, TextField } from '@heroui/react';
import { Field, SectionCard, Sym, confirmDialog, toast, MODAL_CONTAINER_CLASS } from '../ui';
import { db, type SkillRow, type SkillRefRow } from '../store/db';
import { ensureBuiltinSkills, importSkillFile } from '../skills/store';
import { BUILTIN_SKILLS, LEGACY_HANDOUT_SKILLS } from '../skills/builtin';
import { isLegacyHandoutSkill } from '../skills/catalog';

interface Draft {
  mcpRequired?: string[];
  id?: number; // 编辑已有 skill 时携带
  builtin: boolean;
  name: string;
  description: string;
  body: string;
  refs: Pick<SkillRefRow, 'path' | 'body'>[];
}

/** 设置页「写作技能」卡片：管理可注入讲义生成与问答的 skill（SKILL.md 单文件或含 references/ 的 zip 包） */
export default function SkillsCard() {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [showLegacy, setShowLegacy] = useState(false);
  const [refCounts, setRefCounts] = useState<Record<number, number>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const supportFileRef = useRef<HTMLInputElement>(null);
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);

  const editSkill = async (skill: SkillRow) => {
    try {
      const refs = await db.skillRefs.where('skillId').equals(skill.id!).toArray();
      setDraftError('');
      setDraft({ ...skill, builtin: !!skill.builtin, refs });
    } catch {
      toast.error('读取技能失败，请重试');
    }
  };

  const addSupportFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    try {
      const refs = await Promise.all(files.map(async (file) => {
        if (!/\.(md|markdown|txt|csv|json|ya?ml)$/i.test(file.name)) {
          throw new Error(`不支持 ${file.name}，请添加文本文件`);
        }
        return { path: `references/${file.name}`, body: await file.text() };
      }));
      setDraft((current) => {
        if (!current) return current;
        const merged = new Map(current.refs.map((ref) => [ref.path, ref]));
        for (const ref of refs) merged.set(ref.path, ref);
        return { ...current, refs: [...merged.values()] };
      });
      setDraftError('');
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : '添加文件失败，请重试');
    }
  };

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
    if (ok > 0) {
      setShowLegacy(false);
      void reload();
    }
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许重复选同一文件
    if (files.length) void importFiles(files);
  };

  const saveDraft = async () => {
    if (!draft || saving) return;
    const name = draft.name.trim();
    const body = draft.body.trim();
    if (!name || !draft.description.trim() || !body) {
      setDraftError('请填写名称、描述和说明');
      return;
    }
    const row = { name, description: draft.description.trim(), body, mcpRequired: draft.mcpRequired, updatedAt: Date.now() };
    setSaving(true);
    try {
      await db.transaction('rw', [db.skills, db.skillRefs], async () => {
        let skillId: number;
        if (draft.id != null && !draft.builtin) {
          skillId = draft.id;
          await db.skills.update(skillId, row);
          await db.skillRefs.where('skillId').equals(skillId).delete();
        } else {
          // 编辑内置技能时，正文与支持文件一起保存为副本。
          skillId = await db.skills.add({ ...row, enabled: 1, builtin: 0 });
        }
        if (draft.refs.length) {
          await db.skillRefs.bulkAdd(draft.refs.map(({ path, body }) => ({ skillId, path, body })));
        }
      });
      setDraft(null);
      setShowLegacy(false);
      toast.success('已保存');
      void reload();
    } catch {
      setDraftError('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const removeSkill = async (skill: SkillRow) => {
    await db.transaction('rw', [db.skills, db.skillRefs], async () => {
      await db.skillRefs.where('skillId').equals(skill.id!).delete();
      await db.skills.delete(skill.id!);
    });
    void reload();
  };

  const resetBuiltin = async (skill: SkillRow) => {
    const src = [...BUILTIN_SKILLS, ...LEGACY_HANDOUT_SKILLS].find((s) => s.name === skill.name);
    if (!src) return;
    await db.skills.update(skill.id!, {
      description: src.description,
      body: src.body,
      updatedAt: Date.now(),
    });
    toast.success('已重置为内置版本');
    void reload();
  };

  const visibleSkills = skills.filter((skill) => isLegacyHandoutSkill(skill) === showLegacy);

  return (
    <SectionCard
      title="写作技能"
      testId="card-skills"
      actions={
        <>
          <Button variant="secondary" data-testid="btn-skill-import" onPress={() => fileRef.current?.click()}>
            <Sym name="upload" />
            导入
          </Button>
          <Button
            variant="primary"
            data-testid="btn-skill-new"
            onPress={() => {
              setDraftError('');
              setDraft({ builtin: false, name: '', description: '', body: '', refs: [] });
            }}
          >
            <Sym name="add" />
            新建
          </Button>
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
      <div className="mb-3 text-muted">
        课程讲义统一加载写作、数学、编程、行测与申论规范，专题按需读取。支持 SKILL.md 单文件（.md）或含 references/
        参考文档的 zip 包；技能正文会注入提示词，请只导入可信来源。
      </div>
      <Button variant="tertiary" size="sm" className="mb-3" data-testid="skill-catalog-mode" onPress={() => setShowLegacy(!showLegacy)}>
        {showLegacy ? '返回日常技能' : '管理旧版讲义规范'}
      </Button>
      {showLegacy && <div className="mb-3 text-muted">这些规范仅供旧版 IR 讲义流水线使用，保留原有启停设置；日常对话使用「课程讲义」及其参考文档。</div>}

      {visibleSkills.length === 0 ? (
        <EmptyState data-testid="skill-empty">暂无技能</EmptyState>
      ) : (
        <div className="flex flex-col">
          {visibleSkills.map((skill) => (
            <SkillItem
              key={skill.id}
              skill={skill}
              refCount={refCounts[skill.id!] ?? 0}
              onToggle={(enabled) => void toggle(skill, enabled)}
              onEdit={() => void editSkill(skill)}
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

      {/* HeroUI Modal 默认响应 Esc 与点遮罩，onOpenChange 同步回 state（不会「关掉又弹回」）。 */}
      <Modal.Root isOpen={draft != null} onOpenChange={(open) => { if (!open) setDraft(null); }}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="lg" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog data-testid="skill-dialog">
              <Modal.Header>
                <Modal.Heading>
                  {draft?.id == null
                    ? '新建技能'
                    : draft.builtin
                    ? `查看「${draft.name}」`
                    : `编辑「${draft.name}」`}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                {draft && (
                  <>
                    {draft.builtin && (
                      <div className="text-muted">
                        内置技能不可直接修改，保存时将创建副本，原版可随时重置恢复。
                      </div>
                    )}
                    <h3 className="mt-4 text-base font-semibold text-balance">基础信息</h3>
                    <Field label="名称 *">
                      {/* data-testid 挂在 TextField 包装层上：e2e 用 `[data-testid="skill-name"] input`
                          定位控件（替 mdui-text-field 宿主持有内部 input 的结构）。 */}
                      <TextField aria-label="名称" isRequired data-testid="skill-name" fullWidth>
                        <Input
                          value={draft.name}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        />
                      </TextField>
                    </Field>
                    <Field label="描述 *" hint="简要描述技能的用途，以及适合在什么场景下使用。">
                      <TextField aria-label="描述" isRequired data-testid="skill-desc" fullWidth>
                        <Input
                          value={draft.description}
                          placeholder="一句话说明这个技能的用途"
                          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                        />
                      </TextField>
                    </Field>
                    <Field label="说明" hint="支持 Markdown，用于指导 AI 如何执行这个技能。">
                      <TextField aria-label="说明" isRequired data-testid="skill-body" fullWidth>
                        <TextArea
                          rows={10}
                          value={draft.body}
                          style={{ fontFamily: 'monospace' }}
                          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                        />
                      </TextField>
                    </Field>
                    <section className="py-4" aria-labelledby="skill-support-files">
                      <div className="flex items-center justify-between gap-3">
                        <h3 id="skill-support-files" className="text-base font-semibold text-balance">支持文件</h3>
                        <Button variant="secondary" size="sm" onPress={() => supportFileRef.current?.click()} data-testid="skill-add-files">
                          <Sym name="add" />添加文件
                        </Button>
                        <input ref={supportFileRef} type="file" accept=".md,.markdown,.txt,.csv,.json,.yaml,.yml" multiple hidden onChange={(e) => void addSupportFiles(e)} />
                      </div>
                      <p className="mt-2 text-xs text-muted text-pretty">添加参考资料供技能使用，支持 Markdown、TXT、CSV、JSON 和 YAML；同名文件将替换。</p>
                      {draft.refs.length ? (
                        <ul className="mt-3 divide-y divide-border rounded-lg border border-border px-3">
                          {draft.refs.map((ref) => (
                            <li key={ref.path} className="flex items-center gap-2 py-2">
                              <Sym name="description" />
                              <span className="min-w-0 flex-1 truncate text-sm" title={ref.path}>{ref.path}</span>
                              <Button isIconOnly size="sm" variant="tertiary" aria-label={`移除 ${ref.path}`} onPress={() => setDraft({ ...draft, refs: draft.refs.filter((item) => item.path !== ref.path) })}>
                                <Sym name="close" />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="mt-3 text-sm text-muted">暂无支持文件</p>}
                    </section>
                    {draftError && <p role="alert" className="text-sm text-danger">{draftError}</p>}
                  </>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" data-testid="skill-cancel" onPress={() => setDraft(null)}>
                  取消
                </Button>
                <Button variant="primary" isDisabled={saving} data-testid="skill-save" onPress={() => void saveDraft()}>
                  {saving ? '保存中…' : draft?.builtin ? '存为副本' : '保存'}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </SectionCard>
  );
}

/**
 * 单个技能行。
 *
 * 为什么不用 HeroUI 的 ListBox.Item：一行里要放「标题 + 描述 + 开关 + 两个操作按钮」
 * 四组内容，列表项的预设布局塞不下，所以直接用 flex + 设计令牌搭，行为与视觉都完全可控。
 *
 * 开关走标准 React props（isSelected + onChange）。
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
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-3 transition-colors hover:bg-default-soft"
      data-testid="skill-row"
      data-skill-id={skill.id}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base text-foreground">{skill.name}</span>
          {/* 静态标记用 Chip：这里不在 label 里，没有嵌套可交互元素的问题 */}
          {!!skill.builtin && (
            <Chip variant="soft" size="sm">
              <Chip.Label>内置</Chip.Label>
            </Chip>
          )}
          {refCount > 0 && (
            <Chip variant="soft" size="sm">
              <Chip.Label>{refCount} 篇参考文档</Chip.Label>
            </Chip>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">{skill.description || '（无描述）'}</div>
      </div>
      <Switch
        className="shrink-0"
        isSelected={!!skill.enabled}
        onChange={onToggle}
        data-testid="skill-toggle"
        aria-label={`启用「${skill.name}」`}
      />
      <Button className="shrink-0" variant="tertiary" data-testid="skill-edit" onPress={onEdit}>
        <Sym name="edit" />
        {skill.builtin ? '查看' : '编辑'}
      </Button>
      {skill.builtin ? (
        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          className="shrink-0"
          data-testid="skill-reset"
          aria-label="重置为内置版本"
          onPress={onReset}
        >
          <Sym name="refresh" />
        </Button>
      ) : (
        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          className="shrink-0"
          data-testid="skill-delete"
          aria-label="删除技能"
          onPress={onDelete}
        >
          <Sym name="delete" />
        </Button>
      )}
    </div>
  );
}
