# Troubleshooting

Open the status page first (**Open Web UI** on the add-on page). It lists every Cast device
that was found, says why a device is not offered, and shows problems at the top.

## No speakers on the status page

The add-on does not see any Cast device.

- Speakers and Home Assistant must be in the same network. Across VLANs, mDNS (UDP 5353 to `224.0.0.251`) has to be forwarded or reflected.
- Home Assistant in a VM (Proxmox, VirtualBox): the virtual network card must be **bridged** to the LAN, not NAT.
- Several network cards: check "Address" under **Network** on the status page. If it is the wrong one, set `dial_bind_to_addresses` to the LAN address of the Home Assistant host.
- Click **Search again** after changing something in the network.

## A speaker is listed but "Not shown"

The reason is written next to it:

| Reason | What to do |
|---|---|
| Has a screen (`only_audio_like`) | Intended for TVs and displays. Turn `only_audio_like` off to offer them anyway. |
| Matches `exclude_regex` / Does not match `include_regex` | Adjust the expression. It is matched against "name IP-address", ignoring case. |
| Not listed in `pinned_hosts` | Add the name, IP address or Cast id, or empty the list. |
| Speaker groups are turned off | Turn `include_groups` on. |
| Switched off here | Use the switch on the status page. |
| More than `max_receivers` devices | Raise `max_receivers`. |

## Speakers are offered, but the YouTube app does not show them

The phone cannot find or reach the add-on.

1. The phone must be in the same network as Home Assistant, without "client isolation" or a guest Wi-Fi.
2. From the phone's browser open `http://<HA-IP>:3099/healthz`. If that does not load, the phone cannot reach the Home Assistant host at all.
3. On the status page, each offered speaker has a **reachability test link**. Open that address in the phone's browser. An XML page means the receiver is reachable; the remaining problem is discovery (SSDP). No page means the TCP port is blocked between phone and Home Assistant.
4. Across VLANs allow, from the phone network to the Home Assistant host:
   - SSDP: UDP 1900 to multicast `239.255.255.250`, and the unicast answers back
   - TCP to the receiver ports listed on the status page

   On UniFi, enabling "mDNS" alone is not enough; SSDP must be forwarded as well.
5. Restart the YouTube app. It caches the device list.

Watching the traffic on the Home Assistant host:

```bash
tcpdump -ni any udp port 1900              # SSDP queries from the phone and the answers
tcpdump -ni any udp port 5353              # mDNS
tcpdump -ni any 'tcp portrange 3000-3024'  # the phone talking to the receivers
```

## Casting connects, but nothing plays

Look at the speaker's card on the status page ("Last playback failed: ...") and at the
**YouTube lookup** section.

- Click **Test now**. If the lookup fails, click **Update yt-dlp**. With `yt_dlp_auto_update` on this also happens automatically after repeated failures.
- "Sign in to confirm ..." or age-restricted videos: configure `yt_cookies_file`.
- Lookup works but the speaker stays silent: the speaker must be able to reach the internet (it downloads the audio itself). Check DNS and firewall rules for the speaker.
- "Cast device is offline" or "Connecting to ... timed out": Home Assistant cannot reach the speaker on TCP 8009 (groups: the port the group announces).

## Playback stops in the middle of a track

- "Playback ended on the speaker (app-closed)" in the log: something else started playing on that speaker (Spotify, a Home Assistant TTS message, another cast).
- "Speaker reported a media error": the add-on restarts the track once at the same position. If it happens regularly, the speaker's connection to YouTube is unstable.

## A receiver cannot start ("Problem" badge)

The message names the cause. The usual one is a port that is already in use on the Home
Assistant host; the add-on then moves that speaker to the next free port by itself. If many
ports around `dial_base_port` are taken, choose another `dial_base_port`.

## Old entries in the YouTube app

Entries from earlier versions or renamed speakers can be removed in the YouTube app:
**Settings → Watch on TV → Linked devices** (wording differs between app versions).

## Log lines that are normal

With `log_level: DEBUG`:

- `Incoming message: 'noop'` — keep-alive traffic from YouTube.
- `RPC connection disconnected. Reconnecting...` followed by `RPC connection established.` — YouTube rotates these connections.

## Reporting a problem

Include the add-on version, the text of the problems shown on the status page and the log
from the bottom of that page. Stream URLs and pairing tokens are already removed from it.
