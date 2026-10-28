# iLink 可靠性加固（2026-10-28）

## 现场问题

线上只读诊断：腾讯 `getupdates` 在 310ms 返回 HTTP 200，一条人类私聊消息使用 19 位数字 `message_id`；旧版 `Response.json()` 丢失精度，随后 `normalizeIlink` 抛出 `unsafe_platform_message_id`。收件箱为空，游标未推进，错误又被统一显示成「重新连接中」。

旧回归把拒收大整数 ID 当作成功，无法证明真实渠道可用。现在使用原始 JSON 字节形态测试，而非先在 JavaScript 中创建一个已经失真的 number。

## 开源参考与取舍

- [Tencent/openclaw-weixin `874637a0dbc24050f72d1385add4fc6170a2d726`](https://github.com/Tencent/openclaw-weixin/tree/874637a0dbc24050f72d1385add4fc6170a2d726)：核对 `src/api/api.ts` 的 `parseWeixinApiJson`、`getUpdates`，`src/monitor/monitor.ts` 以及 `src/auth/login-qr.ts`；采用相同的三个 ID 字段、协议头、空闲轮询语义、错误码及扫码终态。
- [grammY 源码 `src/bot.ts`](https://github.com/grammyjs/grammY/blob/main/src/bot.ts)、[可靠性说明](https://grammy.dev/advanced/reliability)、[auto-retry](https://grammy.dev/plugins/auto-retry)：参考长轮询取消、重放/offset、HTTP 与业务错误区分、429 服务端等待时间、可重试故障退避。只借鉴机制，不把 Telegram 的确认和发送契约假定为微信契约。
- [lossless-json 4.3.3](https://github.com/josdejong/lossless-json)：使用维护中的 JSON 解析库及原始数值 token，避免自制正则替换误改用户字符串、转义键或嵌套对象。仅 API 工作区新增该依赖，锁定版本；不增加前端依赖。

保留本项目已经具备的加密持久 inbox、消息 ID 去重、游标同事务提交、outbox、账号隔离及单实例约束。微信未提供可验证的远端去重窗口，因此发送未知结果不套用「网络错误一律自动重发」。官方失效令牌暂停一小时；此处采用更明确的 `login_required` 停止请求并等待重新扫码。

## 已落地的行为

1. **消息完整性**：数字 uint64 ID 无损字符串化；相邻大 ID 不碰撞；原始字符串 ID 和文本不改写。解析/接收失败不提交游标，空游标不重置进度。
2. **故障分类**：DNS、TLS、网络、传输超时、限流、平台业务错误、协议格式错误及 SQLite 接收失败分别报告。仅正常空闲轮询超时直接续轮，不制造已连接或断线状态。
3. **重试策略**：轮询指数退避使用 equal jitter，普通等待上限 60 秒；`Retry-After` 支持秒数/HTTP 日期，作为等待下限。永久 HTTP 4xx 停止自动轮询；401/`-14` 阻止该实例后续认证请求。
4. **发送语义**：发送阶段的断网、响应体丢失、坏 JSON、5xx/408 保持不确定投递；显式不可重试 4xx 终止；CDN 上传失败尚未发消息，可重试。保留稳定 client ID 和人工处置队头。
5. **生命周期**：停止中断轮询和退避；旧实例迟到响应不能写游标；扫码 HTTP 客户端断开会取消服务端上游轮询。同一 Bot 换 token 保留游标，换 Bot 身份要求新渠道。
6. **扫码状态机**：验证码必须主动提交且一次消费；错误不反复提交；blocked、already-bound 均终止当前轮询；网络错误有限重试后可见。
7. **可观测性**：账号详情显示具体原因、数字错误码、失败次数、重试时刻和最近成功同步时间；支持立即重连。结构化日志经过字段白名单并按失败次数稀疏输出。实时诊断存在内存，重启后重新建立；持久 inbox/outbox 不依赖它。
8. **资源边界**：API 响应最多 4 MiB，媒体保留 20 MiB 上限；请求限时并取消响应流；API 域名限制为腾讯 iLink HTTPS，CDN 无 Bot 凭据。协议损坏批次保留原游标、明确报错，需修复后继续，不偷偷丢弃。

## 验证结果

- `npm run test:gateway` 通过：新增 17 组 iLink 测试，加原 Gateway、审查和 worker 回归。
- 新增 17 组在 **Node 22.23.4 和 Node 26.3.0** 均通过；Node 22 使用临时目录中的同版本 `better-sqlite3@12.11.1` 原生模块，避免影响本机 Node 26 工作区。首次直接加载本机原生模块的 ABI 不匹配已通过隔离模块复验排除。
- 故障注入覆盖 SQL 第二条入站写入失败，验证第一条也回滚、游标不动；重试后真实配对、Bot run、outbox 确认成功，重启重放不会重复创建 run。
- `npm run test:gateway:ui` 通过：独立 Web/API，390/1440px，诊断脱敏、验证码单次显式提交、blocked/already-bound、绑定/撤销、投递处置及扫码取消。截图：`test-results/ilink-gateway/gateway-390.png`、`gateway-1440.png`。
- `npm run test:api`、API/Web 类型检查、i18n 检查、`npm run build` 均通过。完整构建仍输出既有 HeroUI CSS 和混合静态/动态导入提示。

## 发布与实号验收

本次修改在工作区完成，未部署修复版本。没有数据库迁移，也不需要清空已有游标、绑定或队列。发布时 API 镜像须安装新增依赖并包含新适配器；Web 镜像提供诊断和验证码界面。

发布后需用真实账号确认：积压消息恢复入库、同一 Bot 的重新登录、本人配对、文字/图片/文件双向收发、断网重连、context 更新与过期、延时提醒。本次自动化验证不代替这些平台端验收；网络投递仍遵循上述不确定结果处理规则。
