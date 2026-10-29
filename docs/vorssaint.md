# Mac tools: live controls and Vorssaint preferences

The main **Mac 도구** page controls the Mac directly. Its fan card shows measured RPM and target RPM; the remaining cards open native brightness, audio and keep-awake controls. **세부 환경설정** opens the separate Vorssaint preference editor.

## Setup

1. Update the Open Deck Mac app and Android APK together.
2. Open **변수 · 연동 → Vorssaint → ＋ Vorssaint** in the Mac editor. The original 0.13 utility template is upgraded automatically; other pages are preserved. A page that no longer matches the original template is preserved.
3. Open **Mac 도구 → 팬 제어** on the tablet. RPM telemetry is available without administrator installation. To change fan speed, choose **Mac에서 팬 제어 허용** and approve the Mac's administrator dialog directly. Mac unlock and password entry cannot be performed from the tablet.
4. Use **시스템 자동**, **최대 냉각**, the manual slider or **온도 곡선**. Values are applied to the actual hardware and read back; no feature-visibility toggle is needed.

## Direct controls

| Control | Behavior |
| --- | --- |
| Fans | Current/target/minimum/maximum RPM per fan, automatic mode, manual cooling level in 5% steps, temperature curve and live chip temperature |
| Brightness | Per-display hardware brightness, applied when the slider is released; only displays supported by the Mac display API are offered |
| Audio | System output/input device selection, hardware volume and mute, with actual device readback |
| Keep awake | 15/30/60 minutes or indefinite, optional display wake prevention, and immediate stop |
| Advanced preferences | Nine categories of the separately installed Vorssaint app |

Manual fan level maps 0–100% to each fan's reported hardware minimum–maximum RPM. It is not a percentage of current RPM. The native editor offers a two-point curve with chip/CPU/GPU sensor selection; the bounded backend also supports the upstream multi-curve model. Curve temperatures increase within 20–110°C and cooling levels stay the same or increase in 5% steps.

Actual fan mode, current RPM and target RPM are shown separately. A fan takes time to reach a new target. If the hardware or another fan application prevents control, the failure is reported rather than presenting a successful change. The controller does not take over another app's manual session.

Successful manual-level and curve presets are saved in `~/Library/Application Support/OpenDeck/mac-control-presets.json`. These are reusable values, not an instruction to replay manual mode after restart. When the Mac control process exits, the helper loses its client, its heartbeat stops or the hardware/thermal policy requires it, fans return to system control. The helper watches for a missing heartbeat after seven seconds. Tablet disconnection alone does not stop a healthy Mac control process.

Keep-awake sessions belong to the Open Deck control process and end when it exits. Stopping an Open Deck session does not change another application's sleep assertions. Brightness, audio volume and selected devices use the Mac's own settings. Applying these controls does not restart Vorssaint or raise another application.

## Fan module and connection

The independent fan daemon is installed only through a Mac administrator confirmation. Its executable and launch configuration are root-owned at:

- `/Library/PrivilegedHelperTools/app.opendeck.host.fan-control`
- `/Library/LaunchDaemons/app.opendeck.host.fan-control.plist`

The installer verifies the exact bundled daemon signature after copying it to its protected staging path. The daemon authenticates the exact signed control-client binary and the active console user. Its XPC interface accepts bounded fan configuration, status, heartbeat and restore operations; it has no arbitrary shell, path or SMC-key entry point. The official Vorssaint application and protected helper are unchanged.

The unprivileged client handles audio, brightness and sleep assertions. The Node host communicates with it through bounded local JSON lines. Paired tablet requests use the existing page/profile scope over USB or certificate-pinned HTTPS Wi-Fi. Browser-origin and administrator requests remain blocked on the LAN listener.

If the local control process exits, Open Deck retains its last readings with a stale/disconnected flag and retries with backoff. A new process must deliver a new sample before readings are considered current. Mutations run one at a time and reads coalesce. A new action must start within five seconds; expired actions are cancelled instead of running later. Queued work fails explicitly when the process disconnects. Diagnostics are local in `~/Library/Application Support/OpenDeck/mac-controls.log` and the fan daemon's macOS unified log. Command parameters, credentials and clipboard contents are not logged.

Disabling the integration stops the local control client and returns its fan session to system mode. To remove the installed fan service completely, an administrator can run:

```sh
sudo launchctl bootout system/app.opendeck.host.fan-control
sudo rm /Library/LaunchDaemons/app.opendeck.host.fan-control.plist
sudo rm /Library/PrivilegedHelperTools/app.opendeck.host.fan-control
```

## Advanced Vorssaint preferences

Install official [Vorssaint 3.4.2](https://github.com/vorssaint/vorssaint-utils/releases/tag/v3.4.2) at `/Applications/Vorssaint.app` to use **세부 환경설정**. These settings target upstream commit `833967fd45153fc9dc95651d34c867f5c4aee7f1` and the `com.vorssaint.utils` preference interface.

The categories cover energy/display, windows/Dock, mouse/keyboard, sound, clipboard/files, Dynamic Island, menu-bar monitors, apps/tools and general appearance/language. The catalog contains 77 feature availability entries and 151 typed fields. Availability means showing a feature in Vorssaint; it is distinct from the live hardware controls above.

These forms keep drafts local and apply selected keys together with **저장하고 적용**. The adapter checks for stale revisions, asks Vorssaint to quit gracefully, rechecks the revision, writes only changed preferences and starts it in the background. Conflicting forms cannot overwrite newer values. Previous changed-field values are kept in the private `vorssaint-settings-backups/` directory, retaining 20 saves.

Per-app audio mixing, clipboard contents, complex app/device lists, window tools and other Vorssaint runtime windows are not remotely implemented by this page. Their availability/preferences can be edited here; runtime interactions still belong to the official app. Required macOS Accessibility or Screen Recording permissions must be granted through the normal Mac flow.

The host/editor/Android application remains MIT licensed. The independent Mac-control executables use separately licensed GPL-3.0-or-later code with preserved notices and complete corresponding source included in the macOS package. New control/form metadata is Korean/English with English fallback in other interface languages.
