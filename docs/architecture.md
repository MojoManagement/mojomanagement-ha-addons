# Architecture

`yt-cast-audio-bridge` is split into:

- `registry`: discovers and tracks Cast devices.
- `bridge-supervisor`: creates/removes virtual receivers based on registry state.
- `device-receiver`: wraps `yt-cast-receiver` and maps player controls.
- `resolver`: resolves YouTube IDs to playable audio URLs via `yt-dlp`.
- `cast-target`: forwards commands to real Cast target.
- `state-store`: persists stable host metadata (e.g., allocated dial ports).
- `health-server`: exposes `/healthz` status.
