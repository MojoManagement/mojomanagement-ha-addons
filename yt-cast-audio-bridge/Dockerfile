ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

WORKDIR /opt/yt-cast-audio-bridge

RUN apk add --no-cache bash jq yt-dlp \
  && mkdir -p /data/yt-cast-audio-bridge/state

COPY app/package.json ./package.json
COPY app/src ./src

RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY rootfs /
RUN chmod a+x /usr/local/bin/run-bridge.sh

ENV NODE_ENV=production \
    STATE_FILE=/data/yt-cast-audio-bridge/state/bridge-state.json \
    HEALTH_PORT=3099

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${HEALTH_PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["/usr/local/bin/run-bridge.sh"]
