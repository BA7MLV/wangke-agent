# Prompt / KV 缓存与用量基线

## 查看实际用量

设置 → 模型 → **缓存用量 · 最近 24 小时** → 读取统计，可按供应商/模型查看并导出 JSON。

- 浏览器直连：统计保存在聊天行的 `modelRequests` 中；删除聊天也会删除对应测量。分支不复制请求账单。
- 云端：`GET /api/v1/cloud/model-usage?days=1`，`days` 为 1–90。按登录用户隔离，合并普通模型请求的 `model_observations` 与 Bot 的 `bot_requests`。Bot 子任务仅计入 Bot 账本一次。
- 服务端任务、`modelOnce` 和浏览器云代理均从实际返回的数据采集。不要把客户端报告和云端报告相加，同一次请求可能同时出现在两边。
- Bot 管理接口保留逐请求明细，并提供 UTC 当日的缓存统计。

### 设置 → 用量（服务器模式）

连接服务器后可进入独立的「用量」模块（深链 `#/settings/usage`）。默认显示最近 7 个 UTC 自然日，可选 1–90 天、全部 / Chat / Bot，以及按来源、供应商/模型或日期汇总。浏览器直连模式不显示此模块，原有本地缓存基线入口保持不变。

复用 `GET /api/v1/cloud/model-usage`，按登录用户隔离：

- 兼容原有 `?days=1`（最近 24 小时，默认 1，最大 90）。
- 自然日范围：`?start=2026-10-01&end=2026-10-30&source=all`。起止日期均为严格的 `YYYY-MM-DD`，包含结束日；不得与 `days` 混用。`source` 可为 `all`（默认）、`chat`、`bot`。
- 返回 `since`（含）、`until`（不含）、`timeZone: UTC` 和 `generatedAt`；按请求的 `started_at` 归属日期，而非完成时间。
- 保留 `total` 和跨来源合并的 `byModel`；新增 `bySource`、`bySourceModel`、`byDay`（日期 + 来源）和 `byDayModel`（日期 + 来源 + provider/model）。无请求的组不返回记录。
- 来源由 SQLite 表确定：`model_observations` 为 `chat`（包含普通模型请求），`bot_requests` 为 `bot`（含子任务）。不复制账本，不使用 JSON 作为主存储，不需要迁移或历史回填。
- `inputTokens` / `outputTokens` / `totalTokens` 是已知值的小计；`measuredRequests` 仅计算输入、输出均非 NULL 的请求，另有输入、输出、缓存读、缓存写和 reasoning 各自的覆盖计数。NULL 不等于测量为 0；全无测量时 UI 显示「未知」。失败、取消和未结算请求仍计入请求数，预留 token 不作为实际消耗。
- 缓存读写已计入归一化输入、reasoning 已计入输出，不重复相加。缓存命中率仅用同时有缓存读和输入测量的请求计算，分母为 0 时返回 NULL。这里展示 token 而非估算费用。

未接入账本的历史流量不会回填；历史数据的缺失字段继续显示未知。服务重启后仍标为 `inflight` 的请求不会被报告查询擅自结算。查询复用两张表现有的 `(owner_id, started_at)` 索引。

输入/输出 token 采用供应商报告值。OpenAI 的 cached/reasoning token 是总数的子集；Anthropic 的 `input_tokens` 不包含缓存读写，归一化时补入。流式 usage 是累计快照，不逐事件相加。缺失字段保持未知，不伪装成 0。

```text
缓存命中率 = 有缓存读统计的请求的缓存读 token 总和
             / 同一批请求的总输入 token
```

报告同时给出测量覆盖请求数、缓存写入量。费用仍按现有预算价格估算，不能把 token 命中率当作账单节省比例。缓存没有命中也可能只是前缀不够长、缓存过期、路由变化或供应商未返回统计。

**真实基线尚未采集。** 自动化测试中的命中量为模拟响应，仅证明统计与重放正确。部署后，应对同一模型/端点和相同代表性会话，分别记录首轮、工具轮、跨问题、刷新恢复、压缩前后及改模型后的报告；保留请求数、覆盖率和输入规模。禁止为了漂亮的百分比填充无用提示词。

## 请求组织

