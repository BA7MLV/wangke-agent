#!/usr/bin/env bash
set -euo pipefail

VERSION="0.1.0"
VERSION_SET=0
DATA_DIR="${WANGKE_DATA_DIR:-$HOME/.wangke-agent}"
PORT="${WANGKE_PORT:-3000}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NO_START=0
AGENT=0
BUILD_FROM_SOURCE=0
MAX_FILE_MB=""
PUBLIC_URL=""
DOMAIN=""
usage() { echo "Usage: ./install.sh [--data-dir DIR] [--port PORT] [--public-url https://host] [--domain host] [--max-file-mb 1..512] [--agent] [--version VERSION] [--build-from-source] [--no-start]"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || { echo "--version requires a value" >&2; exit 2; }; VERSION="$2"; VERSION_SET=1; shift 2 ;;
    --data-dir) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; DATA_DIR="$2"; shift 2 ;;
    --port) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; PORT="$2"; shift 2 ;;
    --max-file-mb) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; MAX_FILE_MB="$2"; shift 2 ;;
    --public-url) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; PUBLIC_URL="${2%/}"; shift 2 ;;
    --domain) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; DOMAIN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --no-start) NO_START=1; shift ;;
    --agent) AGENT=1; shift ;;
    --build-from-source) BUILD_FROM_SOURCE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
install_management() {
  mkdir -p "$DATA_DIR/bin/lib"
  sed "s|__DEFAULT_COMPOSE_FILE__|$SCRIPT_DIR/compose.yaml|" "$SCRIPT_DIR/scripts/wangke-agent" > "$DATA_DIR/bin/wangke-agent"
  chmod 700 "$DATA_DIR/bin/wangke-agent"
  cp -f "$SCRIPT_DIR/scripts/backup.sh" "$SCRIPT_DIR/scripts/restore.sh" "$SCRIPT_DIR/scripts/release-deploy.mjs" "$SCRIPT_DIR/scripts/release-plan.mjs" "$DATA_DIR/bin/"
  cp -f "$SCRIPT_DIR/scripts/lib/release-storage.mjs" "$SCRIPT_DIR/scripts/lib/release-transaction.mjs" "$SCRIPT_DIR/scripts/lib/release-docker.mjs" "$DATA_DIR/bin/lib/"
  chmod 700 "$DATA_DIR/bin/backup.sh" "$DATA_DIR/bin/restore.sh"
}
if [ -f "$DATA_DIR/releases/last-success.json" ]; then
  if [ "$NO_START" -ne 1 ]; then
    echo "Installation is managed by immutable release manifests. Use wangke-agent update --manifest, or --no-start to refresh management scripts only." >&2; exit 2
  fi
  [ ! -e "$DATA_DIR/releases/release.lock" ] || { echo "Release is locked; do not replace management scripts during a transaction." >&2; exit 2; }
  install_management
  echo "Management scripts refreshed only; configuration, baseline and containers were not changed."
  exit 0
