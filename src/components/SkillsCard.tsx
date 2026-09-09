import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, List, Modal, Popconfirm, Space, Switch, Tag, Typography, Upload } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
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
  const { message } = App.useApp();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [refCounts, setRefCounts] = useState<Record<number, number>>({});
  const [draft, setDraft] = useState<Draft | null>(null);

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
        message.success(`已导入「${name}」${refCount > 0 ? `（含 ${refCount} 篇参考文档）` : ''}`);
        ok++;
      } catch (e) {
        message.error(`导入 ${f.name} 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (ok > 0) void reload();
  };

  const saveDraft = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const body = draft.body.trim();
    if (!name || !body) {
      message.warning('名称和正文不能为空');
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
    message.success('已保存');
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
    message.success('已重置为内置版本');
    void reload();
  };

  return (
    <Card
      title="写作技能"
      extra={
        <Space>
          <Upload
            accept=".md,.markdown,.zip"
            multiple
            showUploadList={false}
            beforeUpload={(_, list) => {
              void importFiles(list as File[]);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />}>导入</Button>
          </Upload>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setDraft({ builtin: false, name: '', description: '', body: '' })}
          >
            新建
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        启用的技能按相关性自动注入讲义生成与课程问答。支持 SKILL.md 单文件（.md）或含 references/
        参考文档的 zip 包；技能正文会注入提示词，请只导入可信来源。
      </Typography.Paragraph>
      <List
        dataSource={skills}
        locale={{ emptyText: '暂无技能' }}
        renderItem={(skill) => (
          <List.Item
            actions={[
              <Button
                key="edit"
                size="small"
                icon={<EditOutlined />}
                onClick={() =>
                  setDraft({
                    id: skill.id,
                    builtin: !!skill.builtin,
                    name: skill.name,
                    description: skill.description,
                    body: skill.body,
                  })
                }
              >
                {skill.builtin ? '查看' : '编辑'}
              </Button>,
              skill.builtin ? (
                <Popconfirm key="reset" title="重置为内置版本？" onConfirm={() => void resetBuiltin(skill)}>
                  <Button size="small" icon={<ReloadOutlined />} />
                </Popconfirm>
              ) : (
                <Popconfirm
                  key="del"
                  title={`删除技能「${skill.name}」？`}
                  onConfirm={() => void removeSkill(skill)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              ),
            ]}
          >
            <List.Item.Meta
              title={
                <Space size={8}>
                  {skill.name}
                  {!!skill.builtin && <Tag>内置</Tag>}
                  {(refCounts[skill.id!] ?? 0) > 0 && <Tag>{refCounts[skill.id!]} 篇参考文档</Tag>}
                </Space>
              }
              description={skill.description || '（无描述）'}
            />
            <Switch checked={!!skill.enabled} onChange={(v) => void toggle(skill, v)} />
          </List.Item>
        )}
      />

      <Modal
        open={draft != null}
        title={draft?.id == null ? '新建技能' : draft.builtin ? `查看「${draft.name}」` : `编辑「${draft.name}」`}
        width={720}
        onCancel={() => setDraft(null)}
        onOk={() => void saveDraft()}
        okText={draft?.builtin ? '存为副本' : '保存'}
      >
        {draft && (
          <Form layout="vertical">
            {draft.builtin && (
              <Typography.Paragraph type="secondary">
                内置技能不可直接修改，保存时将创建副本，原版可随时重置恢复。
              </Typography.Paragraph>
            )}
            <Form.Item label="名称" required>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Form.Item>
            <Form.Item label="描述">
              <Input
                value={draft.description}
                placeholder="一句话说明这个技能的用途"
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="正文（Markdown，将作为写作规范注入讲义生成）" required>
              <Input.TextArea
                value={draft.body}
                rows={14}
                style={{ fontFamily: 'monospace' }}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </Card>
  );
}
