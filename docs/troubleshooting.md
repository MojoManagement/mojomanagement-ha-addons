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


## Crash on `chromecast-api` `status.currentTime` (TypeError)

If logs show a crash like:

- `TypeError: Cannot read properties of undefined (reading 'currentTime')`
- stack in `node_modules/chromecast-api/lib/device.js` near `getCurrentTime`

this is a known fragile path in the upstream library when status is temporarily undefined.
The bridge now avoids this call path and falls back to a safe position value.

Operationally this means playback control remains available, but position reporting can be less precise during transient Cast status gaps.

## Bridge not visible in YouTube app

If logs show `Receiver started ...` but the phone app still does not list bridge devices, this is usually a network reachability/discovery issue between phone and Home Assistant host.

### Required traffic (especially across VLANs / UniFi)

- **mDNS**: UDP `5353` to multicast `224.0.0.251` (Bonjour).
- **SSDP/DIAL discovery**: UDP `1900` to multicast `239.255.255.250` plus unicast replies back to the sender.
- **DIAL app endpoints**: inbound TCP on `DIAL_BASE_PORT` and following ports (default `3000-3024` for up to 25 receivers).
- **Health check (optional)**: TCP `3099` (`/healthz`) for diagnostics.

Notes for HA OS/add-on runtime:

- This add-on runs with `host_network: true`, so DIAL listeners are opened directly on the HA host network stack (not Docker bridge port publishing).
- In practice, most issues are upstream network policy (VLAN firewall/ACL/client isolation/multicast handling), not missing Docker port mappings.

Checklist:

- Ensure phone and HA host are in the same L2 segment/VLAN (no client isolation/guest Wi-Fi).
- Allow **both** discovery planes between phone VLAN and HA host VLAN: mDNS/Bonjour (`224.0.0.251:5353` UDP) **and** SSDP/DIAL (`239.255.255.250:1900` UDP).
- Allow inbound TCP from phone subnet to HA host on DIAL ports (`DIAL_BASE_PORT` and following ports, e.g. `3000-3024` for up to 25 receivers).
- On UniFi specifically: enabling only “mDNS” is often not enough for YouTube Cast discovery across VLANs; also allow/reflection/routing for SSDP multicast and the unicast reply path.
- Keep add-on on host networking (required for Cast discovery).
- Default behavior (when both bind options are empty): auto-pick a non-loopback LAN IPv4, preferring the interface used by the Linux default route (helps avoid selecting `docker0`/bridge interfaces first).
- If Home Assistant host has multiple NICs/subnets, set `dial_bind_to_addresses` and/or `dial_bind_to_interfaces` in add-on options to force the DIAL listener onto reachable LAN interfaces (this is mainly useful when there are 2+ candidates).
- Temporarily set `exclude_regex` empty if you suspect over-filtering.
- Remove stale linked TV/device entries from YouTube/Google account device management and relaunch the app.

Notes:

- DNS is less commonly the root cause here than multicast filtering (mDNS/SSDP) or blocked TCP DIAL ports.
- Quick verification from phone VLAN: open `http://<HA-LAN-IP>:3099/healthz` and a receiver DIAL descriptor URL with prefix, e.g. `http://<HA-LAN-IP>:3000/ytbridge/<receiver-host-slug>/ssdp/device-desc.xml` (or the first active DIAL port from logs). If these are unreachable, YouTube will not list the bridge.
- The add-on does not provide a web UI. Use `/healthz` for status.

### Common log lines that are usually normal

- Repeating `Incoming message: 'noop'` and `Not handled: 'noop'` lines are expected keepalive traffic from YouTube/YouTube Music long-poll connections.
- Occasional `RPC connection disconnected. Reconnecting...` followed by `RPC connection established.` is also normal; YouTube rotates these sessions.
- These lines by themselves do **not** indicate a discovery problem. If the bridge is still not visible in the YouTube app, focus on mDNS/SSDP/TCP reachability checks above.


## What to do now (practical debug checklist)

If the bridge still does not appear in YouTube, use this quick sequence.

1) Confirm bridge health from the same network as your phone