fi
INSTALL_STEP=0
INSTALL_COMPLETED=0
INSTALL_TOTAL=7
if [ "$NO_START" -eq 1 ]; then INSTALL_TOTAL=4; fi
INSTALL_STAGE="准备安装"
INSTALL_STARTED=$SECONDS
STEP_STARTED=$SECONDS
step() {
  INSTALL_STEP=$((INSTALL_STEP + 1))
  INSTALL_STAGE="$1"
  STEP_STARTED=$SECONDS
  printf '\n[%s] [%s%%] [%s/%s] %s…\n' "$(date '+%H:%M:%S')" "$((INSTALL_COMPLETED * 100 / INSTALL_TOTAL))" "$INSTALL_STEP" "$INSTALL_TOTAL" "$INSTALL_STAGE"
}
step_done() {
  INSTALL_COMPLETED=$INSTALL_STEP
  printf '[%s] [%s%%] [%s/%s] 完成：%s（耗时 %ss）\n' "$(date '+%H:%M:%S')" "$((INSTALL_COMPLETED * 100 / INSTALL_TOTAL))" "$INSTALL_STEP" "$INSTALL_TOTAL" "$INSTALL_STAGE" "$((SECONDS - STEP_STARTED))"
}
install_exit() {
  local status=$1
  if [ "$status" -ne 0 ]; then
    printf '\n[%s] [%s%%] 安装未完成：停在 [%s/%s] %s（退出码 %s，累计 %ss）。\n请先处理上方错误，再重新运行安装命令。\n' "$(date '+%H:%M:%S')" "$((INSTALL_COMPLETED * 100 / INSTALL_TOTAL))" "$INSTALL_STEP" "$INSTALL_TOTAL" "$INSTALL_STAGE" "$status" "$((SECONDS - INSTALL_STARTED))" >&2
  fi
}
trap 'install_exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "进度按已完成步骤计算，不代表耗时比例；构建期间请查看 Docker 实时日志。"
if [ "$NO_START" -eq 1 ]; then echo "--no-start：百分比仅表示安装准备进度，不包含构建与启动。"; fi
step "检查安装参数与运行环境"
if [ -n "$DOMAIN" ]; then
  # --domain 等于「用 Caddy 自动 HTTPS 对外服务」：公网地址固定为 https://域名，
  # 应用端口只绑本机，避免绕过 HTTPS 直接访问 3000。
  [[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo "--domain requires a bare hostname" >&2; exit 2; }
  PUBLIC_URL="https://$DOMAIN"
fi
if [ -n "$PUBLIC_URL" ]; then
  [[ "$PUBLIC_URL" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || { echo "--public-url requires an HTTP(S) origin without a path" >&2; exit 2; }
fi
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$PORT" -le 65535 ] || { echo "--port must be 1..65535" >&2; exit 2; }
if [ -n "$MAX_FILE_MB" ]; then
  [[ "$MAX_FILE_MB" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$MAX_FILE_MB" -le 512 ] || { echo "--max-file-mb must be 1..512" >&2; exit 2; }
fi
command -v docker >/dev/null || { echo "Docker Engine is required" >&2; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose plugin is required" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is not running" >&2; exit 1; }
command -v openssl >/dev/null || { echo "OpenSSL is required to create the bootstrap secret" >&2; exit 1; }
step_done

step "准备数据目录"
mkdir -p "$DATA_DIR"/data/{db,files,config} "$DATA_DIR"/backups
DATA_DIR="$(cd -- "$DATA_DIR" && pwd)"
chmod 700 "$DATA_DIR" "$DATA_DIR/data" "$DATA_DIR/backups"
printf '数据目录：%s\n' "$DATA_DIR"
step_done

step "生成或更新安装配置"
if [ ! -f "$DATA_DIR/.env" ]; then
  echo "首次安装，生成配置文件。"
  umask 077
  cat > "$DATA_DIR/.env" <<EOF
APP_VERSION=$VERSION
WANGKE_API_IMAGE=${WANGKE_API_IMAGE:-wangke-agent-api:$VERSION}
WANGKE_WEB_IMAGE=${WANGKE_WEB_IMAGE:-wangke-agent-web:$VERSION}
PORT=$PORT
WANGKE_BIND_HOST=0.0.0.0
DATA_DIR=/data
DB_PATH=/data/db/wangke.sqlite
BOOTSTRAP_SECRET_FILE=/data/config/bootstrap-secret
BOOTSTRAP_TTL_MS=86400000
# Set these to an HTTPS origin and its host before enabling Passkey.
PUBLIC_ORIGIN=http://localhost:$PORT
WEBAUTHN_RP_ID=localhost
WEBAUTHN_RP_NAME=DeepStudent Go
# Initial model defaults. Configure all model services in the setup web page.
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=
MODEL_NAME=gpt-4o-mini
MODEL_TIMEOUT_MS=30000
MAX_FILE_BYTES=536870912
CLOUD_CONCURRENCY=2
EOF
elif [ "$VERSION_SET" -eq 1 ]; then
  echo "检测到已有配置，仅更新指定版本及本次显式传入的选项。"
  # Only rewrite local development tags; never overwrite an immutable deployment digest.
  tmp="$(mktemp "$DATA_DIR/.env.XXXXXX")"
  awk -v version="$VERSION" '
    BEGIN { app=0 }
    /^APP_VERSION=/ { print "APP_VERSION=" version; app=1; next }
    /^WANGKE_API_IMAGE=wangke-agent-api:/ { print "WANGKE_API_IMAGE=wangke-agent-api:" version; next }
    /^WANGKE_WEB_IMAGE=wangke-agent-web:/ { print "WANGKE_WEB_IMAGE=wangke-agent-web:" version; next }
    { print }
    END { if (!app) print "APP_VERSION=" version }
  ' "$DATA_DIR/.env" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$DATA_DIR/.env"
else
  echo "检测到已有配置，保留现有设置，仅应用本次显式传入的选项。"
fi
chmod 600 "$DATA_DIR/.env"
release_version="$(sed -n 's/^APP_VERSION=//p' "$DATA_DIR/.env" | tail -1)"
if ! grep -q '^WANGKE_API_IMAGE=' "$DATA_DIR/.env"; then
  printf '\nWANGKE_API_IMAGE=%s\n' "${WANGKE_API_IMAGE:-wangke-agent-api:${release_version:-$VERSION}}" >> "$DATA_DIR/.env"
fi
if ! grep -q '^WANGKE_WEB_IMAGE=' "$DATA_DIR/.env"; then
  printf '\nWANGKE_WEB_IMAGE=%s\n' "${WANGKE_WEB_IMAGE:-wangke-agent-web:${release_version:-$VERSION}}" >> "$DATA_DIR/.env"
fi
if [ -n "$MAX_FILE_MB" ]; then
  tmp="$(mktemp "$DATA_DIR/.env.XXXXXX")"
  awk -v bytes="$((MAX_FILE_MB * 1024 * 1024))" '
    /^MAX_FILE_BYTES=/ { next }
    { print }
    END { print "MAX_FILE_BYTES=" bytes }
  ' "$DATA_DIR/.env" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$DATA_DIR/.env"
elif ! grep -q '^MAX_FILE_BYTES=' "$DATA_DIR/.env"; then
  printf '\nMAX_FILE_BYTES=536870912\n' >> "$DATA_DIR/.env"
fi
if [ -n "$PUBLIC_URL" ]; then
  rp="${PUBLIC_URL#*://}"; rp="${rp%%:*}"
  tmp="$(mktemp "$DATA_DIR/.env.XXXXXX")"
  awk -v origin="$PUBLIC_URL" -v rp="$rp" '!/^PUBLIC_ORIGIN=/ && !/^WEBAUTHN_RP_ID=/ {print} END { print "PUBLIC_ORIGIN=" origin; print "WEBAUTHN_RP_ID=" rp }' "$DATA_DIR/.env" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$DATA_DIR/.env"
fi
if [ -n "$DOMAIN" ]; then
  tmp="$(mktemp "$DATA_DIR/.env.XXXXXX")"
  awk -v domain="$DOMAIN" '!/^DOMAIN=/ && !/^WANGKE_BIND_HOST=/ {print} END { print "DOMAIN=" domain; print "WANGKE_BIND_HOST=127.0.0.1" }' "$DATA_DIR/.env" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$DATA_DIR/.env"
fi
if [ "$AGENT" -eq 1 ] && ! grep -q '^SANDBOX_TOKEN=' "$DATA_DIR/.env"; then
  printf '\nSANDBOX_TOKEN=%s\nBOT_MAX_STEPS=100\n' "$(openssl rand -hex 32)" >> "$DATA_DIR/.env"
  if ! grep -q '^SANDBOX_NETWORK=' "$DATA_DIR/.env"; then
    printf 'SANDBOX_NETWORK=bridge\n' >> "$DATA_DIR/.env"
  fi
fi
step_done

step "安装管理与备份命令"
# The API creates the one-time secret on first startup, not before a long build.
mkdir -p "$DATA_DIR/bin"
install_management
echo "Management command: $DATA_DIR/bin/wangke-agent {status|logs|stop|start|restart|update|backup}"
step_done
if [ "$NO_START" -eq 0 ]; then
  EXTRA=()
  if [ "$BUILD_FROM_SOURCE" -eq 1 ]; then
    EXTRA+=(-f "$SCRIPT_DIR/compose.build.yaml")
  fi
  if grep -q '^DOMAIN=.' "$DATA_DIR/.env"; then
    EXTRA+=(-f "$SCRIPT_DIR/compose.prod.yaml")
  fi
  if grep -q '^SANDBOX_TOKEN=' "$DATA_DIR/.env"; then
    EXTRA+=(-f "$SCRIPT_DIR/compose.agent.yaml")
    if [ "$BUILD_FROM_SOURCE" -eq 1 ]; then EXTRA+=(-f "$SCRIPT_DIR/compose.agent.build.yaml"); fi
  fi
  compose() { WANGKE_HOST_DATA_DIR="$DATA_DIR/data" WANGKE_UID="$(id -u)" WANGKE_GID="$(id -g)" docker compose --env-file "$DATA_DIR/.env" -f "$SCRIPT_DIR/compose.yaml" ${EXTRA[@]+"${EXTRA[@]}"} "$@"; }

  # Do not start a second SQLite scheduler alongside the old integrated service.
  if compose ps --all --services --filter status=running | grep -qx app; then
    echo "检测到旧 app 实例。请先完成恢复点与单实例迁移演练，再受控停止旧实例；不能并行启动 api。" >&2
    exit 1
  fi
  step "准备独立服务镜像"
  if [ "$BUILD_FROM_SOURCE" -eq 1 ] && grep -q '^SANDBOX_TOKEN=' "$DATA_DIR/.env"; then
    echo "正在构建 Agent 沙盒镜像…"
    docker build -t wangke-sandbox:0.1.0 -f "$SCRIPT_DIR/infra/sandbox/Dockerfile" "$SCRIPT_DIR"
    echo "Agent 沙盒镜像构建完成。"
  else
    echo "未启用 Agent 沙盒，跳过沙盒镜像。"
  fi
  if [ "$BUILD_FROM_SOURCE" -eq 1 ]; then
    echo "显式源码模式：独立构建 API 和 Web。"
    compose build
  else
    echo "拉取已构建镜像；请在 .env 配置可达的 WANGKE_API_IMAGE/WANGKE_WEB_IMAGE（生产使用 digest）。"
    compose pull
  fi
  step_done

  step "启动服务并等待健康检查"
  echo "必要时会拉取代理等服务镜像；容器启动后最多等待 180 秒通过健康检查。"
  compose up -d --no-build --wait --wait-timeout 180
  step_done

  step "读取初始化入口"
  url="$(sed -n 's/^PUBLIC_ORIGIN=//p' "$DATA_DIR/.env" | tail -1)"
  compose exec -T api node -e '
    const fs = require("node:fs");
    (async () => {
      const status = await (await fetch("http://127.0.0.1:3000/api/v1/bootstrap/status")).json();
      const url = new URL(process.argv[1]);
      url.hash = "/setup";
      if (!status.initialized && status.bootstrapAvailable) {
        const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE || "/data/config/bootstrap-secret", "utf8").trim();
        url.hash += "?" + new URLSearchParams({ secret });
        console.log("One-time setup URL (keep private): " + url.href);
        console.log("Setup link expires at: " + status.expiresAt);
      } else {
        console.log("Setup URL: " + url.href);
        if (!status.initialized) console.log("Bootstrap secret expired. Stop api, remove data/config/bootstrap-secret, then start api to renew it.");
      }
    })().catch(error => { console.error("Cannot read setup link: " + error.message); process.exitCode = 1; });
  ' "${url:-http://localhost:$PORT}"
  step_done
  printf '\n安装完成（总耗时 %ss）。请打开上方链接设置访问密码、配置模型并添加 Passkey。\n' "$((SECONDS - INSTALL_STARTED))"
  printf '课程文件、学习数据、凭据和任务保存在 %s/data。\n' "$DATA_DIR"
else
  printf '\n安装准备完成（总耗时 %ss）；已按 --no-start 跳过镜像构建、服务启动及健康检查。\n' "$((SECONDS - INSTALL_STARTED))"
fi
