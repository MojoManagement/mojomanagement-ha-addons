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

### Netzwerk-/Port-Konfiguration (Home Assistant)

- Es gibt **keine** Add-on-Weboberfläche. Das ist normal.
- Das Add-on läuft mit `host_network: true`; deshalb werden keine klassischen Docker-`ports:`-Mappings für DIAL benötigt.
- Relevante Ports:
  - UDP `5353` mDNS (Discovery)
  - UDP `1900` SSDP/DIAL Discovery
  - TCP `DIAL_BASE_PORT` bis `DIAL_BASE_PORT + MAX_RECEIVERS - 1` (Standard `3000-3024` bei `max_receivers: 25`)
  - TCP `HEALTH_PORT` (Standard `3099`) für `/healthz`
- Wenn YouTube-Geräte nicht erscheinen, ist meistens VLAN/Multicast/Firewall die Ursache, nicht fehlendes Docker-Port-Publishing.

- This add-on does **not** provide a web UI.
- If Home Assistant opens the add-on page and shows a 504 from nginx, this is expected for this add-on and does not indicate the bridge failed.
- Health check endpoint is JSON on `/healthz` (and `/` returns a short status hint).
- With `host_network: true`, DIAL ports are exposed on the HA host network directly; there is no Docker bridge port publishing for receiver ports.

- For visibility issues in the YouTube app (device not listed despite running receivers), see `../docs/troubleshooting.md` section "Bridge not visible in YouTube app" (mDNS + SSDP + DIAL reachability checklist, including UniFi VLAN notes).
- Default DIAL binding (with empty bind options) auto-selects a LAN IPv4, preferring the Linux default-route interface (to avoid `docker0`/bridge interfaces where possible).
- On HA setups with multiple interfaces/VLANs, use add-on options `dial_bind_to_addresses` / `dial_bind_to_interfaces` to pin DIAL listeners to the LAN-reachable interface.


### Schnelltest wenn YouTube nichts anzeigt

1. Im gleichen WLAN/VLAN wie das Handy öffnen:
   - `http://<HA-IP>:3099/healthz`
   - `http://<HA-IP>:3000/ytbridge/<receiver-host-slug>/ssdp/device-desc.xml`
2. Wenn eine URL nicht erreichbar ist: zuerst VLAN/Firewall/UniFi-Regeln prüfen (mDNS+SSDP+TCP DIAL).
3. `noop`-Logs und gelegentliche RPC-Reconnects sind normal und nicht automatisch ein Fehler.


Hinweis: `Cannot GET /ssdp/device-desc.xml` bedeutet meist, dass Prefix/Slug im Pfad fehlt.


Erwartung: Wenn im Browser XML mit `<root xmlns="urn:schemas-upnp-org:device-1-0">` kommt, ist der DIAL-HTTP-Endpunkt erreichbar.
Falls es trotzdem nicht in YouTube erscheint, liegt es meist an SSDP/Multicast/Reply-Pfad im Netzwerk (UniFi/VLAN), nicht am XML selbst.
