#!/bin/sh
# Starts the bridge as an unprivileged user. Only the data folder is writable for it.
set -eu

DATA_DIR="${DATA_DIR:-/data/yt-cast-audio-bridge}"
export DATA_DIR
# yt-dlp and Node want a writable home/cache; keep it inside the data folder.
export HOME="$DATA_DIR/home"
export XDG_CACHE_HOME="$DATA_DIR/cache"

cd /opt/yt-cast-audio-bridge

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$HOME" "$XDG_CACHE_HOME"
  chown -R bridge:bridge "$DATA_DIR"
  exec su-exec bridge:bridge node dist/main.js
fi

mkdir -p "$HOME" "$XDG_CACHE_HOME" 2>/dev/null || true
exec node dist/main.js
