# musicsync — Spotify↔TIDAL playlist sync
FROM node:24-alpine

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PANEL_BIND=0.0.0.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src/ ./src/
COPY healthcheck.js ./

RUN mkdir -p /config && chown node:node /config
VOLUME /config

USER node

EXPOSE 8080

HEALTHCHECK --interval=5m --timeout=10s --start-period=30s \
  CMD node healthcheck.js

# Direct node (never npm) so SIGTERM reaches the process; run compose with
# init: true so PID 1 signal handling is correct.
CMD ["node", "src/index.js"]
