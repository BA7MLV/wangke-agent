import { useEffect, useState } from 'react';
import { Button, Checkbox, Modal, Tooltip } from '@heroui/react';
import { Sym, MODAL_CONTAINER_CLASS } from '../ui';
import { loadEnabledSkillMeta, type SkillMeta } from '../skills/store';
import './skill-picker.css';

interface Props {
  /**
   * 当前会话的技能白名单。
   * - `undefined` = 不限定（全部启用技能可用）—— 默认态，也是「全选」归一化后的结果
   * - `[]` = 限定，且一个技能都不给
   * - `[id, ...]` = 限定为该集合
   */
  value?: number[];
  /** 变更回调。**已归一化**：勾选集等于全部候选时回传 `undefined`（见 `commit`）。 */
  onChange: (next: number[] | undefined) => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}

/**
 * 问答面板的「技能范围」选择器：一个图标按钮 + 一个多选对话框。
 *
 * ## 为什么是「限定范围」而不是讲义那套「自动 / 必用 / 排除」
 *
 * 讲义要落成一份确定格式的文档，「我就是要公文格式」是个明确诉求，值得把技能正文
 * 强制注入。问答是一问一答的探索过程 —— 同一会话里前一句问「这段怎么理解」、
 * 后一句问「帮我画个图」，需求本来就在变。钉死一套规范反而限制了它。
 * 所以这里只收窄**可选集合**，用不用仍由模型按问题自己判断，交互也就只需要一个多选框。
 *
 * ## 为什么图标是 extension 而不是 tune
 *
 * `tune` 在 HandoutPanel 已经代表「生成参数（模型 + 技能覆盖）」。同一图标两种含义
 * 会让人以为点开是同一类东西。`extension`（拼图块）是 skill / 插件的通用隐喻。
 */
export default function SkillPicker({ value, onChange, isOpen, onOpenChange, hideTrigger }: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [skills, setSkills] = useState<SkillMeta[]>([]);

  /**
   * 每次打开都重新拉候选：设置页可能刚启用 / 禁用了技能，
   * 缓存住会让人对着一个已经禁用的技能勾选，然后发现「勾了没用」。
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadEnabledSkillMeta().then((metas) => {
      if (!cancelled) setSkills(metas);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const limited = value !== undefined;
  /** `null` 代表「全选」—— 不限定模式下不需要逐项判断，直接用这一个哨兵值表达 */
  const allow = limited ? new Set(value) : null;
  const isChecked = (id: number) => allow === null || allow.has(id);

  /**
   * 归一化写回：勾选集 == 全部候选 → `undefined`（不限定）。
   *
   * 不归一化的话，「全选」会变成一份**快照**：之后在设置页新增技能，这个会话不会
   * 自动包含它，而界面上显示的明明是「全选了」—— 一个很隐蔽的不一致。
   */
  const commit = (next: Set<number>) => {
    if (next.size === skills.length) onChange(undefined);
    else onChange(skills.map((s) => s.id).filter((id) => next.has(id)));
  };

  const toggle = (id: number, on: boolean) => {
    const next = new Set(skills.filter((s) => isChecked(s.id)).map((s) => s.id));
    if (on) next.add(id);
    else next.delete(id);
    commit(next);
  };

  const checkedCount = skills.filter((s) => isChecked(s.id)).length;

  // 只依据 value 判断，不依赖 skills —— 对话框没打开时 skills 可能还是空的，
  // 用它做条件会让空集会话的 tooltip 退化成「已限定 0 项」这种不达意的文案。
  const tooltip = !limited
    ? '技能：自动（全部启用技能可用）'
    : value.length === 0
      ? '技能：本次会话不提供任何技能'
      : `技能：已限定 ${value.length} 项`;

  return (
    <>
      {!hideTrigger && <Tooltip>
        <Tooltip.Trigger>
          <Button
            isIconOnly
            variant={limited ? 'primary' : 'tertiary'}
            size="sm"
            aria-label="技能范围"
            data-testid="skill-picker"
            // data-limited 是给 e2e 的稳定状态信号（variant 只是视觉）
            data-limited={limited ? '1' : undefined}
            onPress={() => setOpen(true)}
          >
            <Sym name="extension" />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>
          <p>{tooltip}</p>
        </Tooltip.Content>
      </Tooltip>}

      <Modal.Root isOpen={open} onOpenChange={setOpen}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog data-testid="skill-picker-dialog">
              <Modal.Header>
                <Modal.Heading>技能范围</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <div className="skill-picker">
                  <div className="skill-picker__hint">
                    仅勾选的技能可供本次会话使用；全部勾选即「不限定」，之后新启用的技能会自动加入。
                  </div>
                  {skills.length === 0 ? (
                    <div className="skill-picker__empty">暂无启用的技能，请到「设置 → 写作技能」添加</div>
                  ) : (
                    skills.map((s) => (
                      <Checkbox
                        key={s.id}
                        className="skill-picker__item"
                        isSelected={isChecked(s.id)}
                        onChange={(on) => toggle(s.id, on)}
                        data-testid="skill-scope-item"
                        data-skill-name={s.name}
                      >
                        {/* ⚠️ `Control` + `Indicator` 必须显式写：HeroUI v3 的 Checkbox
                            是复合组件，Root **不会**替你补出勾选框 —— 漏掉这两个子节点的
                            后果是「只剩文字、没有框」，看着像一行普通文本，用户根本不知道
                            该点哪（2026-10-15 实测：对话框里 8 个技能一个框都看不见）。
                            这个坑状态断言也照不出来，回归覆盖补在
                            `scripts/e2e-chat-skill-scope.mjs` 的「每个技能都渲染出勾选框」。
                            （`settings/ModelsModule.tsx` 的写法是对的，可对照。） */}
                        <Checkbox.Content className="skill-picker__content">
                          <Checkbox.Control>
                            {/* data-testid 只给 e2e 当锚点：勾选框「画出来了没有」是纯视觉
                                事实，aria / 状态属性都照不到，只能靠这个元素在不在。 */}
                            <Checkbox.Indicator data-testid="skill-scope-check" />
                          </Checkbox.Control>
                          {/* 名称与描述同放 label 内：整行（含描述）都是可点区域。
                              描述原本是 Checkbox 的兄弟节点，点它不切换 —— 而它占了这一行
                              大半面积，手指/鼠标落在那里毫无反应，正是「选不了」的来源。 */}
                          <span className="skill-picker__text">
                            <span className="skill-picker__name">{s.name}</span>
                            <span className="skill-picker__desc">{s.description || '（无描述）'}</span>
                          </span>
                        </Checkbox.Content>
                      </Checkbox>
                    ))
                  )}
                  {skills.length > 0 && checkedCount === 0 && (
                    <div className="skill-picker__warn">
                      一个技能都没勾选：本次会话不会向模型提供任何技能，回答将只依据课程内容。
                    </div>
                  )}
                </div>
              </Modal.Body>
              <Modal.Footer>
                {skills.length > 0 && (
                  <>
                    <Button
                      variant="tertiary"
                      data-testid="skill-picker-all"
                      onPress={() => commit(new Set(skills.map((s) => s.id)))}
                    >
                      全选
                    </Button>
                    <Button variant="tertiary" data-testid="skill-picker-none" onPress={() => commit(new Set())}>
                      清空
                    </Button>
                  </>
                )}
                <Button variant="primary" data-testid="skill-picker-done" onPress={() => setOpen(false)}>
                  完成
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </>
  );
}
