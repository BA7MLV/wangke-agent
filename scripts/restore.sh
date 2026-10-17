#!/usr/bin/env bash
set -euo pipefail

DATA_DIR=""
ARCHIVE=""
COMPOSE_FILE="${WANGKE_COMPOSE_FILE:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
usage() { echo "Usage: restore.sh --data-dir DIR BACKUP.tar.gz [--compose-file FILE]"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --data-dir) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; DATA_DIR=$2; shift 2 ;;
    --compose-file) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; COMPOSE_FILE=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$ARCHIVE" ] || { echo "only one backup may be supplied" >&2; exit 2; }; ARCHIVE=$1; shift ;;
  esac
done
[ -n "$DATA_DIR" ] && [ -n "$ARCHIVE" ] || { usage >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "backup file not found" >&2; exit 1; }
case "$DATA_DIR" in /|""|.) echo "refusing unsafe data directory" >&2; exit 1;; esac
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd -- "$DATA_DIR" && pwd -P)"

while IFS= read -r entry; do
  entry="${entry#./}"
  case "$entry" in
    data|data/|data/db|data/db/|data/db/*|data/files|data/files/|data/files/*|data/config|data/config/|data/config/*|.env|backup-manifest.sha256) ;;
    *) echo "backup contains an unapproved path: $entry" >&2; exit 1;;
  esac
  case "$entry" in /*|*../*|../*|*/../*|*"$'\n'"*) echo "unsafe archive path" >&2; exit 1;; esac
done < <(tar -tzf "$ARCHIVE")
if tar -tzf "$ARCHIVE" | grep -E '\.(tar|tgz|gz)$' >/dev/null; then
  echo "nested archive is not allowed" >&2
  exit 1
fi

mkdir -p "$DATA_DIR/backups"
if [ -d "$DATA_DIR/data" ] && [ -f "$DATA_DIR/.env" ]; then
  backup_args=(--data-dir "$DATA_DIR" --output-dir "$DATA_DIR/backups")
  [ -n "$COMPOSE_FILE" ] && backup_args+=(--compose-file "$COMPOSE_FILE")
  "$SCRIPT_DIR/backup.sh" "${backup_args[@]}" >/dev/null
else
  echo "no complete existing installation found; restoring into an empty data directory"
fi
compose_args=()
if [ -n "$COMPOSE_FILE" ]; then
  [ -f "$COMPOSE_FILE" ] || { echo "compose file not found" >&2; exit 1; }
  compose_args=(-f "$COMPOSE_FILE")
fi
was_running=0
if [ -n "$COMPOSE_FILE" ] && command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if WANGKE_HOST_DATA_DIR="$DATA_DIR/data" WANGKE_UID="$(id -u)" WANGKE_GID="$(id -g)" \
    docker compose "${compose_args[@]}" --env-file "$DATA_DIR/.env" ps --services --filter status=running 2>/dev/null | grep -q .; then
    was_running=1
    WANGKE_HOST_DATA_DIR="$DATA_DIR/data" WANGKE_UID="$(id -u)" WANGKE_GID="$(id -g)" \
      docker compose "${compose_args[@]}" --env-file "$DATA_DIR/.env" stop >/dev/null
  fi
fi
restart() {
  if [ "$was_running" -eq 1 ]; then
    WANGKE_HOST_DATA_DIR="$DATA_DIR/data" WANGKE_UID="$(id -u)" WANGKE_GID="$(id -g)" \
      docker compose "${compose_args[@]}" --env-file "$DATA_DIR/.env" start >/dev/null || \
      echo "warning: service could not be started; run wangke-agent start" >&2
  fi
}
trap restart EXIT
stage="$(mktemp -d "${TMPDIR:-/tmp}/wangke-restore.XXXXXX")"
cleanup() { rm -rf "$stage"; restart; }
trap cleanup EXIT
tar -xzf "$ARCHIVE" -C "$stage" --no-same-owner --no-same-permissions
if find "$stage" -type l -print -quit | grep -q .; then
  echo "symbolic links are not allowed" >&2
  exit 1
fi
if [ ! -f "$stage/backup-manifest.sha256" ] || ! (cd "$stage" && sha256sum -c --quiet backup-manifest.sha256); then
  echo "backup checksum verification failed" >&2
  exit 1
fi

for part in db files config; do
  rm -rf "$DATA_DIR/data/$part"
  mkdir -p "$DATA_DIR/data/$part"
  if [ -d "$stage/data/$part" ]; then cp -a "$stage/data/$part/." "$DATA_DIR/data/$part/"; fi
done
if [ -f "$stage/.env" ]; then cp -p "$stage/.env" "$DATA_DIR/.env"; chmod 600 "$DATA_DIR/.env"; fi
chmod 700 "$DATA_DIR" "$DATA_DIR/data" 2>/dev/null || true
echo "restore complete; previous data was backed up in $DATA_DIR/backups"
if [ -n "$COMPOSE_FILE" ]; then
  echo "start with: wangke-agent start (or docker compose --env-file '$DATA_DIR/.env' -f '$COMPOSE_FILE' up -d)"
else
  echo "start with: wangke-agent start after configuring its Compose file"
fi