- Open `http://<HA-IP>:3099/healthz` from a phone browser (or another client in the same VLAN/Wi-Fi).
- If this fails, discovery will also fail. Fix routing/firewall first.

2) Confirm one DIAL endpoint is reachable

- Open a receiver DIAL descriptor URL with prefix, e.g. `http://<HA-IP>:3000/ytbridge/<receiver-host-slug>/ssdp/device-desc.xml` (or use the first active DIAL port from logs).
- If `/healthz` works but this does not, TCP DIAL ports are blocked.

3) Verify Home Assistant add-on networking assumptions

- Add-on must run with `host_network: true`.
- No extra Docker `ports:` mapping is required for DIAL ports in this mode.

4) UniFi / VLAN checks (most common root cause)

- Disable client isolation/guest isolation for test.
- Allow mDNS (`224.0.0.251:5353/udp`) between phone VLAN and HA VLAN.
- Allow SSDP multicast (`239.255.255.250:1900/udp`) plus unicast reply path.
- Allow inbound TCP from phone VLAN to HA host on DIAL range (`3000-3024` by default) and health port (`3099`).

5) Proxmox / VM checks

- VM NIC should be bridged to LAN (not NAT-only), with multicast allowed.
- If Linux firewall is active inside the HA host/VM, allow UDP 5353, UDP 1900, and TCP DIAL+health ports.
- If multiple NICs/subnets exist, pin listener with add-on options `dial_bind_to_addresses` and/or `dial_bind_to_interfaces`.

6) App-side sanity checks

- Temporarily clear `exclude_regex` to avoid filtering out targets.
- Remove stale linked TV/device entries in YouTube/Google account device list, then restart YouTube app.

If you can share results of steps 1 and 2 (`healthz` and `device-desc.xml` reachable yes/no), you can usually identify whether this is firewall/VLAN vs. app config in under 2 minutes.

### If you see `Cannot GET /ssdp/device-desc.xml`

This usually means the request path is missing the configured DIAL prefix and receiver slug.

- Default add-on setting is `DIAL_PREFIX_BASE=/ytbridge`.
- Effective URL shape is: `http://<HA-IP>:<receiver-port><DIAL_PREFIX_BASE>/<receiver-host-slug>/ssdp/device-desc.xml`
- Example: `http://ha.proxmox:3001/ytbridge/92c38ccd-66b9-de76-5de9-bb139636ae04-local/ssdp/device-desc.xml`

`receiver-host-slug` is derived from host by lowercasing and replacing non-alphanumeric characters with `-`.


### If XML opens in browser but device is still not shown in YouTube

If you see the DIAL XML (`<root xmlns="urn:schemas-upnp-org:device-1-0"> ...`), that endpoint is working.
The browser message "This XML file does not appear to have any style information" is normal and not an error.

At this point, the most likely issue is SSDP discovery path (multicast M-SEARCH/NOTIFY and reply path), not HTTP serving.

Quick deep checks:

- Verify the add-on announces on SSDP and receives M-SEARCH from your phone subnet.
- Prefer testing with HA host IP in URLs (`http://<HA-LAN-IP>:...`) instead of only mDNS hostnames.

Linux capture examples (HA host / VM / Proxmox bridge side):

```bash
# See SSDP multicast queries/announces
sudo tcpdump -ni any udp port 1900

# See mDNS traffic
sudo tcpdump -ni any udp port 5353

# See whether phone reaches DIAL HTTP endpoint on receiver ports
sudo tcpdump -ni any 'tcp portrange 3000-3024'
```

Expected when discovery works:

- Phone sends SSDP `M-SEARCH` to `239.255.255.250:1900`.
- HA host/bridge sends SSDP responses (unicast back to phone IP) and/or `NOTIFY` announcements.
- Phone then requests the DIAL XML URL and later app endpoints.

If XML is reachable manually but YouTube app still shows nothing, prioritize UniFi rules for:

- Multicast forwarding/reflection for SSDP (not only mDNS).
- Unicast return traffic from HA host VLAN to phone VLAN.
- No client isolation/guest isolation on phone SSID.
