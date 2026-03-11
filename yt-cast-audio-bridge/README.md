# YT Cast Audio Bridge Home Assistant Add-on

This folder packages the bridge as a Home Assistant add-on.

## Runtime behavior

- Primary target: Home Assistant Supervisor add-on runtime.
- Uses host networking for Cast discovery.
- Reads options from `/data/options.json` and maps to bridge environment variables.
- Persists state to `/data/yt-cast-audio-bridge/state/bridge-state.json`.

## Development

For local development, use the repository root app directly:

```bash
npm install
cp .env.example .env
npm start
```

## Install in Home Assistant

1. Add this repository URL in **Add-on Store → Repositories**.
2. Install **YT Cast Audio Bridge**.
3. Configure options as needed and start the add-on.
