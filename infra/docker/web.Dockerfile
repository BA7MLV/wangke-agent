# syntax=docker/dockerfile:1.7
# Static Web image. API routing belongs to the stable edge.
FROM node:22-bookworm-slim AS prune
WORKDIR /repo
COPY package.json package-lock.json turbo.json ./
COPY apps/web ./apps/web
COPY apps/api/package.json ./apps/api/package.json
COPY packages ./packages
RUN --mount=type=cache,target=/root/.npm npm exec --yes --package=turbo@2.11.10 -- turbo prune @wangke/web --docker

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY --from=prune /repo/out/full/ ./
ARG VITE_API_BASE_URL=""
ARG SOURCE_COMMIT=""
ARG SOURCE_DATE_EPOCH=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT} SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build -w @wangke/contracts && npm run build -w @wangke/study-core \
  && npm run build -w @wangke/web

FROM caddy:2.10-alpine
COPY --from=build /app/apps/web/dist /srv
COPY --from=build /app/apps/web/dist/assets /opt/web-assets
COPY infra/docker/Caddyfile.web /etc/caddy/Caddyfile.template
COPY infra/docker/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod +x /usr/local/bin/web-entrypoint.sh
ENV API_BASE_URL=""
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/config.js >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
