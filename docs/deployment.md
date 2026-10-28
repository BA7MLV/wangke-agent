# 部署

后端是一个独立的 API 服务，负责数据、文件、Bot 运行和鉴权。前端有三种「壳」，各自直接登录这个 API：

| 壳 | 怎么登录 | 怎么连 API |
|---|---|---|
| 浏览器 | 密码或 Passkey，拿到 HttpOnly Cookie | 同源（默认）或跨域（`API_BASE_URL` + `CORS_ORIGINS`） |
| iOS | 密码，`POST /api/v1/auth/token` 换 Bearer token，存在钥匙串 | 直接请求 API 地址 |
| macOS（预留） | 同 iOS，共用 `apps/apple/WangkeKit` | 同 iOS |

## 当前验收状态

源码/依赖独立构建已验证；恢复点、单实例替换/失败恢复和发布 CI 已有代码及本地故障测试。Linux Docker 镜像运行、目标仓库可达性、真实更新/回退和停机测量仍未验收，CI 未远端运行、制品未推送。不要将代码完成当成生产切换指令。详见 [实施记录](separation-progress.md)。

## 默认严格分离，同源

稳定 Caddy `proxy` 将 `/api/*` 直达 API，其余交给静态 Web。API 永不托管页面。Web-only 更新不重启 API 或 proxy，旧哈希资源保留在 `web_assets` 卷中。

先配置可达的、已发布的 `WANGKE_API_IMAGE` / `WANGKE_WEB_IMAGE`，推荐不可变 digest。本仓库尚未发布这些制品。安装默认拉镜像：

```bash
./install.sh                       # 本机 / 局域网
./install.sh --domain agent.example.com   # 公网 HTTPS（Caddy 自动证书）
```

或者手动：

```bash
docker compose pull
docker compose up -d --no-build --wait
docker compose -f compose.yaml -f compose.prod.yaml up -d --no-build --wait   # 带 HTTPS
```

### 显式源码构建

用于开发或离线场景；不作为服务器日常更新默认方式：

```bash
./install.sh --build-from-source
# 或
docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait
```

- 默认浏览器访问 `http://服务器:3000`（`PORT` 可配置）。API/Web 不直接发布主机端口。原生客户端使用相同入口的 `/api/v1/*`。
- `compose.split.yaml` 兼容包含默认拓扑，不是另一套实现。
- 公网叠加 `compose.prod.yaml` 或 `compose.ip.yaml`，沙盒叠加 `compose.agent.yaml`；源码构建沙盒还需 `compose.agent.build.yaml`。
- 已有旧 `app` 容器须受控迁移，禁止与新 API 同时访问同一 SQLite/IM 账号。安装脚本检测到运行中的旧实例会拒绝启动。

### 更新范围

未纳入清单管理的安装仍可用 `wangke-agent update web`，只拉取并替换 Web，失败尝试回退上一容器 image ID；隐式 API/full 更新仍拒绝。不要删除 `web_assets` 卷。纳入清单管理后必须使用下文的 `--manifest`，不能绕过成功部署基线。

API 进程收到 `SIGTERM` / `SIGINT` 时先进入单向 drain，再关闭 HTTP：`/api/v1/ready` 返回 503，`/api/v1/health` 仍表示进程存活；拒绝新的外部写入和浏览器任务领取，停止 Bot/原生调度与 IM/记忆后台输入。在途的、任务限定的 Worker token 仍可按原有权限回写。默认自然收尾期限 30 秒，随后中断未结束的本地执行并等待关闭；总关闭超时非零退出，由重启恢复处理未完成状态。默认 Compose 给出 65 秒停机宽限，不要把它缩回 Docker 默认的 10 秒。

`drainForRelease()` 本身仍不是一致快照：它仅负责本地收尾，不能据此在线复制数据或启动第二个 API。下文的发布事务额外关闭旧 API、停止 broker/本安装的可写沙盒、检查无其他容器写入、撤销旧浏览器租约，然后使用 SQLite Backup API 封存数据库与文件。主机管理员必须保证没有宿主机进程、定时任务或另一台机器同时修改数据目录；发现未知容器写者会拒绝继续，不会擅自杀掉它。直接调用 Fastify `close()` 不提供自然收尾窗口。

### 不可变清单发布（已完成限定范围隔离 Linux 实测，非生产认证）

管理主机需要**已有 Node.js 22+** 和 Docker Compose；命令不会自动安装它们。数据必须是当前安装下 `data` 的 bind mount、默认容器路径，管理用户 UID/GID 须与 API 相同，不支持本事务管理 named-volume/嵌套外置数据挂载/外部写者；预检查也会核对实际运行容器而不仅是 Compose 文本。首次把旧 `app` 迁入分离拓扑须另行受控停机，不能直接 adopt 旧一体镜像。

