#!/usr/bin/env bash
set -euo pipefail

TARGET_REPO_DIR="${1:-../mojomanagement-ha-addons}"
TARGET_REPO_NAME="${2:-mojomanagement-ha-addons}"
TARGET_REPO_URL="https://github.com/MojoManagement/${TARGET_REPO_NAME}"
ADDON_DIR="${TARGET_REPO_DIR}/yt-cast-audio-bridge"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

mkdir -p "${ADDON_DIR}/rootfs/usr/local/bin" "${ADDON_DIR}/app"

cat > "${TARGET_REPO_DIR}/repository.yaml" <<YAML
name: MojoManagement Home Assistant Add-ons
url: '${TARGET_REPO_URL}'
maintainer: MojoManagement
YAML

cat > "${TARGET_REPO_DIR}/README.md" <<'MD'
# MojoManagement Home Assistant Add-ons

Custom Home Assistant add-ons maintained by MojoManagement.

## Included add-ons

- `yt-cast-audio-bridge`
MD

cat > "${ADDON_DIR}/config.yaml" <<'YAML'
name: "YT Cast Audio Bridge"
version: "0.1.0"
slug: "yt_cast_audio_bridge"
description: "Virtual YouTube receivers that forward playback to Cast audio devices"
url: "https://github.com/MojoManagement/yt-cast-audio-bridge"
arch:
  - aarch64
  - amd64
  - armhf
  - armv7
  - i386
startup: services
boot: auto
init: false
host_network: true
ports:
  3099/tcp: 3099
ports_description:
  3099/tcp: Health endpoint
map:
  - addon_config:rw
options:
  bridge_name_prefix: "Audio ->"
  bridge_screen_prefix: "YouTube on"
  dial_base_port: 3000
  dial_prefix_base: "/ytbridge"
  discovery_interval_ms: 5000
  offline_hide_after_ms: 180000
  play_retry_ms: 8000
  startup_grace_ms: 4000
  max_receivers: 25
  allow_duplicate_friendly_names: false
  only_audio_like: true
  include_regex: ""
  exclude_regex: "Chromecast|Google TV|Nest Hub|Shield|Roku|Fire TV"
  pinned_hosts: []
  log_level: "INFO"
  health_port: 3099
  yt_dlp_bin: "yt-dlp"
  yt_cookies_file: ""
schema:
  bridge_name_prefix: str
  bridge_screen_prefix: str
  dial_base_port: int(1000,65000)
  dial_prefix_base: str
  discovery_interval_ms: int(1000,120000)
  offline_hide_after_ms: int(10000,3600000)
  play_retry_ms: int(1000,120000)
  startup_grace_ms: int(1000,120000)
  max_receivers: int(1,200)
  allow_duplicate_friendly_names: bool
  only_audio_like: bool
  include_regex: str?
  exclude_regex: str?
  pinned_hosts:
    - str?
  log_level: list(DEBUG|INFO|WARN|ERROR)
  health_port: int(1024,65535)
  yt_dlp_bin: str?
  yt_cookies_file: str?
image: "ghcr.io/mojomanagement/{arch}-addon-yt-cast-audio-bridge"
YAML

cat > "${ADDON_DIR}/build.yaml" <<'YAML'
args:
  BUILD_FROM: node:20-alpine
YAML

cat > "${ADDON_DIR}/Dockerfile" <<'DOCKER'
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
DOCKER

cat > "${ADDON_DIR}/rootfs/usr/local/bin/run-bridge.sh" <<'SH'
#!/usr/bin/with-contenv bash
set -euo pipefail

OPTIONS_FILE="/data/options.json"

read_json_string() {
  local key="$1"
  local default="$2"
  if [[ -f "$OPTIONS_FILE" ]]; then
    jq -er --arg k "$key" '.[$k] // empty | strings' "$OPTIONS_FILE" 2>/dev/null || printf '%s' "$default"
  else
    printf '%s' "$default"
  fi
}

read_json_int() {
  local key="$1"
  local default="$2"
  if [[ -f "$OPTIONS_FILE" ]]; then
    jq -er --arg k "$key" '.[$k] // empty | numbers | floor' "$OPTIONS_FILE" 2>/dev/null || printf '%s' "$default"
  else
    printf '%s' "$default"
  fi
}

