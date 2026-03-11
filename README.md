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

## Home Assistant add-on repository

Use `scripts/bootstrap-ha-addon-repo.sh` to generate the dedicated Home Assistant add-on repository scaffold (for example `mojomanagement-ha-addons`) from this bridge source tree.

## Home Assistant Add-on packaging

A production-oriented Home Assistant add-on packaging scaffold is available in `home-assistant-addons/yt-cast-audio-bridge/`.

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
