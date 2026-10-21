# 0.3.0 verification

Verified on 2026-10-21 using an Apple Silicon Mac and a physical Samsung Tab S7, Android 13, 2560 × 1600.

- Host: 27 passing Node tests covering migration/backup, geometry validation, typed controls, persistent state, cooldown, HTTP scalar/size limits, non-polling POST, authenticated image access, SSE deltas, pairing/TLS/revocation, plugin process/protocol and lifecycle boundaries.
- Native Android: signed release build and release lint pass; update installation preserves pairing. Mac app builds with its embedded Node runtime and pinned `ws` dependency. Dependency audit reports no known advisories at this check.
- Editor: resize through the inspector, undo and save were exercised; the restored independent grid persisted.
- Physical tablet: pinned Wi-Fi connection; existing launcher layout retained; independent 4×3 Focus and 6×4 Monitor layouts; clock, native month calendar, graphs, page links, image decoding, Boolean toggle and numeric slider tested. Tablet slider changed the real host variable from 25 to 80. A todo entered through the native dialog reached the host and was then removed. Temporary verification controls were removed.
- The configured ChatGPT button was pressed on the physical tablet over Wi-Fi; the host reported success in 38 ms. App-launch verification uses only that button. Other app launchers and the multi-app work-start routine are not exercised during verification.
- Plugin proof: official Sample Weather built against SDK 3.0.0-beta.18 connected directly to Open Deck's adapter, not the SDK test host. Executable source was unchanged; only its private test manifest's relative entrypoint was adjusted to the publish folder. `set-alert-threshold` changed the plugin-owned value from 30 to 23 and Open Deck read it back. Unsupported provider/UI/config capabilities were rejected. The synthetic sample is not installed in the user's deck or included in release downloads.

A short warmed page-switch trace on the tablet reduced frame time from median 13 ms / P95 15 ms to median 8 ms / P95 10 ms after reusing bounded widget views. The 120 Hz deadline metric still recorded missed deadlines; this is not a claim of zero jank. The trace recorded zero high-input-latency events and zero slow UI-thread events after caching. Native dialogs and the keyboard have separate startup costs.

This verifies the experimental protocol subset, not every store plugin, OAuth account, provider-specific widget, or hardware integration. See [coverage](feature-coverage.md) for the exact support boundary. Runtime recordings and personal configuration backups stay outside the repository.
