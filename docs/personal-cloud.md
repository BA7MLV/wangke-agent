# 个人云端部署

一套部署、一个管理员、多设备共享课程与任务。安装：

```sh
./install.sh --public-url https://learn.example.com --max-file-mb 512
# 需要 Linux 命令沙盒时加 --agent
```

1. 预先把 HTTPS 域名代理到服务器的 3000 端口，允许 512 MiB 上传（例如 nginx 的 `client_max_body_size 512m;`）。
2. 打开安装输出的完整一次性初始化链接（`/#/setup?secret=…`），密钥会自动填入，只需设置账号和密码创建管理员。密钥放在 URL 的 `#` 后，不发送给服务器日志，页面读取后会从地址栏清除。请勿分享完整链接；默认有效期 24 小时，成功创建管理员后失效。手动访问 `/#/setup` 时仍可输入 bootstrap-secret 文件内的密钥。
3. 添加模型服务，选择 API 协议，填写 API Key 和对话/视觉/转写模型 ID，保存。无 Key 的本地模型也可用。
4. 添加 Passkey。HTTPS 公网域名必须与 `PUBLIC_ORIGIN`、`WEBAUTHN_RP_ID` 一致；只有 localhost 允许 HTTP。默认密码登录仍可使用。
5. 其他设备访问同一 URL，用密码或 Passkey 登录。后续管理在“设置 → 模型 / 数据”，或直接访问 `/#/setup`。

## 运行资源

镜像包含 FFmpeg，但不包含 Chromium。任务调度按类型分流：模型、聊天、问答和文本任务直接在 Node 执行，视频封面使用 FFmpeg 子进程；视频/音频解码、PDF 预览和 UI 依赖任务由已认证的外部浏览器 Worker 执行。默认同时计算 2 个任务（`CLOUD_CONCURRENCY=1..4`），等待审批也占用内存。原文件与产物保存在 `/data`。分流清单与 Worker 认证方式见 [任务执行架构](task-execution.md) 和 [外部浏览器 Worker](browser-worker.md)。

非 Docker 启动时先安装系统 FFmpeg（可用 `FFMPEG_PATH` 指定路径），然后 `npm run build && npm start`。需要浏览器任务时，在外部已登录浏览器打开 `/?cloud-worker=1`；开发/E2E 仍可单独安装 Playwright。开发 API 前先运行 `npm run build:api`。

## 同步与任务

- IndexedDB 是账号缓存；离线修改进入事务 outbox，重新连接后提交。新设备首次登录需联网。
- 不同字段修改合并，播放位置按最后提交更新，学习时长累计增量。同一内容冲突会阻止同步；在云端设置下载待同步副本后，可选择采用服务器版本。
- 课程解析、转写、封面、讲义、卡片、评论、弹幕、聊天和课程问答在服务器执行。关闭页面不会停止已提交的任务。
- 停止按钮取消服务器任务；进程重启后执行中的任务标记为中断，保留已同步检查点，明确重试才继续，避免重复副作用。排队任务可继续运行。
- Agent 修改资料前审批，批准仅适用于该次具体参数。权限改为“禁止”后，尚未提交的受控修改也会被服务器拒绝。沙盒命令默认逐次审批；长期信任的 Bot 只跳过“询问”，不能绕过“禁止”和独立联网开关。
- 执行器只访问同源 API；模型网关只转发管理员保存的端点且不跟随重定向。模型密钥不返回前端。

## 旧数据与备份

在旧浏览器的同一 origin 访问升级后的应用，在空的云端资料库选择“导入旧版浏览器数据”。原 IndexedDB/OPFS 不删除。跨域迁移可先使用旧版的数据导出。

```sh
~/.wangke-agent/bin/wangke-agent backup
scripts/restore.sh --data-dir "$HOME/.wangke-agent" \
  --compose-file /path/to/compose.yaml backups/wangke-agent-TIMESTAMP.tar.gz
```

必须一起保留 `data/db`、`data/files`、`data/config/credentials.key` 与 `.env`。缺少加密密钥无法解密已保存的模型配置。备份会暂停服务以获得一致快照，执行中的任务会中断。沙盒的 `wangke-workspace-*` Docker volumes 不在应用备份中，需要另行备份（见 [Agent Runtime](agent-runtime.md)）。

初始化密钥过期且尚未创建账号时，停止服务，删除 `data/config/bootstrap-secret`，再启动会生成新密钥。已经初始化的实例不会重新打开初始化入口。

有效期可通过部署目录 `.env` 中的 `BOOTSTRAP_TTL_MS` 配置，单位为毫秒，默认 `86400000`（24 小时）。旧部署若仍配置为 `900000`（15 分钟），需手动修改后重新创建应用容器；更新安装脚本不会覆盖已有配置。有效期从密钥生成时算起，重启不会重新计时。

## 验证

```sh
npm run test:cloud
npm run test:cloud:e2e  # 先构建；使用临时数据、模拟模型、真实 Chromium
npm run test:cloud:files  # 实际传输 512 MiB，需要相应临时磁盘空间
npm run test:cloud:backup
npm run test:api
npm run test:bot
npm run test:migration
npm run build
```

本机验收已覆盖双设备同步/问答、后台任务、审批、旧数据、虚拟 Passkey、视频封面和备份恢复。Linux Docker 镜像、真实沙盒、长视频及真实模型调用需在部署环境继续验收。
