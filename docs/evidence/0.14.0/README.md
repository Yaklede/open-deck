# 0.14.0 direct-control verification status

This candidate replaces the original feature-visibility dashboard with live Mac controls. The fan daemon/client and native forms are implemented, but **actual fan-speed writing and curve application are not yet verified**. The Mac was locked; the administrator installation request expired without approval. Publication is pending that required hardware verification.

Completed on a physical Samsung Galaxy Tab S7:

- Measured current/target/minimum/maximum RPM from both physical Mac fans.
- Changed actual Mac brightness with the native tablet slider, 62% → 64%, then restored 62%.
- Changed actual speaker volume, 0% → 2%, while preserving mute, then restored 0% and the original mute state.
- Started a real 30-minute Mac sleep-prevention assertion with the native tablet button, stopped it and confirmed release. Vorssaint itself was not restarted.
- Changed brightness in the actual Mac editor UI module through a background loopback browser fixture, confirmed Mac readback and restored the original value.
- Opened the advanced category chooser and its energy/display category without changing the user's Vorssaint preferences.

The complete host suite passed 284 tests. Android release compilation and lint passed, with zero errors and 22 existing warnings. The native client/helper compiled and passed their policy self-checks. Tests cover scoped control operations, bounds/curve validation, trusted HTTPS, blocked browser/LAN admin access, revocation during POST streaming, preset persistence, disk-save failure reporting, read coalescing, mutation single-flight and stale native data after disconnect.

Fan permissions use a distinct, bounded root-owned module with an exact client code-signature requirement and active-console-user check. The official Vorssaint app/helper is unchanged. Neither Mac unlock nor administrator password entry is automated. No password or administrator credential is present in these records.

[Check status](checks.json), [brightness](brightness-result.json), [audio](audio-result.json), [keep awake](awake-result.json), [Mac editor module](mac-editor-control-result.json), [control scope and setup](../../vorssaint.md).

Before marking this release complete: obtain Mac administrator approval; test manual speed, temperature curve, automatic restore and client-loss recovery on the real Mac; install and verify the final production packages; publish the normal latest release and verify public installer hashes.
