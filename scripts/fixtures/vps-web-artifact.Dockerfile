# Acceptance fallback only: prebuilt static Web artifact, NOT a Linux source build.
FROM caddy:2.10-alpine
COPY acceptance-web/dist /srv
COPY acceptance-web/dist/assets /opt/web-assets
COPY infra/docker/Caddyfile.web /etc/caddy/Caddyfile.template
COPY infra/docker/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod +x /usr/local/bin/web-entrypoint.sh
ENV API_BASE_URL=""
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/config.js >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
