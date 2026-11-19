# Contributing

Thanks for contributing.

## Setup

Node.js 22.12 or newer and, for the integration tests, the `openssl` command.

```bash
npm install        # runs `npm ci` in yt-cast-audio-bridge/app
npm run check      # type check + lint + tests; must pass before a pull request
```

The root `package.json` only forwards to `yt-cast-audio-bridge/app`. The app has its own
`package.json` and `package-lock.json` because Home Assistant builds the image from the add-on
folder alone.

## Running the bridge locally

```bash
cp .env.example yt-cast-audio-bridge/app/.env   # optional, adjust values
npm start
```

Without Home Assistant the bridge reads its options from environment variables (the option
name in upper case, see [`.env.example`](./.env.example)) and stores its state in
`yt-cast-audio-bridge/app/state/`. Set `UI_OPEN=1` to open the status page from your browser
at `http://localhost:3099/`. Be aware that a locally running bridge announces your real
speakers to every YouTube app in your network.

## Trying it without a speaker

```bash
cd yt-cast-audio-bridge/app
npm run fake-speaker -- 192.168.1.20 "Test Speaker"   # LAN address of this machine
```

This announces a fake Cast speaker and prints what the bridge sends to it. Start the bridge
with `PINNED_HOSTS="Test Speaker"` to offer only the fake one.

## Building the add-on image

```bash
docker build -t yt-cast-audio-bridge:dev yt-cast-audio-bridge
```

## Tests

- Unit tests live next to each other in `yt-cast-audio-bridge/app/test/`, one file per module.
- `test/link.integration.test.ts` runs the real Cast client library against
  `test/helpers/fake-cast-device.ts`, a small Cast receiver speaking the real protocol on localhost.
- New behaviour needs a test. Network, clock and child processes are injected, so tests need
  neither speakers nor YouTube.

## Keeping things in sync

A change is complete when these describe the same state:

- `version` in `yt-cast-audio-bridge/config.yaml` and `yt-cast-audio-bridge/app/package.json`
- options in `config.yaml` (`options` + `schema`), `app/src/config.ts`, `translations/*.yaml`, `DOCS.md` and `.env.example`
- `yt-cast-audio-bridge/CHANGELOG.md`
- `docs/architecture.md` when modules or their responsibilities change
- `THIRD_PARTY_NOTICES.md` when runtime dependencies change

## Commit style

Use clear, imperative commit messages.
