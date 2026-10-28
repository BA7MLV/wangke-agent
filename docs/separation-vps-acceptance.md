# 隔离 VPS 验收报告（2026-10-28）

本记录不授权生产切换、git push、远端镜像发布或 Actions 执行。

## 隔离与基线

- 已校验 SSH 已知主机身份：`VM-4-2-ubuntu`，Ubuntu 用户 UID/GID 1000，Linux x86_64，Docker 29.1.3。
- 生产容器 `wangke-agent-app-1` / `wangke-agent-proxy-1`，初始 ID 分别为 `6ada97e22319` / `62be21911301`；HTTPS health 初始 200。
- 只读核对生产挂载路径，未复制生产数据库、环境、模型/IM 凭据或证书。
- 独立目录：`/home/ubuntu/.local/state/wangke-separation-check.zz0Q2B95`。
- 独立构建器：`wk-check-zz0q2b95`，CPU quota 1 核、内存 1600 MiB、swap 总限额 2 GiB、构建并行度 1。测试 Compose project 使用 `wk-check-zz0q2b95`，端口仅动态绑定 `127.0.0.1`。
- 初始主机：4 核、3718 MiB RAM，可用 2244 MiB、磁盘剩余 13 GiB；未清理任何既有镜像、缓存、卷或网络。
- 首次源码包：1308 文件，18,471,592 字节，SHA-256 `32b057e31a3fec7444a2610509a4570898482d530703c80c55b2d5aa98f0fbee`。包含当前未提交必要源码与锁文件，排除 `.key`、`.env`、数据、node_modules、dist、.git 和测试产物。后续修复单独同步，远端最终 1314 项源码/验收文件指纹保存在证据包 `logs/source-file-sha256.json`；这不是某一干净 Git commit 的发布制品。
- 宿主没有 Node；从现有 Node 22 镜像取出临时二进制到本次目录，未安装系统软件。

## 已发现的环境约束

- 原样构建在 Dockerfile frontend 下载阶段失败：`registry-1.docker.io` 连接超时。未声称 registry pull 成功。
- 为继续隔离验证，导出现有 Node/Caddy 基础镜像为本地 OCI context，使用 BuildKit 内置 frontend（测试用 Dockerfile 去掉 syntax 下载注释），并通过显式 `DEBIAN_MIRROR` 使用已有可达腾讯 Debian 镜像。API 从源码按独立 Dockerfile 构建，不复用生产应用源码或数据。
- `raw.githubusercontent.com` 四次请求均超时；改用 GitHub API，只读精确校验 login-action、setup-buildx-action、build-push-action、upload-artifact 的固定 commit，四项均 HTTP 200 且 SHA 完全一致。**这不代表 Actions 已运行**。
- 新增显式 `--preloaded` 运输模式：只允许 Docker daemon 本地解析清单的精确 repository digest，缺失即失败，不回退可变 tag、不假冒 registry pull。验收使用 API VPS 源码构建、Web 本机静态构建/VPS 运行镜像构建及本地 OCI 加载，不向任何 registry 发布。
- Web VPS 全源码构建完成干净裁剪、npm ci、i18n 和 TypeScript，但 Vite 在 chunk rendering 阶段于 1600 MiB 上限发生严重换页。明确状态核查时仍有进程、约 80 分钟、累计约 632 GB block read、没有 Web 镜像。主动停止**自己的**构建器，未增加资源、未重启生产；没有将“仍运行”误记为成功。此前等待完成通知不等于完成验收。
- 改用成功的 `npm run build:web` 本机静态制品，VPS 仅构建与正式 Web 镜像一致的 Caddy/entrypoint 运行层。静态包 16,356,376 bytes，SHA-256 `65da58b002b2a3d5a65afd3a90d4239849cf29c88e5ddb5a333d24f8c7a75db1`。验收专用 Dockerfile/allowlist 在 `scripts/fixtures/vps-web-artifact.Dockerfile*`，不替代正式全源码 Dockerfile。

## 结果与清理

**本轮可推进的隔离运行/发布/恢复测试已完成，最终脚本退出码 0；不等于全部严格分离计划或生产切换验收已完成。**

### 已确认的真实证据

