#!/usr/bin/env bash
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