1. 先在已授权的测试环境构建/运行分离镜像并完成 Linux 验收，明确仓库及目标架构；当前 CI 为 `linux/amd64`。仓库连通性和下载耗时要从目标主机实测。
2. 已运行的 API/Web 镜像必须与首次清单的 digest 完全一致，API 镜像必须包含 maintenance 和数据库 identity。`release-adopt` 检查运行镜像、readiness 和实际 DB schema 后才登记基线，不替换容器。没有这些能力的历史镜像不能被假冒成可回退基线。
3. `release.yml` 仅手动触发，输入目标安装的 `releases/last-success.json` 原文和镜像仓库前缀。基线缺失/不可用或未知输入则全量构建。默认 `publish=false` 只构建，**没有可部署清单**；发布需显式选中 publish、仓库变量 `RELEASE_PUBLISH_ENABLED=true`，并按仓库策略批准 `release-artifacts` environment。自定义 registry 使用 `RELEASE_REGISTRY_USER` / `RELEASE_REGISTRY_TOKEN`。必须由仓库管理员配置 environment 审批规则，代码不会替代审批设置。
4. 每个服务独立 BuildKit GHA cache scope；可选 `TURBO_TOKEN` secret / `TURBO_TEAM` variable 启用验证任务的远程 Turbo 缓存，无需新建常驻服务。CI 汇集本次 run/attempt 的 digest 及 API 镜像内 DB metadata；未变化服务保留其原始提交。产物 `candidate-manifest-*` **不代表已经部署**，不会 SSH、切换生产或提升部署基线。

隔离 VPS 已使用合成清单、本地精确 digest 实测 adopt/update/backup/rollback/restore；生产没有执行。范围、故障证据、资源限制和未覆盖项见 [隔离验收报告](separation-vps-acceptance.md)。下面是实际安装的用法示例：

```bash
# 在已经运行正确镜像且验收完成后，一次性登记
wangke-agent release-adopt initial-manifest.json
# 用目标主机 last-success.json 作为 CI 输入生成下一次候选清单
wangke-agent update web --manifest candidate.json
wangke-agent update api --manifest candidate.json
wangke-agent update full --manifest candidate.json
# 显式离线运输：先加载受信任 OCI 制品，精确 repository digest 必须已在 daemon 中
# 缺失即失败，不拉取、不回退可变标签；这不是 registry pull 验收
wangke-agent --preloaded update web --manifest candidate.json
wangke-agent release-recover      # 进程崩溃/网络中断后重入同一事务
wangke-agent backup               # 返回校验过的恢复点目录，不在切换窗口压缩全量归档
wangke-agent rollback             # 只允许相同 DB identity/schema 的上一成功版本
wangke-agent restore-release /path/to/releases/points/ID --allow-data-loss
```

数据恢复命令会丢弃恢复点之后的业务变更，必须明确授权 `--allow-data-loss`。它先为当前版本另建恢复点，保留失败数据目录，再恢复选定点的 DB、文件、配置/密钥和配套镜像；不会把不兼容的旧二进制直接指向已迁移 DB。普通 rollback 若 DB identity/schema 不同会拒绝，要求选择专门恢复流程。

事务顺序：停机前 pull/核对制品并预复制；旧 API drain/停止、broker/沙盒写入屏障；最后增量复制，撤销持久浏览器租约和旧审批，SQLite Backup/完整性与 SHA-256 inventory 校验；新 API 以 staged 模式迁移启动，不接收业务读写、不运行调度/IM；本机鉴权检查后才激活。旧进程内 Worker bearer token 不跨重启；旧 browser attempt 排队重领，原生 running/waiting_user 中断。稳定入口不替换，Web-only 不走停 API/快照路径。事务记录和命令输出包含阶段时间线；外部探针的实际不可用时长仍须在 Linux 演练中测量，不能拿阶段时间或本地单测耗时冒充。

`releases/transaction.json` 记录持久阶段，`deployment-images.json` 保存受保护的 digest override。**激活意图落盘前**失败可恢复 DB/文件并启动上一实例；**激活请求发出后**即便回执丢失，也可能已接收新写入，只允许 `release-recover` 向前恢复，不自动倒灌旧快照。恢复点损坏/恢复验证失败时保持离线，保留现场，不盲目启动旧程序。锁与未完成事务阻止另一次更新和 start/restart。

只有目标真实 readiness/运行镜像确认后才原子写 `releases/last-success.json` 和 `previous-success.json`。候选清单必须同时匹配上一成功的 sourceCommit **及完整清单摘要**，同一提交不同镜像或回退后的过期候选也会拒绝。下一次 CI 使用这个实际成功文件，不能用最近构建、HEAD^ 或候选清单替代。恢复点含账号密钥，应离机加密保存，限制目录权限，勿上传为 CI artifact；尚无自动清理策略，需监控磁盘空间。

已纳管安装再次运行 `install.sh` 会拒绝隐式切换；`--no-start` 只刷新管理代码，保留配置和基线，不调用 Docker。源码构建模式不能充当不可变发布输入。旧 backup/restore 脚本也不能绕过已纳管事务。