- API Dockerfile 首次执行到最终层发现 Node 基础镜像已占用 UID/GID 1000，原 `groupadd` 会失败；已复用现有非 root `node` 用户并成功重建。
- API 最终镜像 ID / 本地 repository digest：`sha256:cce69da04d473e16e6b5a72a682a3c5a8abab06bfd61f87361199f1f5f860cbf`，Docker inspect 大小 300,037,513 bytes（未压缩逻辑大小，不是 registry 传输量）。
- 独立真实 Linux 容器：SQLite 查询、Argon2 hash/verify、FFmpeg 可执行，默认 UID 1000；没有 Web 源码、React/React DOM/Vite/TypeScript、g++、make。
- 同一 API 最终镜像执行实际 `runMediaProcess`：FFmpeg 从 lavfi 生成并验证 PNG，60 秒音频进程在 AbortSignal 后约 576 ms 收尾；这是 Linux 媒体执行/取消证据，尚不等于业务任务跨版本 drain 的全部验收。
- GitHub API 追加核验 checkout/setup-node，至此两个工作流使用的六个独立 Actions SHA 均精确匹配。raw 下载仍不可达，CI 未实际执行。
- GHCR `/v2/` 返回预期未认证 401，连接 0.152 秒、总计 0.591 秒；只证明鉴权入口可达，不证明制品 pull、认证配置或吞吐。
- 新增验收脚本构造的是**同源码合成版本**：API 标签变更、Web 资源增量及故意破坏 DB/文件的失败 CMD。用于真实容器发布/恢复故障注入，不等于历史版本客户端兼容；本地免费 SSE fixture 不调用真实付费模型。
- Web 的 `sw.js` 由 VitePWA 构建插件生成，并非 public 手写文件。实际 JavaScript MIME、service worker 注册/ready、旧页和运行中 Blob Worker 跨 Web 替换、页面刷新及手机尺寸页面均由真实 Chromium 通过 SSH localhost 隧道验证；未把 SPA fallback 当作 service worker。
- 最终本地回归：21 项恢复/适配器故障测试、真实 HTTP staged 激活/Worker fencing、16 项安装/更新测试通过；其中新增 `--preloaded` 不得在旧标签更新路径静默拉取的拒绝测试。

### 实机发现及修复

1. API 基础镜像重复创建 UID/GID 1000：复用非 root `node` 用户，Linux 构建及启动通过。
2. Alpine BusyBox `cp -an /opt/web-assets/. /srv/assets/` 跳过已存在目标目录，新 chunk 未进入持久卷：改为逐目录建立、逐文件只追加。真实原故障为旧资源证明文件 404；修复后卷更新、嵌套文件追加、已有文件不覆盖均通过。这不是仅修改测试断言。
3. 初版破坏性测试的 `DELETE users` 被 SQLite 外键保护提前拦截，未到文件改写；虽然旧镜像恢复成功，不能据此声称 DB+文件破坏恢复。改为真实改写用户测试名称/新增表/覆盖上传字节，sidecar 回执证明破坏完成后才故意退出；最终演练验证名称、表和文件全部恢复。

### 最终真实容器结果

- 独立 API/Web 最终镜像无跨端源码/运行依赖；API 真实原生模块及 FFmpeg 通过。Web 最终运行镜像 `sha256:2d832ae912a5a44dfcbb528f9db5d50aab703a97ca279bdff16b35fab60133bf`，43,600,654 bytes；同源码合成变体另有清单 digest。
- Caddy 同源 `/api/*` 路由、未知 API/缺失 chunk 404、COOP/COEP、运行时 config.js、Cookie 登录、native token HTTP 契约、1 MiB 上传/Range/4 MiB 上限通过。
- Web-only：只重建 Web，没有数据快照，API/edge 容器 ID 不变；**同一个流 reader**跨替换持续接收真实 Caddy→API→免费本地 SSE fixture 数据，浏览器任务 lease/report 继续有效，旧/新 chunk 均可读取。
- API-only：实际 drain/停旧实例、停止本安装带标签的可写沙盒证明容器、封存快照、staged 503 拒绝业务访问、本机控制激活，成功后才提升 baseline。旧 browser token 403，任务回到 queued。沙盒证明容器是实际持续写入的容器，不代表完整 sandbox/broker 产品组合已验收。
- 另起**实时** Docker events 订阅观察一次 API-only 更新和兼容回退：两次均 `die → destroy → start`，并行运行 API 峰值 1。保留事件后缀另有标注，不将有限历史缓存冒充完整事件记录。
- 真实错误镜像破坏 DB+文件后启动失败：恢复点还原二者，前一镜像就绪、baseline 不前移；过期候选被拒绝。
- 兼容 rollback、写者协调 backup、显式 `restore --allow-data-loss` 均成功。恢复点之后上传的 DB 行及文件一起移除，点之前上传和登录状态保留；API 重启后文件仍可下载。
- 最终检查 7 个已封存恢复点 inventory/schema 完整性全部通过；只带回统计和公开镜像/迁移信息，测试数据库/密钥/恢复点本身已销毁。