read_json_bool01() {
  local key="$1"
  local default="$2"
  if [[ -f "$OPTIONS_FILE" ]]; then
    jq -er --arg k "$key" '.[$k] // empty | booleans' "$OPTIONS_FILE" 2>/dev/null | sed 's/true/1/; s/false/0/' || printf '%s' "$default"
  else
    printf '%s' "$default"
  fi
}

read_json_csv() {
  local key="$1"
  if [[ -f "$OPTIONS_FILE" ]]; then
    jq -er --arg k "$key" '.[$k] // [] | map(tostring) | join(",")' "$OPTIONS_FILE" 2>/dev/null || true
  fi
}

export BRIDGE_NAME_PREFIX="$(read_json_string bridge_name_prefix 'Audio ->')"
export BRIDGE_SCREEN_PREFIX="$(read_json_string bridge_screen_prefix 'YouTube on')"
export DIAL_BASE_PORT="$(read_json_int dial_base_port '3000')"
export DIAL_PREFIX_BASE="$(read_json_string dial_prefix_base '/ytbridge')"
export DISCOVERY_INTERVAL_MS="$(read_json_int discovery_interval_ms '5000')"
export OFFLINE_HIDE_AFTER_MS="$(read_json_int offline_hide_after_ms '180000')"
export PLAY_RETRY_MS="$(read_json_int play_retry_ms '8000')"
export STARTUP_GRACE_MS="$(read_json_int startup_grace_ms '4000')"
export MAX_RECEIVERS="$(read_json_int max_receivers '25')"
export ALLOW_DUPLICATE_FRIENDLY_NAMES="$(read_json_bool01 allow_duplicate_friendly_names '0')"
export ONLY_AUDIO_LIKE="$(read_json_bool01 only_audio_like '1')"
export INCLUDE_REGEX="$(read_json_string include_regex '')"
export EXCLUDE_REGEX="$(read_json_string exclude_regex 'Chromecast|Google TV|Nest Hub|Shield|Roku|Fire TV')"
export PINNED_HOSTS="$(read_json_csv pinned_hosts)"
export LOG_LEVEL="$(read_json_string log_level 'INFO')"
export HEALTH_PORT="$(read_json_int health_port '3099')"

YT_DLP_OPTION="$(read_json_string yt_dlp_bin '')"
if [[ -n "$YT_DLP_OPTION" ]]; then
  export YT_DLP_BIN="$YT_DLP_OPTION"
fi

YT_COOKIES_OPTION="$(read_json_string yt_cookies_file '')"
if [[ -n "$YT_COOKIES_OPTION" ]]; then
  export YT_COOKIES_FILE="$YT_COOKIES_OPTION"
fi

export STATE_FILE="/data/yt-cast-audio-bridge/state/bridge-state.json"

cd /opt/yt-cast-audio-bridge
exec node src/index.mjs
SH

cat > "${ADDON_DIR}/README.md" <<'MD'
# YT Cast Audio Bridge Add-on

Home Assistant add-on packaging for `yt-cast-audio-bridge`.

## Notes

- Uses `host_network` to support local Cast discovery.
- Runtime state is persisted at `/data/yt-cast-audio-bridge/state/bridge-state.json`.
MD

cp -r "${SOURCE_ROOT}/src" "${ADDON_DIR}/app/src"
mkdir -p "${ADDON_DIR}/app/scripts"
cp "${SOURCE_ROOT}/scripts/start.sh" "${ADDON_DIR}/app/scripts/start.sh"
cp "${SOURCE_ROOT}/scripts/start.ps1" "${ADDON_DIR}/app/scripts/start.ps1"
cp "${SOURCE_ROOT}/scripts/postinstall-yt-dlp.mjs" "${ADDON_DIR}/app/scripts/postinstall-yt-dlp.mjs"
cp "${SOURCE_ROOT}/scripts/install-task.ps1" "${ADDON_DIR}/app/scripts/install-task.ps1"
cp "${SOURCE_ROOT}/package.json" "${ADDON_DIR}/app/package.json"
cp "${SOURCE_ROOT}/.env.example" "${ADDON_DIR}/app/.env.example"

chmod +x "${ADDON_DIR}/rootfs/usr/local/bin/run-bridge.sh"

echo "✅ Add-on repo scaffold created at: ${TARGET_REPO_DIR}"
echo "➡️ Next: cd ${TARGET_REPO_DIR} && git add . && git commit -m 'Add yt-cast-audio-bridge add-on'"
