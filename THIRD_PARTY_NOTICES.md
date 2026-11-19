# Third-Party Notices

This project depends on third-party software. Always verify current license terms in the upstream repositories before redistribution or commercial use.

## Runtime components

| Component | Used for | License (as published upstream) |
|---|---|---|
| [`yt-cast-receiver`](https://github.com/patrickkfkan/yt-cast-receiver) | YouTube receiver protocol (DIAL, lounge API) | MIT |
| [`castv2-client`](https://github.com/thibauts/node-castv2-client), [`castv2`](https://github.com/thibauts/node-castv2) | Talking to Cast devices | MIT |
| [`multicast-dns`](https://github.com/mafintosh/multicast-dns) | Finding Cast devices | MIT |
| [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) | Looking up audio streams; downloaded into the image and updated at runtime, not part of this repository | Unlicense (bundles components under other licenses) |
| Node.js, Python, Alpine Linux | Runtime inside the container image | see upstream |

The complete list of npm packages with exact versions is in
[`yt-cast-audio-bridge/app/package-lock.json`](./yt-cast-audio-bridge/app/package-lock.json).

## Important upstream caveat

`yt-cast-receiver` documentation references a forked `peer-dial` variant with wording similar to “free for non-commercial use”.
If you plan to use this project commercially, review the full transitive dependency and license chain first.

## Terms of service

Playing YouTube content through this bridge may not be covered by YouTube's Terms of Service. Use it for personal purposes at your own responsibility.
