# MojoManagement Home Assistant Add-ons

This is a **Home Assistant add-on repository**. It contains one add-on:

- [`yt-cast-audio-bridge`](./yt-cast-audio-bridge): cast YouTube and YouTube Music to speakers that only support Cast audio.

## Add this repository to Home Assistant

1. Open **Settings → Add-ons → Add-on Store**.
2. Open the menu (**⋮**) → **Repositories**.
3. Add `https://github.com/MojoManagement/mojomanagement-ha-addons`.
4. Refresh the store, open **YT Cast Audio Bridge** and install it.

How to use the add-on: [`yt-cast-audio-bridge/DOCS.md`](./yt-cast-audio-bridge/DOCS.md).

## Repository layout

| Path | Content |
|---|---|
| [`repository.yaml`](./repository.yaml) | Repository metadata for Home Assistant |
| [`yt-cast-audio-bridge/`](./yt-cast-audio-bridge/) | Add-on packaging: `config.yaml`, `Dockerfile`, `run.sh`, `translations/`, `DOCS.md`, `CHANGELOG.md` |
| [`yt-cast-audio-bridge/app/`](./yt-cast-audio-bridge/app) | The bridge itself (TypeScript, Node.js) with tests and the status page |
| [`docs/`](./docs) | [Architecture](./docs/architecture.md), [troubleshooting](./docs/troubleshooting.md), [limitations](./docs/limitations.md) |

## Development

Requires Node.js 22.12 or newer. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

```bash
npm install      # installs the app's dependencies from its lockfile
npm run check    # type check, lint and tests
npm start        # build and run the bridge on this machine
```

## Legal

- License: [`LICENSE`](./LICENSE)
- Notice: [`NOTICE`](./NOTICE)
- Third-party notices: [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)
- Security policy: [`SECURITY.md`](./SECURITY.md)
