FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ARG DEBIAN_MIRROR=deb.debian.org
ENV NODE_ENV=production DATA_DIR=/data DB_PATH=/data/db/wangke.sqlite FILES_DIR=/data/files HOME=/tmp
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN sed -i "s|http://deb.debian.org|http://${DEBIAN_MIRROR}|g; s|https://deb.debian.org|http://${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::ForceIPv4=true update \
  && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::ForceIPv4=true install -y --no-install-recommends ffmpeg python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm_config_build_from_source=true npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-api ./dist-api
COPY --from=build /app/scripts/reset-password.mjs ./scripts/reset-password.mjs
RUN groupadd --system wangke && useradd --system --gid wangke --home-dir /app wangke \
  && mkdir -p /data/db /data/files /data/config \
  && chown -R wangke:wangke /app /data
USER wangke
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-api/apps/api/src/server.js"]
