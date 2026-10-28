# 模型配置与 nanobot 实现对照

核对时间：2026-10-28。参考 HKUDS/nanobot 官方仓库提交 `b07b3eac244ff7faa7eeb2d4777fe54dbae1b6d2`；不将当前 main 的源码行为冒称为 0.3.5 发布版行为。

## 源码依据

- [供应商和模型 API](https://github.com/HKUDS/nanobot/blob/b07b3eac244ff7faa7eeb2d4777fe54dbae1b6d2/nanobot/webui/settings_models.py)：`create_provider_settings`、`update_provider_settings` 与模型预设创建/更新、调用顺序操作分开；`provider_models_payload` 明确声明获取模型列表不会修改配置，区分 unsupported、not_configured、missing_api_base、error、available。
- [前端保存动作](https://github.com/HKUDS/nanobot/blob/b07b3eac244ff7faa7eeb2d4777fe54dbae1b6d2/webui/src/components/settings/models/useModelSettingsActions.ts)：`saveProvider` 单独提交连接，保留 agent/capability 表单，成功后清除输入的 Key、关闭可见/编辑状态；`saveModelSettings` 独立提交预设修改；编辑身份用于避免迟到响应覆盖其他预设。
- [表单同步](https://github.com/HKUDS/nanobot/blob/b07b3eac244ff7faa7eeb2d4777fe54dbae1b6d2/webui/src/components/settings/models/useModelSettingsEffects.ts)：服务器设置更新后保留已有供应商表单。
- [概念说明](https://github.com/HKUDS/nanobot/blob/b07b3eac244ff7faa7eeb2d4777fe54dbae1b6d2/docs/providers.md)：凭据/地址属于 provider，provider/model/参数属于 model preset，agent defaults 选择预设。

这些是经过源码确认的设计，不构成对 nanobot 或本项目“业界最佳”的全面认证。

## 本项目采用的配置规则

1. 连接、已添加模型、默认用途是不同实体。候选列表仅来自当前连接的 `/models`；`models.dev` 只补充名称与缺失的能力参数。接口列表是供应商声明，不等同于调用测试或账户模型授权。
2. `PUT /api/v1/cloud/providers/:id` 只保存当前连接。无需先选择默认模型；历史失效模型引用保持可见，不能阻止保存用于修复它的连接。
3. `PUT /api/v1/cloud/model-settings` 只更新连接集合与默认用途，始终从服务器保留最新 policy、trustedAgentIds、botBudget。模型库、收藏和运行参数仍走既有账号偏好同步。
4. 两个新接口必须携带 `modelRevision`。它是覆盖模型和连接（含凭据）的不透明 HMAC 版本，不包含账户策略；事务内校验，过期返回 409，前端保留草稿，明确确认后才能用服务器数据替换草稿。
5. 允许未完成的设置：没有默认模型时可保存连接；运行需要某用途时再要求配置。非空模型必须引用存在的供应商。前后端共享引用校验，一次报告所有错误，带 `path` 和 `reason`。
6. 新建连接按钮直接“保存连接并获取模型”；修改连接后同一个操作可保存并刷新。保存成功后清空 Key 输入框，再用会话认证从服务器获取模型；获取失败不撤销已保存连接。
7. 删除供应商前列出受影响用途。草稿中同时清理所有默认用途（含决策）、模型库和收藏；默认模型不自动改到其他供应商。连接集合与引用在同一配置事务提交。
8. 版本变化使旧连接发现结果失效。既有发现层保留取消、请求去重、分页、总超时、有限重试和凭据/账号隔离缓存；鉴权失败不重试，429 保留 Retry-After。
9. 首次引导、云端与本机设置使用同一模型管理组件。保存连接或进入已配置的供应商详情时默认获取 `/models`；候选模型仅来自当前连接的接口结果及其隔离缓存，models.dev 只补充缺失的名称和能力参数，不作为候选列表。手动覆盖优先于接口声明，接口声明优先于 models.dev。401、403、不支持列表与限流分别提示下一步，可手动填写模型；不因列表请求失败自动删除模型或改变默认选择。
10. 默认用途在供应商详情和新建连接时仍可访问；失效引用显示字段内错误，可定位并清除。刷新/关闭窗口时提醒未保存修改。新连接表单未保存时，禁止把全局保存误报为成功。
11. 模型选择合并为一个入口，同时展示供应商与模型；切换供应商不会隐式选择它的首个模型。手机供应商使用可读的横向列表行，删除操作保留独立触控区域；模型浮层使用不透明主题背景。

## 保存结果与恢复

- 保存当前连接不覆盖其他草稿连接、默认模型和能力覆盖。
- API Key 未提交表示保留服务器凭据；明文不回传浏览器、不写浏览器持久化。接口允许显式空字符串清除凭据，当前表单留空表示保留。
- 模型配置保存和偏好同步是两个持久化通道。后者失败时明确显示“连接与默认模型已保存；模型库偏好同步失败”，保留重试入口，不报全量成功，不自动完成引导。
- 冲突不自动重试覆盖。重新载入是显式放弃未保存编辑，需确认；也会清除组件内的新连接与密钥草稿。

## 验证

- `npm run test:model-settings`：服务端字段错误、首次配置、凭据保留/轮换、策略隔离、版本冲突、历史引用恢复、删除事务，以及发现层超时/取消/缓存/重试。
- `npm run build` 后运行 `npm run test:model-settings:e2e`：引导与设置共用流程、保存并获取、能力覆盖、失败重试、404 恢复、并发修改冲突、删除受影响引用、密钥存储和手机布局。
- `npx tsx scripts/test-model-list-source-e2e.mjs`：三个配置入口的默认接口发现、目录不混入、参数补全优先级、空列表和错误处理、手动添加和凭据隔离。

## 边界

当前实现保留用途选择，未引入 nanobot 的命名预设与 fallback 调用链；也未新增实际模型调用探测。离开保护覆盖浏览器刷新/关闭、设置弹窗关闭、手机返回设置分类和桌面模块切换；应用路由或外部代码直接卸载编辑器仍使用现有生命周期。旧 `/config` 整体保存接口保留兼容；新版模型页面使用必须带版本的专用接口。
