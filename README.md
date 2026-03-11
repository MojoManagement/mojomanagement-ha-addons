# MojoManagement Home Assistant Add-ons

This is a **Home Assistant add-on repository**.

It currently contains **one add-on**:

- [`yt-cast-audio-bridge`](./yt-cast-audio-bridge): Virtual YouTube receivers that forward playback to Cast audio devices.

## Add this repository to Home Assistant

1. Open **Settings → Add-ons → Add-on Store**.
2. Open the menu (**⋮**) → **Repositories**.
3. Add this repository URL.
4. Refresh the store.
5. Open the add-on `YT Cast Audio Bridge` and install it.

Repository metadata is defined in [`repository.yaml`](./repository.yaml).

## Included add-on

### YT Cast Audio Bridge (`yt_cast_audio_bridge`)

- Folder: [`yt-cast-audio-bridge/`](./yt-cast-audio-bridge/)
- Add-on config: [`yt-cast-audio-bridge/config.yaml`](./yt-cast-audio-bridge/config.yaml)
- Runtime app source: [`yt-cast-audio-bridge/app`](./yt-cast-audio-bridge/app)
- Health endpoint: `http://<HA-IP>:3099/healthz`

For full usage and network notes, see [`yt-cast-audio-bridge/README.md`](./yt-cast-audio-bridge/README.md).

## Development (repository)

```bash
npm install
npm run lint
npm test
npm run smoke
```

## Documentation

- Architecture: [`docs/architecture.md`](./docs/architecture.md)
- Troubleshooting: [`docs/troubleshooting.md`](./docs/troubleshooting.md)
- Limitations: [`docs/limitations.md`](./docs/limitations.md)

## Legal

- License: [`LICENSE`](./LICENSE)
- Notice: [`NOTICE`](./NOTICE)
- Third-party notices: [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)
