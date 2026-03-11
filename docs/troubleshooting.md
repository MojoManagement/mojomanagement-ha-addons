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

### Required traffic (especially across VLANs / UniFi)

- **mDNS**: UDP `5353` to multicast `224.0.0.251` (Bonjour).
- **SSDP/DIAL discovery**: UDP `1900` to multicast `239.255.255.250` plus unicast replies back to the sender.
- **DIAL app endpoints**: inbound TCP on `DIAL_BASE_PORT` and following ports (default `3000-3025` for up to 25 receivers).
- **Health check (optional)**: TCP `3099` (`/healthz`) for diagnostics.

Notes for HA OS/add-on runtime:

- This add-on runs with `host_network: true`, so DIAL listeners are opened directly on the HA host network stack (not Docker bridge port publishing).
- In practice, most issues are upstream network policy (VLAN firewall/ACL/client isolation/multicast handling), not missing Docker port mappings.

Checklist:

- Ensure phone and HA host are in the same L2 segment/VLAN (no client isolation/guest Wi-Fi).
- Allow **both** discovery planes between phone VLAN and HA host VLAN: mDNS/Bonjour (`224.0.0.251:5353` UDP) **and** SSDP/DIAL (`239.255.255.250:1900` UDP).
- Allow inbound TCP from phone subnet to HA host on DIAL ports (`DIAL_BASE_PORT` and following ports, e.g. `3000-3025` for up to 25 receivers).
- On UniFi specifically: enabling only “mDNS” is often not enough for YouTube Cast discovery across VLANs; also allow/reflection/routing for SSDP multicast and the unicast reply path.
- Keep add-on on host networking (required for Cast discovery).
- Default behavior (when both bind options are empty): auto-pick a non-loopback LAN IPv4, preferring the interface used by the Linux default route (helps avoid selecting `docker0`/bridge interfaces first).
- If Home Assistant host has multiple NICs/subnets, set `dial_bind_to_addresses` and/or `dial_bind_to_interfaces` in add-on options to force the DIAL listener onto reachable LAN interfaces (this is mainly useful when there are 2+ candidates).
- Temporarily set `exclude_regex` empty if you suspect over-filtering.
- Remove stale linked TV/device entries from YouTube/Google account device management and relaunch the app.

Notes:

- DNS is less commonly the root cause here than multicast filtering (mDNS/SSDP) or blocked TCP DIAL ports.
- Quick verification from phone VLAN: open `http://<HA-LAN-IP>:3099/healthz` and `http://<HA-LAN-IP>:3000/ssdp/device-desc.xml` (or the first active DIAL port from logs). If these are unreachable, YouTube will not list the bridge.
- The add-on does not provide a web UI. Use `/healthz` for status.

