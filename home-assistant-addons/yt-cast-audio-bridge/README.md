# YT Cast Audio Bridge Add-on

Home Assistant add-on packaging for `yt-cast-audio-bridge`.

## What this add-on does

- Runs a dedicated Node.js bridge service.
- Creates virtual YouTube receivers and forwards playback to discovered Cast audio devices.
- Exposes bridge health endpoint on port `3099` by default.

## Installation (custom repository)

1. Push this folder into your add-on repository (for example `mojomanagement-ha-addons`).
2. In Home Assistant, open **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
3. Add your repository URL.
4. Install **YT Cast Audio Bridge**.
5. Start the add-on and check logs.

## Notes

- The add-on runs in `host_network` mode so local Cast discovery can work correctly.
- Configuration options map directly to the bridge environment variables.
- Runtime state is stored at `/data/yt-cast-audio-bridge/state/bridge-state.json`.