### 耗时（本次限额、同源码合成版本、单次测量）

- API 修复后的缓存重试构建+load：46 s，**不是冷构建**；初次尝试失败和日志保留。
- Web 静态制品→VPS 运行镜像构建+load：首次 5 s、entrypoint 修复缓存重试 2 s，**不是 VPS Web 全源码构建或 registry pull**。
- 清单 adopt：2.495 s；Web-only 更新：6.160 s。
- API 正常替换：入口 readiness 约每 100 ms 采样，观察不可用跨度约 16.4 s，相邻成功样本界定约 16.303–16.511 s。样本包括真实 502 和 staged 503；不是零停机，也不是全网端到端 SLA。
- 故意破坏镜像失败并恢复旧版本：89.025 s；兼容 rollback：9.359 s；协调 backup：7.485 s；显式 restore：8.867 s。正常 API 更新的完整阶段见真实事务时间线。
- 最终主验收脚本共 161.642 s，另有浏览器及额外单实例观测。没有 CI 冷热构建/远程缓存或 registry 吞吐测量。

## 清理与生产复核

- 本次 Compose 容器、写者证明容器、网络、`web_assets` 卷、独立 builder/缓存及本次镜像（包括已知失效变体）已删除；四项 residual 清单均为空。未用全局 prune，未清理既有资源。
- 本次安装、测试账号/DB/上传、恢复点、临时 Node、源码/OCI/静态包和测试凭据均销毁；远端仅保留脱敏日志及证据包。SSH localhost 隧道已关闭。
- 生产 app/edge 的 ID、image、StartedAt、RestartCount 均前后相同；app 启动时间仍为 `2026-10-28T01:03:46.951204852Z`，edge 为 `2026-10-27T06:33:35.891092748Z`，RestartCount 均 0。TLS 校验开启的生产 HTTPS health 最终 200。
- 清理容器/缓存后磁盘剩余 12 GiB、可用内存约 2248 MiB；随后删除源包/OCI/测试目录，最终磁盘剩余恢复到 13 GiB，宿主只剩原来两个生产容器。不改生产 .env/Caddy/证书或任何公网端口。

## 未覆盖项 / 明确边界

- 1600 MiB 上限下 Web 全源码 Linux 构建未完成；继续需要更合适的已有构建环境或另行批准的资源选择。不可把本机 Web 静态构建/VPS runtime 镜像称为该项通过。
- Actions 未运行、镜像未向 registry 发布/拉取，无真实远端 cache 命中或目标主机 registry 吞吐证据；固定 SHA 校验和 401 连通性不能替代这些。
- 合成版本没有覆盖历史客户端/Worker 跨协议升级、原生真机、Passkey 安全硬件、PWA 安装/离线升级全生命周期；浏览器不替代原生设备。
- 未接真实 IM/付费模型；没有完整长时 native/Bot/IM 跨发布 drain/reconnect 或完整 sandbox/broker 组合实测。已有本地相关回归及 Linux FFmpeg 取消与 browser lease 证据分别记录，不冒充这些场景。
- 本轮入口是 localhost HTTP+SSH 隧道，不改生产 HTTPS。没有独立签发测试证书、实测域名/IP TLS 迁移或执行历史一体 `app` 的首次生产切换。
- 未提交、推送、触发 CI、发布远端制品或生产切换；后三项计划中的剩余验收约束仍保留。

## 可复查证据

- `docs/evidence/separation-vps-2026-10-28/evidence.tar.gz`：58 份远端日志/receipt/指纹，SHA-256 `7058a6c19110bc1523f4c3f17994742e7aded704b7c77ba29d0003eace76ce27`；已扫描本次持久测试密钥并脱敏，无生产数据库或凭据。
- 同目录 `browser-result.json`、`local-web-build.log`、`local-release-regression.log`、`local-install-regression.log`：真实 Chromium、本机构建与最终本地回归结果。
- 归档关键项：`logs/acceptance.json`（逐点 readiness 样本）、`runtime-acceptance.log`、`api-single-instance-live.json`、`sealed-point-evidence.json`、`cleanup*.txt`/`cleanup.log`、`production-*-cleanup.txt`、`production-final-health.txt`。前两次未完成尝试分别保留于 `attempt-1/` 和 `attempt-2/`，不得与最终退出码 0 混淆。
