# 0.8.2 validation

- 60 Node tests and 18 Java gesture checks pass. The added parser regression verifies exact node identity, independent CPU/memory/actual bytes, ambiguous CPU samples, missing bytes and exclusion of exporter identities.
- Signed Android release build/lint and optimized Mac app/helper build pass. Installed Mac bundle passes deep/strict signature verification; health reports 0.8.2.
- The physical Samsung tablet runs 0.8.2 and reconnects over its existing encrypted Wi-Fi pairing. The main Monitor card displays all three observed DB nodes with CPU percentage, a separate bounded one-hour CPU sparkline, memory percentage and matching actual GiB. Total TPS/QPS remain explicitly labeled aggregates.
- The native DB details retain numeric KPIs and graph selection, with CPU/memory values for each DB node. Selecting the second project shows its system CPU while unavailable DB telemetry stays unknown; the default project is restored.
- No page layout or saved configuration is changed. Workspace remains identical to the existing private configuration backup; OS presentation, labels, thresholds and notification settings are preserved. Live screenshots and signed build archives remain private local artifacts.
- No production calendar/task or database writes, unrelated launcher actions or Mac reboot are performed.
