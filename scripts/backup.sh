#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${WANGKE_DATA_DIR:-${HOME:?}/.wangke-agent}"
OUTPUT_DIR=""
COMPOSE_FILE="${WANGKE_COMPOSE_FILE:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: backup.sh [--data-dir DIR] [--output-dir DIR] [--compose-file FILE]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --data-dir) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; DATA_DIR=$2; shift 2 ;;
    --output-dir|--output) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; OUTPUT_DIR=$2; shift 2 ;;
    --compose-file) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; COMPOSE_FILE=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

DATA_DIR="$(cd -- "$DATA_DIR" 2>/dev/null && pwd -P || true)"
[ -n "$DATA_DIR" ] || { echo "data directory does not exist" >&2; exit 1; }
OUTPUT_DIR="${OUTPUT_DIR:-$DATA_DIR/backups}"
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR" 2>/dev/null || true
[ -d "$DATA_DIR/data" ] || { echo "missing data directory: $DATA_DIR/data" >&2; exit 1; }
[ -f "$DATA_DIR/.env" ] || { echo "missing protected environment file: $DATA_DIR/.env" >&2; exit 1; }
if find "$DATA_DIR/data" -type l -print -quit | grep -q .; then
  echo "refusing to back up symlinks under data" >&2
  exit 1
fi
[ ! -L "$DATA_DIR/.env" ] || { echo "refusing symlink .env" >&2; exit 1; }

compose_args=()
if [ -n "$COMPOSE_FILE" ]; then
  [ -f "$COMPOSE_FILE" ] || { echo "compose file not found" >&2; exit 1; }
  compose_args=(-f "$COMPOSE_FILE")
fi
compose_env=(WANGKE_HOST_DATA_DIR="$DATA_DIR/data" WANGKE_UID="$(id -u)" WANGKE_GID="$(id -g)")
was_running=0
if [ -n "$COMPOSE_FILE" ] && command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if env "${compose_env[@]}" docker compose "${compose_args[@]}" --env-file "$DATA_DIR/.env" ps --services --filter status=running 2>/dev/null | grep -q .; then
    was_running=1
    echo "stopping Compose service briefly for a consistent SQLite snapshot"
    env "${compose_env[@]}" docker compose "${compose_args[@]}" --env-file "$DATA_DIR/.env" stop >/dev/null
  fi
fi
restart() {
  if [ "$was_running" -eq 1 ]; then
    env "${compose_env[@]}" docker compose "${compose_args[@]}" --env-file "$DATA_DIR/.env" start >/dev/null || \
      echo "warning: service was stopped but could not be started; run wangke-agent start" >&2
  fi
}
trap restart EXIT

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$OUTPUT_DIR/wangke-agent-$timestamp.tar.gz"
stage="$(mktemp -d "${TMPDIR:-/tmp}/wangke-backup.XXXXXX")"
trap 'rm -rf "$stage"; restart' EXIT
mkdir -p "$stage/data/db" "$stage/data/files" "$stage/data/config"
for part in db files config; do
  if [ -d "$DATA_DIR/data/$part" ]; then cp -a "$DATA_DIR/data/$part/." "$stage/data/$part/"; fi
done
if [ -f "$DATA_DIR/.env" ]; then cp -p "$DATA_DIR/.env" "$stage/.env"; chmod 600 "$stage/.env"; fi
(
  cd "$stage"
  find data -type f -print0 | sort -z | xargs -0 -r sha256sum > backup-manifest.sha256
  if [ -f .env ]; then sha256sum .env >> backup-manifest.sha256; fi
)

tar_items=(data backup-manifest.sha256)
[ -f "$stage/.env" ] && tar_items+=(.env)
tar -czf "$archive" -C "$stage" "${tar_items[@]}" 2>/dev/null || {
  rm -f "$archive"
  echo "backup failed" >&2
  exit 1
}
chmod 600 "$archive"
rm -rf "$stage"
echo "backup written: $archive"
