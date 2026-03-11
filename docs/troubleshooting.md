# Troubleshooting

## Receiver visible, but no play

- Confirm `yt-dlp` is installed and executable.
- Ensure Cast device can reach media URL from bridge host network.
- Check logs for `doPlay failed`.

## Device disappears

- Increase `OFFLINE_HIDE_AFTER_MS`.
- Verify mDNS traffic is not blocked.
- Optionally pin device via `PINNED_HOSTS`.

## "no session started"

Handled as benign for stop/early-volume scenarios; typically occurs before active media session exists.

## YouTube app stuck on old devices

Remove stale linked TV/device entries in YouTube/Google account device management, then relaunch app.