1. 通用系统规则在前；用户偏好、技能等会话配置分成后续 system 块。
2. 课程名称、所选课程、附件数量、显示尺寸、题卡作答更新进入当轮用户运行上下文。Bot 的工作区、技能、笔记元数据变化时追加更新，不重写最前面的 system。
3. 工具按名称排序，schema 对象键规范化；消息正文、工具参数和数组顺序不作规范化。权限/可用工具变化仍立即更新。
4. UI 气泡与 `modelTrace` 分开。历史重放保存的用户图片、助手消息、工具 ID/参数/结果，不从 UI 摘要重新构建。编辑正文会使旧投影失效。
5. Anthropic 原生块（包括签名）和 Responses output（包括加密 reasoning）按原顺序保存；仅相同 provider/model/protocol/base URL 重放。切换目标保留通用对话和工具证据，剥离不兼容的原生状态。
6. 浏览器和服务端问答按完整轮次裁剪，保留 20% 余量并保存来源校验的边界；Bot 保存可恢复的稳定压缩视图。Jev 省略计划随会话持久化。预算短暂变大不会自动恢复已经裁去的前缀，原始历史仍保留。

浏览器提问卡的调用信封与结果可能归属不同 UI 行；刷新后的恢复会接上同一个调用，不重新执行旧工具。中断时的未完成调用由发送前的消息校验补齐失败结果。缓存历史不代表当前授权，工具仍执行实时权限检查。

服务端问答在工具边界和节流后的输出增量保存同一组聊天行与原始历史；任务失败或进程重启后，已经完成的工具证据仍可用于下一轮。正在流出的未完成正文保存为普通文本，不伪造完整的原生 reasoning 签名。

## 能力策略

策略集中在 `packages/study-core/src/api/promptCache.ts`，按 HTTPS 官方域名、协议和已审核模型组合选择：

- Anthropic Messages：共享/会话 system 边界的 ephemeral 标记，加顶层自动尾部缓存；默认 TTL，不额外请求长时缓存。
- OpenAI Chat/Responses：稳定 `prompt_cache_key`；Chat 流请求开启 usage。已审核的显式缓存模型另加 request policy 与 system 文本断点。
- 未审核模型、第三方兼容网关：不主动注入供应商缓存字段。模型名称本身不足以证明端点支持字段。
- 云代理用服务器保存的真实供应商配置选择策略，并对客户端缓存键做用户级哈希。浏览器无需把供应商字段猜测后透传。
- 官方已审核端点的收尾轮保留工具定义，用 `tool_choice: none` 禁止调用，避免整个工具前缀消失。

新增支持时先确认当前文档、精确协议和模型范围，再增加线上请求形状回归。不要用未来版本通配符推测支持能力。

## 验证

```sh
npm run build
npm run test:usage
npm run test:usage:e2e
node --import tsx scripts/test-prompt-cache.mjs
node scripts/test-qa-runner.mjs
node scripts/test-agent-loop.mjs
node scripts/test-jev.mjs
node --import tsx scripts/test-memory-context.mjs
node --import tsx scripts/test-bot-migrations.mjs
node --import tsx scripts/test-bot-conversation.mjs
node --import tsx scripts/test-bot-request-budget.mjs
node --import tsx scripts/test-task-executors.mjs
```

浏览器专项（需要 Vite 开发服务器；使用拦截的模拟 API，不产生模型费用）：

```sh
npm run dev -w @wangke/web -- --host 127.0.0.1 --port 4193
BASE_URL=http://127.0.0.1:4193 node scripts/e2e-prompt-cache.mjs
```

覆盖实际序列化、未知端点、usage 流事件、原生块、数据库重开、题卡恢复、完整前缀、统计导出和 360px 布局。旧版 `e2e-chat-resume-fork.mjs` 的标题跑马灯检查和 `e2e-course-chat-cards.mjs` 的旧页面选择器目前未通过；不作为本专项已通过的证明。

参考：
- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- OpenChamber `90a081c5a4a33766ee751ba6951f2f88d2fb6f80`：用量展示与 prompt 转发。
- OpenCode `510aa79d075c32e75f85b7774ff7390370c22b18`：缓存键、供应商适配、指令状态及压缩参考。
