# YT Cast Audio Bridge (beta)

Virtual YouTube receivers that forward playback to Cast audio devices.

> Status: **hardened experimental / beta**. This project is not marketed as production-ready.

## What it does

Creates one virtual YouTube Cast receiver per discovered Cast audio target and forwards playback commands/media to the real target.

## What it does not do

- No guarantee for every Cast device/model/network.
- No official Google support path.
- No DLNA/AirPlay backend support out of the box.

## Architecture (short)

1. YouTube app connects to a virtual receiver via DIAL/MDX.
2. Receiver translates controls into a local forwarding player.
3. Player resolves audio stream URL and forwards to a real Cast audio target.

## Requirements

- Node.js 20+
- `yt-dlp` in PATH (or configured via `YT_DLP_BIN`). If missing, `npm install` tries to download a local fallback binary into `tools/bin/`.
- Same LAN for sender, bridge host, and Cast devices
- Discoverable Cast devices

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Health endpoint: `http://localhost:3099/healthz`

## Configuration

See `.env.example` for all options.

For multi-NIC hosts (or when auto-detect chooses the wrong path), you can pin DIAL/SSDP binding explicitly in `.env`:

```bash
DIAL_BIND_TO_ADDRESSES=192.168.50.137
DIAL_BIND_TO_INTERFACES=enp6s18
```

`npm start` and the Home Assistant add-on use the same Node entrypoint (`src/index.mjs`) and the same config parser; the add-on only injects values from `/data/options.json` into environment variables before launching Node.

## Home Assistant add-on

This repository is also a Home Assistant custom add-on repository with one add-on at `yt-cast-audio-bridge/` (plus `repository.yaml` at repo root).

Use Home Assistant Add-on Store → Repositories and add this GitHub URL to install it.

## Troubleshooting

See `docs/troubleshooting.md`.

## Known limitations

See `docs/limitations.md`.

## Legal and notices

- Third-party notices: `THIRD_PARTY_NOTICES.md`
- Additional notice: `NOTICE`

Important: `yt-cast-receiver` documents usage of a forked `peer-dial` variant marked “free for non commercial use”. Review before commercial usage.

## License

MIT (`LICENSE`).
