# 0.6.0 validation

- Node: all 43 host tests pass, including telemetry sanitization, missing/stale values, bounded history and Grafana project validation.
- Android: signed release build and release lint pass; 18 gesture-physics checks pass.
- macOS: optimized arm64 Swift helper and app build pass; installed bundle passes deep/strict code-signature verification.
- A disposable single-thread busy-loop process measured 99.73% CPU across a six-second sample. This verifies Mach timebase conversion on Apple Silicon. The test stopped only its own processes.
- Android emulator at a tablet viewport displays all eight monitor cards using the real connected Mac's telemetry. CPU core details and CPU/memory process lists were checked through native dialogs. Project selection was changed and verified using the checked native choice, then returned to the default project.
- After the VPN-related access failure was resolved, Grafana health and data-source requests returned HTTP 200. The live dashboard rendered DB CPU gauges, committed TPS, readiness, memory, connections, QPS and service/HTTP charts in the desktop browser.
- The project selector was exercised in the live dashboard. The second project's service metrics replaced the first project's series; missing database metrics showed no data rather than substituted values. The default project was restored.
- Existing data-source queries returned three DB CPU series and approximately 10.2 committed transactions per second at verification time. DB memory now sums evictable/non-evictable categories within each cluster and pod, producing one total per node instead of duplicate labels.
- The user reconnected the physical Samsung SM-T870 and requested final validation there. The signed 0.6.0 APK was installed over 0.5.1 while preserving its pairing. Native Mac monitoring connected over pinned HTTPS Wi-Fi.
- On the tablet, tapping the Grafana card opened the live dashboard using the existing browser session. All three CPU gauges, committed TPS and readiness rendered. Selecting the second project in the native dialog opened its filtered dashboard with missing DB data correctly shown as unavailable. The default project was restored and rendered again.
- The configured tablet dashboard URL uses full kiosk mode to hide Grafana management navigation while retaining its project filter and charts. This avoids the sidebar taking a quarter of the tablet width. No Grafana credentials were copied or new browser terms accepted.
- No existing launcher action, production task/schedule write, database mutation or Mac reboot was performed. The emulator's pending browser setup was abandoned when the user chose physical-device testing.
