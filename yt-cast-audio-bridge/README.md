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

## Home Assistant notes

- This add-on does **not** provide a web UI.
- If Home Assistant opens the add-on page and shows a 504 from nginx, this is expected for this add-on and does not indicate the bridge failed.
- Health check endpoint is JSON on `/healthz` (and `/` returns a short status hint).

- For visibility issues in the YouTube app (device not listed despite running receivers), see `../docs/troubleshooting.md` section "Bridge not visible in YouTube app" (mDNS + DIAL port reachability checklist).
- Default DIAL binding (with empty bind options) auto-selects the first non-loopback LAN IPv4 detected by the host.
- On HA setups with multiple interfaces/VLANs, use add-on options `dial_bind_to_addresses` / `dial_bind_to_interfaces` to pin DIAL listeners to the LAN-reachable interface.

