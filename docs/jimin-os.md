# Jimin OS extension · protocol 1

The host loads `host/extensions/jimin-os/manifest.json` and its native provider adapter through `Extensions`. The extension declares calendar, task, inbox, scheduled-work, notification and navigation capabilities. This is independent of the experimental Macro Deck protocol adapter.

Jimin OS owns its server session and publishes an explicit minimal read model through an authenticated loopback listener. Its private 0600 descriptor is located at `~/Library/Application Support/io.jimin.os/open-deck-bridge.json`. Open Deck requires an owned regular descriptor file, rejects symlinks or group/world-readable files, uses the exact loopback port and per-launch bearer credential, refuses redirects, applies timeouts, and rejects stale snapshots. The provider copies allowlisted fields again before broadcasting to paired devices. Original messages, notes, attachments, external links and OS server credentials are not shared.

## Display and actions

The OS page uses the existing editable page/widget model. It has an 8×6 grid with an actual month calendar, deadline markers, agenda, request overview, quick actions and notification history. Users can resize or move these widgets and add Jimin OS actions to other buttons. Source dates use Asia/Seoul. The calendar read window covers the current and next month, with bounded schedule/task/request/routine lists.

A paired tablet can invoke only configured widget actions. Calendar/agenda entity opening is additionally restricted to an ID in the provider's current shared snapshot. Arbitrary commands, URLs, API bodies and OS session access are not accepted. Duplicate in-flight actions are dropped and bounded rather than queued. The Jimin OS window is surfaced only for user navigation; polling and refresh do not take focus. Existing OS forms, read-only calendar behavior and write confirmations remain authoritative.

## Notifications

The initial inbox becomes the quiet baseline. New request IDs/revisions and upcoming schedule/deadline keys are persisted for deduplication. Lead time is configurable from 1 to 120 minutes (10 by default). The host stores at most 40 notifications and prunes old entries on delivery. Android maintains delivered IDs, limits reconnect bursts and uses a private-lockscreen notification channel. Tapping a system notification opens the OS page; the in-app feed remains available when notification permission is denied.

Notifications require both Mac clients and the tablet SSE connection. Delivery can continue while the Activity remains alive in the background, subject to Android process limits. There is no FCM, background foreground-service guarantee, force-stopped-client delivery or remote Internet relay.

## Disconnect and recovery

Disconnected or stale Jimin OS data is cleared from provider state. Open Deck's existing USB/pinned HTTPS Wi-Fi reconnect remains responsible for tablet transport. Jimin OS generates a new credential/port descriptor each launch; the provider rereads it for every request and reconnects without re-pairing. User-specific work data, notification history and credentials stay outside source and releases.
