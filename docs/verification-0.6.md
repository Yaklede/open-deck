# 0.6.0 validation

- Node: all 43 host tests pass, including telemetry sanitization, missing/stale values, bounded history and Grafana project validation.
- Android: signed release build and release lint pass; 18 gesture-physics checks pass.
- macOS: optimized arm64 Swift helper and app build pass; installed bundle passes deep/strict code-signature verification.
- A disposable single-thread busy-loop process measured 99.73% CPU across a six-second sample. This verifies Mach timebase conversion on Apple Silicon. The test stopped only its own processes.
- Android emulator at a tablet viewport displays all eight monitor cards using the real connected Mac's telemetry. CPU core details and CPU/memory process lists were checked through native dialogs. Project selection was changed and verified using the checked native choice, then returned to the default project.
- The Grafana card dispatches an Android browser intent. Browser setup is required on this emulator; its Terms of Service were not accepted by the test. Live dashboard rendering remains unverified because the Grafana host began returning HTTP 403, including existing dashboards and its health API.
- Before that access failure, dashboard creation succeeded and existing data-source queries returned three DB CPU series and actual Galera commit rates. These results establish the queries, not continued availability during the access failure.
- Physical tablet testing was intentionally excluded because the user disconnected it and requested emulator testing. No existing launcher action, production task/schedule write, database mutation or Mac reboot was performed.
