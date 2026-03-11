# YT Cast Audio Bridge (Home Assistant Add-on)

This folder defines the **single add-on** contained in this repository.

- Add-on name: `YT Cast Audio Bridge`
- Slug: `yt_cast_audio_bridge`
- Definition file: [`config.yaml`](./config.yaml)

## What this add-on does

The add-on creates virtual YouTube Cast receivers and forwards playback to discovered Cast audio devices on your LAN.

## Home Assistant behavior

- Runs with `host_network: true` (required for Cast discovery).
- Reads options from `/data/options.json`.
- Starts the bridge via [`rootfs/usr/local/bin/run-bridge.sh`](./rootfs/usr/local/bin/run-bridge.sh).
- Exposes health status on `/healthz` (default port `3099`).

## Important networking notes

- No add-on web UI is provided.
- mDNS (`5353/udp`) and SSDP (`1900/udp`) must be reachable between phone/client and Home Assistant host.
- DIAL receiver ports (`DIAL_BASE_PORT` range, default `3000-3024`) must be reachable from client VLAN/subnet.

If devices are not visible in YouTube, check [`../docs/troubleshooting.md`](../docs/troubleshooting.md).

## Local development

The packaged add-on runs the same Node.js app as local development in `app/`.

From repository root:

```bash
npm install
cp .env.example .env
npm start
```
