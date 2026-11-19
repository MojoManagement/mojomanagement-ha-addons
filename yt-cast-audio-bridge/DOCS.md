# YT Cast Audio Bridge

## How to use it

1. Install and start the add-on. No configuration is needed.
2. Open the **YouTube** or **YouTube Music** app on a phone in the same network.
3. Tap the Cast button. Your speakers appear as `Audio -> <speaker name>`.
4. Pick one and play something.

Click **Open Web UI** on the add-on page to see which speakers were found, which of them are
offered, and why a device is not offered. Each speaker has a switch to hide it.

## What works

- Play, pause, seek, next, previous, volume and mute from the YouTube app.
- Queue and autoplay: the next video starts on its own.
- Changes made on the speaker (volume buttons, "Hey Google, pause") show up in the app.
- Speaker groups from the Google Home app.
- Several phones connected to the same speaker.

Video is not shown anywhere; only the audio is played.

## Options

Every option has a description in the **Configuration** tab. The ones you are most likely to need:

| Option | Default | Purpose |
|---|---|---|
| `bridge_name_prefix` | `Audio ->` | Text in front of the speaker name in the Cast menu. May be empty. |
| `only_audio_like` | on | Hide devices with a screen. |
| `include_groups` | on | Offer Google Home speaker groups. |
| `exclude_regex` / `include_regex` | empty | Hide or select devices by name or IP address. |
| `pinned_hosts` | empty | Offer only the listed names, IP addresses or Cast ids. |
| `autoplay` | on | Continue with related videos when the queue ends. |
| `yt_dlp_auto_update` | on | Keep the YouTube lookup tool current. |
| `yt_cookies_file` | empty | `cookies.txt` for age-restricted or members-only videos, e.g. `/config/cookies.txt`. |
| `dial_base_port` | `3000` | First TCP port used; one port per offered speaker. |
| `dial_bind_to_addresses` / `dial_bind_to_interfaces` | empty | Only for hosts with several network cards. |

Options with invalid values are ignored with a warning on the status page; the add-on still starts.

## Network requirements

The add-on uses the host network because speakers and phones are found via multicast.

- Phone, speakers and Home Assistant should be in the **same network**.
- With separate VLANs, allow between the phone network and Home Assistant:
  SSDP (UDP 1900 to `239.255.255.250`), and TCP to the receiver ports shown on the status page
  (from `dial_base_port` upwards). Between Home Assistant and the speakers: mDNS (UDP 5353) and TCP 8009 (speaker groups use other ports, usually 32000 and up).
- The speakers fetch the audio directly from YouTube; they need internet access.

## Cookies file

Put a `cookies.txt` in Netscape format into this add-on's config folder
(`/addon_configs/<...>_yt_cast_audio_bridge/` on the host, visible as `/config` inside the add-on)
and set `yt_cookies_file` to `/config/cookies.txt`. The file is read-only for the add-on.
Treat it like a password: it gives access to the YouTube account it was exported from.

## Troubleshooting

Start with the status page: it names the problem in plain words (no speakers found, lookup
failing, port in use). The log at the bottom of the page shows what the add-on did.

More cases, including VLAN setups: <https://github.com/MojoManagement/mojomanagement-ha-addons/blob/main/docs/troubleshooting.md>

## Privacy and security

- The add-on talks to YouTube (to pair with your phone and to look up streams) and to GitHub
  (to download yt-dlp updates, unless `yt_dlp_auto_update` is off). Nothing else leaves your network.
- The status page is only reachable through Home Assistant. Port 3099 answers `/healthz` with
  version, uptime and the number of offered speakers, nothing more.
- Anyone in your network can cast to the offered speakers, just as with any Cast device.
