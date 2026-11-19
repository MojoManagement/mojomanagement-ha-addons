ARG BUILD_FROM=node:24-alpine

# --- build stage: compile TypeScript, then keep only runtime dependencies ------
FROM node:24-alpine AS build
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/tsconfig.json app/tsconfig.build.json ./
COPY app/src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime stage --------------------------------------------------------------
FROM ${BUILD_FROM}

# Pinned yt-dlp release, verified against the checksums published with it.
# The add-on keeps a newer copy in /data when "yt_dlp_auto_update" is on.
ARG YT_DLP_VERSION=2026.10.26

RUN apk add --no-cache python3 su-exec \
  && wget -q -O /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" \
  && wget -q -O /tmp/SHA2-256SUMS "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/SHA2-256SUMS" \
  && echo "$(grep ' yt-dlp$' /tmp/SHA2-256SUMS | cut -d' ' -f1)  /usr/local/bin/yt-dlp" | sha256sum -c - \
  && chmod 755 /usr/local/bin/yt-dlp \
  && rm /tmp/SHA2-256SUMS \
  && addgroup -S bridge && adduser -S -G bridge -H -h /nonexistent bridge

WORKDIR /opt/yt-cast-audio-bridge
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY app/package.json ./package.json
COPY app/ui ./ui
COPY run.sh /usr/local/bin/run-bridge
RUN chmod 755 /usr/local/bin/run-bridge

ENV NODE_ENV=production \
    YT_DLP_BUNDLED=/usr/local/bin/yt-dlp

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${HEALTH_PORT:-3099}/healthz" || exit 1

CMD ["/usr/local/bin/run-bridge"]
