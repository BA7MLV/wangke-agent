# 内置技能与讲义专题

日常对话和设置页默认提供五个任务入口：课程讲义、讲解配图、交互式讲解、原题题库、资料整理。用户自定义技能另计。

## 合并内容

`src/skills/builtin/course-handout/SKILL.md` 负责来源读取、覆盖范围、普通 Markdown 文件、增量修改和交付。通用文风与结构集中在 `references/writing.md`；数学、编程、行测、申论分别放在四份专题参考中，只加载本次相关专题。

- 公文讲义写作、版式中的内容组织规则 → 通用 writing；字体字号、分页仍由旧版渲染器负责。
- 数学、编程规范 → Markdown 专题，支持公式、必要推导和可复制代码。
- 行测、申论规范 → 保留完整题型及广东相关内容，按实际来源和题目条件应用。
- 静态配图与交互讲解分别服务会话可视化；会话能显示的组件不代表能够随 Markdown 文件导出。
- 原题题库保留忠实提取、原图、答案来源与判分；资料整理保留分类方案及用户确认。

## 旧版兼容

旧公文 IR 讲义流水线仍在运行，因此六份旧规范保留在 `LEGACY_HANDOUT_SKILLS`；`BUILTIN_SKILLS` 只包含五个日常入口。磁盘上仍有十一份 SKILL.md，不能以目录数量推断日常候选数量。

- `loadEnabledSkillMeta()` 返回日常入口；`loadEnabledSkillMeta('legacy-handout')` 返回旧 IR 规范。用户自定义技能在两种上下文均可用。
- 注册保持原数据库 ID、启停状态、课程 pin/drop 和参考文档身份，不删除用户副本或改写历史会话。
- 对话中启用的旧 ID 可作为「课程讲义」的别名；空白名单仍拒绝全部技能，禁用的旧 ID 或「课程讲义」不会被别名重新启用。
- 旧内置技能资源路径重定向到 Markdown 流程；已存在的旧参考路径映射对应专题，未知路径仍报错。同名用户技能不重定向。
- 设置 → 技能 →「管理旧版讲义规范」仍可查看、启停和复制旧规范。旧流水线的候选、失败兜底和手动覆盖均不混入新的 Markdown 任务入口。

## 验证

```sh
node scripts/test-builtin-skills.mjs
node scripts/test-skill-catalog.mjs
node scripts/test-qa-skill-scope.mjs
node scripts/test-resource-tools.mjs
node scripts/test-jev.mjs
node scripts/test-handout-file.mjs
node scripts/test-question-bank.mjs
npm run build
```

设置交互与并发注册使用 `scripts/e2e-settings-skills.mjs`、`scripts/e2e-skills-dedupe.mjs`（通过 `BASE_URL` 指定 dev 服务）。集成测试使用临时 fake IndexedDB，不修改真实课程、会话或模型服务。
