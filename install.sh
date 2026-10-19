#!/usr/bin/env bash
set -euo pipefail

VERSION="0.1.0"
VERSION_SET=0
DATA_DIR="${WANGKE_DATA_DIR:-$HOME/.wangke-agent}"
PORT="${WANGKE_PORT:-3000}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NO_START=0
AGENT=0
MAX_FILE_MB=""
usage() { echo "Usage: ./install.sh [--data-dir DIR] [--port PORT] [--max-file-mb 1..512] [--agent] [--version VERSION] [--no-start]"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || { echo "--version requires a value" >&2; exit 2; }; VERSION="$2"; VERSION_SET=1; shift 2 ;;
    --data-dir) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; DATA_DIR="$2"; shift 2 ;;
    --port) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; PORT="$2"; shift 2 ;;
    --max-file-mb) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; MAX_FILE_MB="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --no-start) NO_START=1; shift ;;
    --agent) AGENT=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$PORT" -le 65535 ] || { echo "--port must be 1..65535" >&2; exit 2; }
if [ -n "$MAX_FILE_MB" ]; then
  [[ "$MAX_FILE_MB" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$MAX_FILE_MB" -le 512 ] || { echo "--max-file-mb must be 1..512" >&2; exit 2; }
fi
command -v docker >/dev/null || { echo "Docker Engine is required" >&2; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose plugin is required" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is not running" >&2; exit 1; }
command -v openssl >/dev/null || { echo "OpenSSL is required to create the bootstrap secret" >&2; exit 1; }
mkdir -p "$DATA_DIR"/data/{db,files,config} "$DATA_DIR"/backups
DATA_DIR="$(cd -- "$DATA_DIR" && pwd)"
chmod 700 "$DATA_DIR" "$DATA_DIR/data" "$DATA_DIR/backups"
if [ ! -f "$DATA_DIR/.env" ]; then
  umask 077
  cat > "$DATA_DIR/.env" <<EOF
APP_VERSION=$VERSION
WANGKE_IMAGE=wangke-agent:$VERSION
PORT=$PORT
WANGKE_BIND_HOST=0.0.0.0
DATA_DIR=/data
DB_PATH=/data/db/wangke.sqlite
BOOTSTRAP_SECRET_FILE=/data/config/bootstrap-secret
BOOTSTRAP_TTL_MS=900000
# Set these to an HTTPS origin and its host before enabling Passkey.
PUBLIC_ORIGIN=http://localhost:$PORT
WEBAUTHN_RP_ID=localhost
WEBAUTHN_RP_NAME=Wangke Agent
# Bot model credentials are read only by the API container.
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=
MODEL_NAME=gpt-4o-mini
MODEL_TIMEOUT_MS=30000
MAX_FILE_BYTES=52428800
EOF
elif [ "$VERSION_SET" -eq 1 ]; then
  # An explicit --version changes only the two release-controlled keys.
  tmp="$(mktemp "$DATA_DIR/.env.XXXXXX")"
  awk -v version="$VERSION" '
    BEGIN { app=0; image=0 }
    /^APP_VERSION=/ { print "APP_VERSION=" version; app=1; next }
    /^WANGKE_IMAGE=/ { print "WANGKE_IMAGE=wangke-agent:" version; image=1; next }
    { print }
    END { if (!app) print "APP_VERSION=" version; if (!image) print "WANGKE_IMAGE=wangke-agent:" version }
  ' "$DATA_DIR/.env" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$DATA_DIR/.env"
fi
chmod 600 "$DATA_DIR/.env"
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
  printf '\nMAX_FILE_BYTES=52428800\n' >> "$DATA_DIR/.env"
fi
if [ "$AGENT" -eq 1 ] && ! grep -q '^SANDBOX_TOKEN=' "$DATA_DIR/.env"; then
  printf '\nSANDBOX_TOKEN=%s\nBOT_MAX_STEPS=100\nSANDBOX_NETWORK=none\n' "$(openssl rand -hex 32)" >> "$DATA_DIR/.env"
fi
if [ ! -f "$DATA_DIR/data/config/bootstrap-secret" ]; then
  umask 077
  openssl rand -base64 32 > "$DATA_DIR/data/config/bootstrap-secret"
  chmod 600 "$DATA_DIR/data/config/bootstrap-secret"
  echo "Bootstrap secret written to $DATA_DIR/data/config/bootstrap-secret (display it separately; it is one-time)."
fi
mkdir -p "$DATA_DIR/bin"
sed "s|__DEFAULT_COMPOSE_FILE__|$SCRIPT_DIR/compose.yaml|" "$SCRIPT_DIR/scripts/wangke-agent" > "$DATA_DIR/bin/wangke-agent"
chmod 700 "$DATA_DIR/bin/wangke-agent"
cp -f "$SCRIPT_DIR/scripts/backup.sh" "$DATA_DIR/bin/backup.sh"
cp -f "$SCRIPT_DIR/scripts/restore.sh" "$DATA_DIR/bin/restore.sh"
chmod 700 "$DATA_DIR/bin/backup.sh" "$DATA_DIR/bin/restore.sh"
echo "Management command: $DATA_DIR/bin/wangke-agent {status|logs|stop|start|restart|update|backup}"
if [ "$NO_START" -eq 0 ]; then
  EXTRA=()
  if grep -q '^SANDBOX_TOKEN=' "$DATA_DIR/.env"; then
    EXTRA=(-f "$SCRIPT_DIR/compose.agent.yaml")
    docker build -t wangke-sandbox:0.1.0 -f "$SCRIPT_DIR/infra/sandbox/Dockerfile" "$SCRIPT_DIR"
  fi
  WANGKE_HOST_DATA_DIR="$DATA_DIR/data" WANGKE_UID="$(id -u)" WANGKE_GID="$(id -g)" \
    docker compose --env-file "$DATA_DIR/.env" -f "$SCRIPT_DIR/compose.yaml" "${EXTRA[@]}" up -d --build --wait --wait-timeout 120
  echo "Wangke is available at http://localhost:$PORT"
  echo "Uploads persist in $DATA_DIR/data/files; initialize/login at /#/bot, then use + in /#/chat."
fi
