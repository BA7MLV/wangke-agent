# 部署

后端是一个独立的 API 服务，负责数据、文件、Bot 运行和鉴权。前端有三种「壳」，各自直接登录这个 API：

| 壳 | 怎么登录 | 怎么连 API |
|---|---|---|
| 浏览器 | 密码或 Passkey，拿到 HttpOnly Cookie | 同源（默认）或跨域（`API_BASE_URL` + `CORS_ORIGINS`） |
| iOS | 密码，`POST /api/v1/auth/token` 换 Bearer token，存在钥匙串 | 直接请求 API 地址 |
| macOS（预留） | 同 iOS，共用 `apps/apple/WangkeKit` | 同 iOS |

## 三种部署形态

### 1. 一体化（默认）

一个容器同时提供 API 和前端，最省事：

```bash
./install.sh                       # 本机 / 局域网
./install.sh --domain agent.example.com   # 公网 HTTPS（Caddy 自动证书）
```

或者手动：

```bash
docker compose up -d --build
docker compose -f compose.yaml -f compose.prod.yaml up -d --build   # 带 HTTPS
```

### 2. 前后端分离，同源

`api` 容器只跑 API（`SERVE_WEB=false`），`web` 容器用 Caddy 提供前端，并把 `/api/*` 反代给 `api`。浏览器看到的是同一个 origin，Cookie 登录开箱即用。

```bash
cp .env.example .env    # 按需修改
docker compose --env-file .env -f compose.split.yaml up -d --build
```

- 浏览器访问 `http://服务器:8080`。
- `api` 默认只绑定 `127.0.0.1:3000`。iOS / macOS 壳层要直连时，把 `API_BIND_HOST` 改成 `0.0.0.0`，或者让它们也走 `http(s)://web 地址/api`（同样可用）。
- 公网部署时在 `web` 前面再放一层 HTTPS（Caddy / Nginx / 云负载均衡），并把 `PUBLIC_ORIGIN`、`WEBAUTHN_RP_ID` 设成对外的 https 地址和域名。

### 3. 前后端分离，跨域

前端和 API 在不同域名（比如前端放 CDN，`app.example.com`；API 在 `api.example.com`）：

| 变量 | 设在哪 | 值 |
|---|---|---|
| `API_BASE_URL` | web 容器 | `https://api.example.com` |
| `API_UPSTREAM` | web 容器 | 空字符串（关闭反代） |
| `CORS_ORIGINS` | api 容器 | `https://app.example.com`（多个用逗号分隔） |
| `COOKIE_SAMESITE` | api 容器 | 同一注册域的子域名保持 `lax`；完全不同的域名设 `none`（要求 https） |
| `PUBLIC_ORIGIN` | api 容器 | 浏览器前端的 origin（Passkey 校验用） |

前端不是用这个 web 镜像，而是自己构建静态文件时，也可以在构建期设 `VITE_API_BASE_URL`，或者部署后改 `dist/config.js`：

```js
window.__WANGKE_CONFIG__ = { apiBaseUrl: "https://api.example.com" };
```

> 跨域模式下浏览器第三方 Cookie 的限制越来越严（Safari 默认拦截跨站 Cookie）。能同源就同源；跨域时尽量让前端和 API 是同一个注册域下的子域名（`app.example.com` / `api.example.com`），这样 `SameSite=Lax` 就够了。

## 环境变量（新增的部分）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CORS_ORIGINS` | 空 | 允许跨域访问 API 的浏览器 origin，逗号分隔。原生壳层不需要 |
| `COOKIE_SAMESITE` | `lax` | `lax` / `strict` / `none`。`none` 只在 `PUBLIC_ORIGIN` 是 https 时生效 |
| `SERVE_WEB` | `true` | `false` 时 API 不托管前端静态文件 |
| `TOKEN_TTL_MS` | 90 天 | `/auth/token` 发出的 Bearer token 有效期 |
| `API_BASE_URL` | 空 | web 容器：浏览器请求 API 的地址，空表示同源 |
| `API_UPSTREAM` | `api:3000` | web 容器：`/api/*` 反代目标，设为空字符串关闭 |

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
