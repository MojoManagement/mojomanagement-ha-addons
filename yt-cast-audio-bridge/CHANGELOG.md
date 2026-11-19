# Changelog

## Unreleased

- _No changes yet._

## 1.0.3

- New: **Link with TV code.** Each offered speaker has a button on the status page that shows a code for the YouTube app ("Link with TV code"). This links a phone through YouTube's servers and works when the phone cannot find the bridge in the Cast menu, for example from another VLAN without SSDP forwarding. Several phones can link; each remembers the speaker afterwards.

## 1.0.2

- Fixed: the add-on ignored its configuration and used the defaults (`Could not read /data/options.json`), because the options file is readable for root only.

## 1.0.1

- Fixed: the add-on did not start in Home Assistant (`s6-overlay-suexec: fatal: can only run as pid 1`). Home Assistant builds add-ons on its own base image; the image now always uses the Node.js base it needs.
- Removed `build.yaml`, which current Supervisor versions ignore.

## 1.0.0

Complete rewrite. The add-on keeps its slug, so it updates in place; see "Upgrading" below.

### New

- **Status page** inside Home Assistant ("Open Web UI"): every Cast device found, why it is or is not offered, what is playing, a switch per speaker, a YouTube lookup test and the recent log.
- **Queue and autoplay**: the next video starts on its own when a track ends; "next" and "previous" in the YouTube app work.
- **Two-way sync**: pausing, stopping or changing the volume on the speaker (or in Google Home) shows up in the YouTube app.
- **Speaker groups** from Google Home are offered as well (`include_groups`).
- **yt-dlp keeps itself up to date** (`yt_dlp_auto_update`, checksum verified) and is updated right away when lookups start failing.
- Title, channel and cover art are shown on devices and apps that display Cast metadata.
- German and English descriptions for all options.

### More reliable

- Devices are identified by their Cast id instead of their IP address, so a new DHCP lease no longer creates a duplicate.
- Audio devices are recognised by the capabilities they announce, not by guessing from their name.
- Every network step towards a speaker has a timeout; a speaker that does not answer cannot block the others.
- The connection to a speaker is re-established after a network drop while the music keeps playing.
- A media error in the middle of a track (typically an expired stream URL) restarts the track at the same position.
- The speaker's own volume is used; starting playback no longer resets it to 50 %.
- One failing speaker no longer stops the others from being set up; failed starts are retried with growing pauses.
- Receiver ports are stable per speaker and are never handed out twice (this could happen after a restart).
- The pairing with the YouTube app survives restarts.
- Home Assistant's watchdog restarts the add-on if its control loop stops.

### Faster

- Stream lookups are cached until the URL expires, and the next track in the queue is looked up in advance.
- Speakers are found within about a second after start; the old fixed start-up delay is gone.

### Safer

- Runs as an unprivileged user inside the container.
- The status page and its API are only reachable through Home Assistant; `/healthz` exposes no details.
- Stream URLs and YouTube pairing tokens are removed from the log.
- Dependencies are pinned with a lockfile; `npm audit` reports no known vulnerabilities.

### Changed and removed

- Rewritten in TypeScript with a test suite; `chromecast-api`, `dotenv` and `yt-dlp-wrap` are gone.
- Supported architectures are `aarch64` and `amd64` (Home Assistant dropped 32-bit systems).
- Removed options: `dial_prefix_base`, `discovery_interval_ms`, `play_retry_ms`, `startup_grace_ms`, `allow_duplicate_friendly_names`, `health_port`, `yt_dlp_bin`. Speakers with the same name now get their IP address appended automatically.
- `exclude_regex` is empty by default; screens are hidden by `only_audio_like`.

### Upgrading from 0.9.0

- Speakers appear as new entries in the YouTube app once. Old entries can be removed in the YouTube app under "Linked devices".
- If you changed `exclude_regex` or `include_regex`, check that they still do what you want; they now match the device name and IP address.

## 0.9.0

- Reworked root README to reflect this project as a Home Assistant add-on repository.
- Documented add-on listing explicitly as one included add-on (`yt-cast-audio-bridge`).
- Rewrote add-on README to focus on add-on behavior, install context, and HA networking expectations.
- Set the `yt_cast_audio_bridge` add-on release version to `0.9.0`.
- Removed repository package versioning from the root workspace manifest (`package.json`), so versioning stays add-on scoped.
