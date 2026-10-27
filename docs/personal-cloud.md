# 个人云端部署

一套部署、一个管理员、多设备共享课程与任务。安装：

```sh
./install.sh --public-url https://learn.example.com --max-file-mb 512
# 需要 Linux 命令沙盒时加 --agent
```

安装过程会在终端打印百分比和当前阶段，例如 `[57%] [5/7] 构建服务镜像…`。七个阶段分别为环境检查、数据目录、配置文件、管理命令、镜像构建、服务启动与健康检查、初始化入口。百分比按已完成步骤计算，不代表耗时比例，也不会按时间自动增长；全部步骤成功后才到 100%。每步完成会打印耗时；Docker 构建与启动日志直接实时输出。失败时显示最后完成的百分比、停在哪一步和退出码，不会误报安装成功。`--no-start` 只执行前四步，百分比仅代表安装准备进度，明确提示构建、启动及健康检查已跳过。

1. 预先把 HTTPS 域名代理到服务器的 3000 端口，允许 512 MiB 上传（例如 nginx 的 `client_max_body_size 512m;`）。
2. 打开安装输出的完整一次性初始化链接（`/#/setup?secret=…`），密钥会自动读取，只需设置访问密码（12–256 位），无需填写账号。密钥放在 URL 的 `#` 后，不发送给服务器日志，页面读取后会从地址栏清除。请勿分享完整链接；默认有效期 24 小时，成功设置密码后失效。手动访问 `/#/setup` 时仍需输入 bootstrap-secret 文件内的密钥。
3. 添加模型服务，选择 API 协议，填写 API Key 和对话/视觉/转写模型 ID，保存。无 Key 的本地模型也可用。
4. 添加 Passkey。HTTPS 公网域名必须与 `PUBLIC_ORIGIN`、`WEBAUTHN_RP_ID` 一致；只有 localhost 允许 HTTP。默认密码登录仍可使用。
5. 其他设备访问同一 URL，用密码或 Passkey 登录。后续管理在“设置 → 模型 / 数据”，或直接访问 `/#/setup`。

## 忘记密码

登录页的“忘记密码？”可展开恢复说明。每套部署只有一个管理员，初始化和登录均无需填写账号。

1. 已绑定 Passkey：选择“使用 Passkey 登录”，不需要原密码。
2. 没有可用的 Passkey：由服务器管理员在部署目录执行（输入时不回显，需确认两次）：

   ```sh
   docker compose exec app node scripts/reset-password.mjs
   # 若部署时使用覆盖文件，需保留相同的 --env-file / -f 参数，例如：
   docker compose --env-file .env -f compose.yaml -f compose.prod.yaml -f compose.ip.yaml exec app node scripts/reset-password.mjs
   ```

   前后端分离部署（`compose.split.yaml`）将服务名 `app` 替换为 `api`。非 Docker 部署在项目目录运行 `npm run reset:password`，并使用与服务相同的 `DATA_DIR` / `DB_PATH` 环境变量。默认数据库为 `data/db/wangke.sqlite`；脚本不会自动读取 `.env`。

密码必须为 12–256 位。重设只更新密码哈希，撤销全部旧浏览器会话、设备令牌、配对码和未完成的 Passkey 验证；课程、文件、模型配置及已绑定的 Passkey 均保留，所有设备需重新登录。重设后无需重启服务。

密码使用 Argon2id 哈希保存，无法从配置或数据库找回明文。无需删除数据库，也不要重新开放初始化入口。没有服务器权限时请联系部署管理员；不提供无需身份验证的网页重置入口。建议初始化后绑定 Passkey，并将密码保存至密码管理器。

## 重置云端数据

已登录管理员可在“设置 → 数据 → 重置云端数据”中输入当前访问密码，确认后清空课程、学习记录、聊天、文件、模型配置、Bot 项目、任务、Passkey 和全部登录凭据，并回到首次初始化页面。部署目录、数据库结构和服务器配置不会删除；重置后会生成新的 bootstrap 密钥，旧会话立即失效。此操作不可撤销。

## 运行资源

镜像包含 FFmpeg，但不包含 Chromium。任务调度按类型分流：模型、聊天、问答和文本任务直接在 Node 执行，视频封面使用 FFmpeg 子进程；视频/音频解码、PDF 预览和 UI 依赖任务由已认证的外部浏览器 Worker 执行。默认同时计算 2 个任务（`CLOUD_CONCURRENCY=1..4`），等待审批也占用内存。原文件与产物保存在 `/data`。分流清单与 Worker 认证方式见 [任务执行架构](task-execution.md) 和 [外部浏览器 Worker](browser-worker.md)。

非 Docker 启动时先安装系统 FFmpeg（可用 `FFMPEG_PATH` 指定路径），然后 `npm run build && npm start`。需要浏览器任务时，在外部已登录浏览器打开 `/?cloud-worker=1`；开发/E2E 仍可单独安装 Playwright。开发 API 前先运行 `npm run build:api`。

## 额外的公网 IP HTTPS 入口

已有域名部署可在 `.env` 中增加 `PUBLIC_IP=服务器公网IPv4`，并启用 IP 覆盖文件：

```sh
docker compose --env-file .env -f compose.yaml -f compose.prod.yaml -f compose.ip.yaml up -d --no-build --wait
```

之后通过 `https://公网IP/` 访问，使用访问密码登录。保留原 `PUBLIC_ORIGIN`、`WEBAUTHN_RP_ID` 和数据卷；覆盖文件只将 IP 的完整 HTTPS origin 加入允许列表，不关闭 CSRF 校验，Cookie 仍为 Secure。原域名的 Passkey 不能在 IP 页面使用，请使用密码；域名入口和已有 Passkey 不受配置变更影响。后续更新、重启也需带上 `-f compose.ip.yaml`。

Caddy 为 IP 单独申请 Let's Encrypt `shortlived` 公信证书（有效期 160 小时），并自动续期；必须持续开放公网 TCP 80（HTTP-01 验证）和 443，并保留 `caddy_data` 卷。默认使用正式 CA；验证部署时可临时设置 `IP_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory`，测试证书不受浏览器信任，验收后务必删掉该设置并重新创建代理容器。不要以忽略证书错误作为正式访问方式。

IP 入口不免除境内云资源的备案及接入要求；若云平台仍然拦截，应按其要求处理，或迁移到合适的服务器。

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
