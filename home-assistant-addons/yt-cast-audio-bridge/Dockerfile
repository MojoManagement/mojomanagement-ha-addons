ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

WORKDIR /opt/yt-cast-audio-bridge

RUN apk add --no-cache bash jq yt-dlp \
  && mkdir -p /data/yt-cast-audio-bridge/state

COPY app/package.json ./package.json
COPY app/src ./src
COPY app/scripts ./scripts

RUN npm install --omit=dev --no-audit --no-fund

COPY rootfs /
RUN chmod a+x /usr/local/bin/run-bridge.sh

ENV NODE_ENV=production \
    STATE_FILE=/data/yt-cast-audio-bridge/state/bridge-state.json \
    HEALTH_PORT=3099

CMD ["/usr/local/bin/run-bridge.sh"]
