# syntax=docker/dockerfile:1.7
# API only. No browser source or Web artifact is copied into any stage.
FROM node:22-bookworm-slim AS prune
WORKDIR /repo
COPY package.json package-lock.json turbo.json ./
COPY apps/api ./apps/api
COPY apps/web/package.json ./apps/web/package.json
COPY packages ./packages
RUN --mount=type=cache,target=/root/.npm npm exec --yes --package=turbo@2.11.10 -- turbo prune @wangke/api --docker

FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG DEBIAN_MIRROR=deb.debian.org
RUN sed -i "s|http://deb.debian.org|http://${DEBIAN_MIRROR}|g; s|https://deb.debian.org|http://${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY --from=prune /repo/out/full/ ./
RUN npm run build -w @wangke/contracts && npm run build -w @wangke/study-core && npm run build -w @wangke/api
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG DEBIAN_MIRROR=deb.debian.org
ENV NODE_ENV=production DATA_DIR=/data DB_PATH=/data/db/wangke.sqlite FILES_DIR=/data/files HOME=/tmp
WORKDIR /app
RUN sed -i "s|http://deb.debian.org|http://${DEBIAN_MIRROR}|g; s|https://deb.debian.org|http://${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/scripts/deployment-maintenance.mjs ./apps/api/scripts/deployment-maintenance.mjs
COPY --from=build /app/packages/study-core/package.json ./packages/study-core/package.json
COPY --from=build /app/packages/study-core/dist ./packages/study-core/dist
COPY --from=build /app/packages/study-core/assets ./packages/study-core/assets
COPY --from=build /app/packages/contracts ./packages/contracts
COPY scripts/reset-password.mjs ./scripts/reset-password.mjs
RUN test ! -d node_modules/react && test ! -d node_modules/react-dom && test ! -d node_modules/vite \
  && test "$(id -u node)" = 1000 && test "$(id -g node)" = 1000 \
  && mkdir -p /data/db /data/files /data/config && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/apps/api/src/server.js"]
