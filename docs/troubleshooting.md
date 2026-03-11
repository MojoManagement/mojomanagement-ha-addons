# Troubleshooting

## Receiver visible, but no play

- Confirm `yt-dlp` is installed and executable, or run `npm install` to provision the local fallback in `tools/bin/yt-dlp`.
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

## Bridge not visible in YouTube app

If logs show `Receiver started ...` but the phone app still does not list bridge devices, this is usually a network reachability/discovery issue between phone and Home Assistant host.

Checklist:

- Ensure phone and HA host are in the same L2 segment/VLAN (no client isolation/guest Wi-Fi).
- Allow mDNS/Bonjour multicast (`224.0.0.251:5353` UDP) between phone and HA host network.
- Allow inbound TCP from phone subnet to HA host on DIAL ports (`DIAL_BASE_PORT` and following ports, e.g. `3000-3025` for up to 25 receivers).
- Keep add-on on host networking (required for Cast discovery).
- Default behavior (when both bind options are empty): auto-pick the first non-loopback LAN IPv4 found by the host OS.
- If Home Assistant host has multiple NICs/subnets, set `dial_bind_to_addresses` and/or `dial_bind_to_interfaces` in add-on options to force the DIAL listener onto reachable LAN interfaces (this is mainly useful when there are 2+ candidates).
- Temporarily set `exclude_regex` empty if you suspect over-filtering.
- Remove stale linked TV/device entries from YouTube/Google account device management and relaunch the app.

Notes:

- DNS is less commonly the root cause here than mDNS multicast filtering or blocked TCP DIAL ports.
- The add-on does not provide a web UI. Use `/healthz` for status.

