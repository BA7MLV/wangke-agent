# 浏览器前端壳层：只包含构建好的静态文件，由 Caddy 提供。
# 默认把 /api/* 反代给 API_UPSTREAM（同源，Cookie 登录最省事）；
# 也可以设置 API_BASE_URL 让浏览器直接跨域请求独立的 API 域名。
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run check:i18n && npx vite build

FROM caddy:2.10-alpine
COPY --from=build /app/dist /srv
COPY infra/docker/Caddyfile.web /etc/caddy/Caddyfile.template
COPY infra/docker/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod +x /usr/local/bin/web-entrypoint.sh
ENV API_UPSTREAM="" API_BASE_URL=""
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/config.js >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
