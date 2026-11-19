# Architecture

## What happens when you cast

```
YouTube app ──SSDP/DIAL──▶ virtual receiver (one per speaker, own TCP port)
     │                          │  yt-cast-receiver: pairs with the app via YouTube's lounge API
     │  play video X            ▼
     └────────────────▶ ForwardingPlayer ──▶ YtDlpResolver ──▶ yt-dlp ──▶ audio stream URL
                                │
                                ▼
                           CastLink ──CASTV2/TLS──▶ real speaker (Default Media Receiver)
                                ▲                         │
                                └── status: finished, paused, volume ──┘
```

The speaker downloads the audio straight from YouTube. The bridge only passes the URL and
relays commands and status in both directions.

## Modules

All code is in `yt-cast-audio-bridge/app/src`.

| Module | Responsibility |
|---|---|
| `main.ts` | Wires everything together, collects problems for the status page, handles shutdown and stray errors. |
| `config.ts` | Reads options from `/data/options.json` or environment variables. Invalid values become warnings, never a crash. |
| `net.ts` | Chooses the LAN address to listen on (the interface of the default route, never a container bridge). |
| `cast/discovery.ts` | Finds Cast devices via mDNS and assembles them from DNS records. |
| `cast/device.ts` | Device model and the "is this an audio-only device" rule (Cast capability bits). |
| `cast/registry.ts` | Remembers devices by Cast id; knows which are online. |
| `cast/link.ts` | The connection to one speaker: serialized commands with timeouts, reconnect, status events, release when idle. |
| `resolver/ytdlp.ts` | Video id → stream URL through `yt-dlp`, with cache and de-duplication. |
| `resolver/updater.ts` | Picks the `yt-dlp` binary and keeps a verified copy up to date. |
| `bridge/player.ts` | Implements the receiver library's player on top of `CastLink` and the resolver. |
| `bridge/receiver.ts` | One virtual YouTube receiver for one speaker. |
| `bridge/supervisor.ts` | Decides which speakers get a receiver, starts and stops them, assigns ports, retries failures. |
| `state.ts` | JSON state file (ports, switched-off speakers, pairing data) with atomic writes. |
| `http.ts` | `/healthz`, the status page and its API. |
| `logger.ts`, `util.ts` | Logging with secret redaction; timeouts, serial queue, backoff. |

The status page is plain HTML/CSS/JS in `yt-cast-audio-bridge/app/ui` and needs no build step.

## Design rules

- **Nothing may hang.** Every call to a speaker, to `yt-dlp` and to the network has a timeout.
- **One speaker's failure stays local.** Each speaker has its own receiver, connection and retry timer.
- **Identity is the Cast id**, not the IP address or name. Ports and pairing data are stored per id.
- **Dependencies are injected** (clock, network clients, process execution), so each module is tested without hardware.
- **State on disk is small and disposable.** If the state file is unreadable it is set aside and the bridge starts fresh.

## Runtime

- TypeScript compiled to plain JavaScript at image build time; Node.js 24 in the image.
- Three direct dependencies for the protocols (`yt-cast-receiver`, `castv2-client`, `multicast-dns`); everything else uses Node's standard library.
- Data folder inside the add-on: `/data/yt-cast-audio-bridge/` (`state.json`, `yt-dlp/`).
- The process runs as the unprivileged user `bridge`; see [`../yt-cast-audio-bridge/run.sh`](../yt-cast-audio-bridge/run.sh).
