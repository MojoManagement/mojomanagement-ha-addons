# Security Policy

## Reporting

Please report vulnerabilities privately before public disclosure, using GitHub's
"Report a vulnerability" button on the repository's **Security** tab.

Include:

- affected version(s)
- reproduction steps
- impact assessment
- suggested mitigation (if known)

## Security model of the add-on

- It runs on the host network, as an unprivileged user inside its container, with write access only to its own data folder.
- The receiver ports (from `dial_base_port` upwards) accept connections from the local network without authentication. That is how Cast works: anyone in the network can cast to an offered speaker.
- The status page and its API accept requests only from Home Assistant's ingress proxy and from localhost. `/healthz` is public and returns version, uptime and the number of offered speakers.
- Video ids received from phones are validated before they are passed to `yt-dlp`, which is started without a shell.
- `yt-dlp` updates are downloaded from the project's GitHub releases over HTTPS and checked against the SHA-256 sums published with the release. This protects against corrupted downloads, not against a compromised upstream release; turn `yt_dlp_auto_update` off if you prefer the pinned version shipped with the image.
- Stream URLs and YouTube pairing tokens are removed from log output.
