# Jimin OS extension · protocol 1

The host loads `host/extensions/jimin-os/manifest.json` and its native provider adapter through `Extensions`. The extension declares calendar, task, inbox, scheduled-work, notification and navigation capabilities. This is independent of the experimental Macro Deck protocol adapter.

Jimin OS owns its server session and publishes an explicit minimal read model through an authenticated loopback listener. Its private 0600 descriptor is located at `~/Library/Application Support/io.jimin.os/open-deck-bridge.json`. Open Deck requires an owned regular descriptor file, rejects symlinks or group/world-readable files, uses the exact loopback port and per-launch bearer credential, refuses redirects, applies timeouts, and rejects stale snapshots. The provider copies allowlisted fields again before broadcasting to paired devices. Original messages, notes, attachments, external links and OS server credentials are not shared.

## Display and actions

The OS page uses the existing editable page/widget model. It has an 8×6 grid with an actual month calendar, deadline markers, agenda, request overview, quick actions and notification history. Users can resize or move these widgets and add Jimin OS actions to other buttons. Source dates use Asia/Seoul. The calendar read window covers the current and next month, with bounded schedule/task/request/routine lists.

A paired tablet can invoke only configured widget actions. Calendar/agenda entity opening is additionally restricted to an ID in the provider's current shared snapshot. Arbitrary commands, URLs, API bodies and OS session access are not accepted. Duplicate in-flight actions are dropped and bounded rather than queued. The Jimin OS window is surfaced only for user navigation; polling and refresh do not take focus. Native Android forms support schedule creation and task completion without surfacing the Mac window. Task completion requires confirmation and an optional note; the existing server applies its normal ITSM/Google Chat synchronization rules. Other quick actions continue to navigate to the Mac app.

## Notifications

The initial inbox becomes the quiet baseline. New request IDs/revisions and upcoming schedule/deadline keys are persisted for deduplication. Lead time is configurable from 1 to 120 minutes (10 by default). The host stores at most 40 notifications and prunes old entries on delivery. Android maintains delivered IDs, limits reconnect bursts and uses a private-lockscreen notification channel. Tapping a system notification opens the OS page; the in-app feed remains available when notification permission is denied.

Notifications require both Mac clients and the tablet SSE connection. Delivery can continue while the Activity remains alive in the background, subject to Android process limits. There is no FCM, background foreground-service guarantee, force-stopped-client delivery or remote Internet relay.

## Disconnect and recovery

Disconnected or stale Jimin OS data is cleared from provider state. Open Deck's existing USB/pinned HTTPS Wi-Fi reconnect remains responsible for tablet transport. Jimin OS generates a new credential/port descriptor each launch; the provider rereads it for every request and reconnects without re-pairing. User-specific work data, notification history and credentials stay outside source and releases.

## Direct tablet writes

Snapshots advertise `capabilities.scheduleCreate` and `capabilities.taskComplete`, and shared tasks include their optimistic-concurrency `version`. Older companion bridges keep these capabilities disabled. Calendar dates and the schedule button open a native title/start/end/notes form; the task button includes undated tasks and opens native completion confirmation.

Paired clients submit only scoped requests through `POST /api/extensions/jimin-os/mutations` with `widgetId`, a UUIDv7 `mutationId` and either `create-schedule` or `complete-task` fields. The host strips unknown fields and restricts operations to configured OS widgets. Receipts at `GET /api/extensions/jimin-os/mutations/{id}` belong to the device that submitted them, including after host restart. Both routes are available over USB and pinned HTTPS Wi-Fi; admin/editor routes remain loopback-only.

Jimin OS accepts writes through authenticated loopback `POST /v1/mutations`, persists a private receipt journal before dispatch, and exposes `GET /v1/mutations/{id}`. The Mac frontend uses its existing authenticated session and server APIs, without sharing credentials or focusing its window. Task writes use the published ID and expected version. Schedule writes use the same UUID as the server mutation ID. Repeated IDs with different contents are rejected. The journal is bounded to 200 records/24 hours. Restarted or stalled work becomes uncertain and is never automatically replayed.

Android retains one pending request privately. Reopening a write action first offers status recovery. A deliberate retry reuses the same ID; the server state is read before retrying schedule creation or task completion, so lost acknowledgements do not cause duplicate schedules or repeated completion notes. Unknown results are displayed as requiring verification rather than cancellation.

## Touch navigation

Swipe left/right across page content to move between adjacent pages. Horizontal and vertical gestures lock independently; sliders retain their drag, and dialogs do not participate in page swipes. Boundaries do not wrap. Both swipes and bottom navigation use a 240ms directional slide of cached native views, with no full-screen bitmap capture. Android's disabled-animation setting is respected. Taps during a transition do not trigger widget actions.
