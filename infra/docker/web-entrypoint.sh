#!/bin/sh
# 按环境变量生成运行时配置，同一个镜像换 API 地址不用重新构建。
set -eu
# Preserve previous hashed chunks across Web-only replacements. No API/data volume.
mkdir -p /srv/assets
# BusyBox cp -an can skip the existing destination directory itself. Copy each
# file explicitly so a mounted (already populated) assets directory receives new
# chunks without replacing resources still used by an old page/Worker.
(
  cd /opt/web-assets
  find . -type d -exec mkdir -p '/srv/assets/{}' \;
  find . -type f -exec sh -c '
    for file do
      target="/srv/assets/$file"
      [ -e "$target" ] || cp -p "$file" "$target"
    done
  ' sh {} +
)
api_base="${API_BASE_URL:-}"
case "$api_base" in
  ''|http://*|https://*) ;;
  *) echo "API_BASE_URL must be empty or an http(s) URL" >&2; exit 1 ;;
esac
# JSON 字符串转义：只允许 URL 字符，直接拒绝引号和反斜杠。
case "$api_base" in *\"*|*\\*) echo "API_BASE_URL contains invalid characters" >&2; exit 1 ;; esac
if printf '%s' "$api_base" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  echo "API_BASE_URL contains control characters" >&2; exit 1
fi
printf 'window.__WANGKE_CONFIG__ = { apiBaseUrl: "%s" };\n' "${api_base%/}" > /srv/config.js
cp /etc/caddy/Caddyfile.template /etc/caddy/Caddyfile
exec "$@"
