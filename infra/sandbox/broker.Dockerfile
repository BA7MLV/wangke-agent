FROM docker:29-cli AS docker
FROM node:22-alpine
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY infra/sandbox/broker.mjs /app/broker.mjs
COPY infra/sandbox/arguments.mjs /app/arguments.mjs
CMD ["node", "/app/broker.mjs"]