## 跨域部署

前端和 API 在不同域名（比如前端放 CDN，`app.example.com`；API 在 `api.example.com`）：

| 变量 | 设在哪 | 值 |
|---|---|---|
| `API_BASE_URL` | web 容器 | `https://api.example.com` |
| `CORS_ORIGINS` | api 容器 | `https://app.example.com`（多个用逗号分隔） |
| `COOKIE_SAMESITE` | api 容器 | 同一注册域的子域名保持 `lax`；完全不同的域名设 `none`（要求 https） |
| `PUBLIC_ORIGIN` | api 容器 | 浏览器前端的 origin（Passkey 校验用） |

前端不是用这个 web 镜像，而是自己构建静态文件时，也可以在构建期设 `VITE_API_BASE_URL`，或者部署后改 `apps/web/dist/config.js`：

```js
window.__WANGKE_CONFIG__ = { apiBaseUrl: "https://api.example.com" };
```

> 跨域模式下浏览器第三方 Cookie 的限制越来越严（Safari 默认拦截跨站 Cookie）。能同源就同源；跨域时尽量让前端和 API 是同一个注册域下的子域名（`app.example.com` / `api.example.com`），这样 `SameSite=Lax` 就够了。

## 环境变量（新增的部分）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CORS_ORIGINS` | 空 | 允许跨域访问 API 的浏览器 origin，逗号分隔。原生壳层不需要 |
| `COOKIE_SAMESITE` | `lax` | `lax` / `strict` / `none`。`none` 只在 `PUBLIC_ORIGIN` 是 https 时生效 |
| `TOKEN_TTL_MS` | 90 天 | `/auth/token` 发出的 Bearer token 有效期 |
| `API_BASE_URL` | 空 | web 容器：浏览器请求 API 的地址，空表示同源 |
| `WANGKE_API_IMAGE` | 本地源码构建标签 | API 独立镜像，生产必须指定已发布制品 |
| `WANGKE_WEB_IMAGE` | 本地源码构建标签 | Web 独立镜像，生产必须指定已发布制品 |

其余变量见 `.env.example`。

## 原生壳层的鉴权接口

```http
POST /api/v1/auth/token
Content-Type: application/json

{ "password": "…", "deviceName": "Mirai 的 iPhone" }
```

```json
{ "token": "…", "tokenId": "…", "tokenType": "Bearer", "expiresAt": "2027-01-22T…", "user": { "id": "…", "name": "Administrator" } }
```

之后每个请求带 `Authorization: Bearer <token>`。退出登录：带着同一个头 `POST /api/v1/auth/logout`，token 立刻失效。

浏览器管理员可在已登录 Cookie 下调用 `POST /api/v1/account/reset`，提交 `{ "password": "…" }`。密码验证成功后会清空整套云端数据、撤销全部凭据并返回新的 `bootstrapSecret`；这是不可逆的首次初始化重置，不应暴露给未授权调用方。

- token 只在这次响应里出现一次，数据库只存 SHA-256 哈希。
- 密码错误和浏览器登录共用同一套按 IP 的退避。
- 带 Bearer、不带 Cookie 的写请求不做 Origin 校验（浏览器不会自动附带 Authorization 头，不存在 CSRF）。
- 已有的「扫码配对」（`/api/v1/pairing/*`）仍然可用，适合不想在手机上输密码的场景。

## 这次修掉的部署问题

- **`wangke-agent update/restart` 会丢掉 HTTPS 入口**：管理脚本只认 `compose.yaml` 和 `compose.agent.yaml`，按 README 用 `compose.prod.yaml` 起了 Caddy 之后，第一次 `update` 就不再带它。现在 `install.sh --domain` 会在 `.env` 里记下 `DOMAIN`，管理脚本看到它就一直带上 `compose.prod.yaml`。
- **macOS 自带的 bash 3.2 上 `install.sh` 直接报错**：`set -u` 下展开空数组 `"${EXTRA[@]}"` 会报 unbound variable。改成 `${EXTRA[@]+"${EXTRA[@]}"}`。
- **Bot 事件流经 Caddy 时卡住**：生产 Caddyfile 对所有 `text/*` 开了压缩，`text/event-stream` 被压缩器攒着不发。现在只压缩静态资源和 JSON，并给反代加了 `flush_interval -1`。
- **README 的公网命令跑不起来**：续行符写成了 `\\`，复制到终端会在第一行就断掉。
- **`.env.example` 和实际默认值不一致**：`MAX_FILE_BYTES` 写的是 50 MiB，`compose.yaml` 和 `install.sh` 都是 512 MiB。
- **管理脚本 `update` 判断是否构建沙盒镜像的条件**：原来看 `EXTRA` 是否为空，加了 prod 文件后会误判，改成直接看 `.env` 里有没有 `SANDBOX_TOKEN`。
