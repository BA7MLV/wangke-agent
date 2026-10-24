#!/bin/sh
# 按环境变量生成运行时配置，同一个镜像换 API 地址不用重新构建。
set -eu
api_base="${API_BASE_URL:-}"
case "$api_base" in
  ''|http://*|https://*) ;;
  *) echo "API_BASE_URL must be empty or an http(s) URL" >&2; exit 1 ;;
esac
# JSON 字符串转义：只允许 URL 字符，直接拒绝引号和反斜杠。
case "$api_base" in *\"*|*\\*) echo "API_BASE_URL contains invalid characters" >&2; exit 1 ;; esac
printf 'window.__WANGKE_CONFIG__ = { apiBaseUrl: "%s" };\n' "${api_base%/}" > /srv/config.js
upstream="${API_UPSTREAM:-}"
case "$upstream" in
  '') ;;
  *[!A-Za-z0-9.:_/-]*) echo "API_UPSTREAM contains invalid characters" >&2; exit 1 ;;
esac
if [ -n "$upstream" ]; then
  # SSE（Bot 事件流）不能被缓冲，所以 flush_interval -1。
  block="handle /api/* {\n\t\treverse_proxy $upstream {\n\t\t\tflush_interval -1\n\t\t}\n\t}"
else
  block=""
  [ -n "$api_base" ] || echo "warning: neither API_UPSTREAM nor API_BASE_URL is set; /api requests will 404" >&2
fi
sed "s|^\t# __API_BLOCK__.*$|\t$block|" /etc/caddy/Caddyfile.template > /etc/caddy/Caddyfile
exec "$@"
