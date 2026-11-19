# Known Limitations

- **Audio only.** The video picture is not shown anywhere.
- **Depends on unofficial interfaces.** The receiver side uses `yt-cast-receiver`, the stream lookup uses `yt-dlp`. Either can break when YouTube changes something. The add-on updates `yt-dlp` on its own; a broken receiver library needs a new add-on release.
- **Start delay.** The first lookup of a video takes a few seconds. Following tracks in a queue are looked up in advance.
- **Live streams** are played when YouTube offers a format the speaker understands; seeking is not possible, and some speakers refuse them.
- **Age-restricted, private and members-only videos** need a cookies file (`yt_cookies_file`).
- **Ads** are not played; premium-only audio qualities are not available.
- **Speaker identity in the app.** After the add-on restarts, the YouTube app may need a few seconds to find the speakers again. The technical device id announced via DIAL changes on every start; this is a property of the receiver library.
- **Same network.** Discovery relies on multicast (mDNS, SSDP). Across VLANs it only works with matching firewall and multicast rules, see [troubleshooting](./troubleshooting.md).
- **Speakers need internet access**, because they fetch the audio from YouTube themselves.
