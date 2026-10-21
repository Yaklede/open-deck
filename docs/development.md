# Development notes

This repository implements a macro deck independently, using the observed user workflow and public documentation. REA's static evidence was used to inspect the public web-client structure, not to extract the commercial companion or change its authentication.

The raw REA graph is intentionally kept outside the repository: it is approximately 142 MB and contains local source paths. `rea-analysis.json` contains a reproducible provenance receipt rather than that graph. REA reported zero parse failures, but its semantic graph is incomplete and does not establish runtime feature parity.

Public-source reference:

- Repository: https://github.com/Macro-Deck-App/Macro-Deck
- Tag: `v3.0.0-beta.18`
- Commit: `7089154cde506c0884bb39c4712863e0fef83d84`
- Analysis target: `ui/web-client`
- REA command: `rea analyze-javascript-application <source>/ui/web-client --json`

The new host protocol is intentionally small:

- `POST /api/pair`: single-use PIN to obtain a scoped device token.
- `GET /api/events`: authenticated SSE snapshots, including only display configuration and state.
- `GET /api/snapshot`: authenticated one-shot snapshot.
- `POST /api/action`: existing widget ID, timer gesture, or bounded volume value.
- `/api/admin/*`: separate Mac administrator session for configuration and devices.

Daily time automations use the host's local clock. The engine uses per-button in-flight exclusion and a short debounce. A process timeout kills the whole process group; requests are not accumulated for later execution. Chrome commands choose the ordinary user browser process, excluding browsers started with an explicit automation user-data directory.

The Android app requests only the Internet permission. It does not require accessibility, notification, camera, storage, or overlay access. Wake lock behavior uses a foreground window flag, and token backup is disabled.

Verification: Node integration tests cover pairing, permissions, invalid origins/configuration, revocation, token persistence across host instances, dropped duplicate taps, countdown state, and truncated Chrome session records. Android is built with release lint. Physical Samsung SM-T870 testing covers pairing, all configured app/site actions, routine completion, reconnect, live state, timer and volume controls.
