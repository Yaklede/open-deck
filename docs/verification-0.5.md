# 0.5 validation

- Node host tests: 40 passed, including paired mutation authorization, per-device receipt isolation, widget scope and capability validation.
- Android signed release build and release lint passed.
- Jimin OS: 25 targeted frontend tests, 4 Rust companion boundary tests, TypeScript check, Clippy with warnings denied, and production Mac build passed.
- Samsung SM-T870 / Android 13: native title/date/time/notes form submitted one schedule to an isolated fixture; an undated task completed once through native confirmation. No production schedules/tasks were changed and no completion chat was sent.
- Physical tablet used pinned HTTPS Wi-Fi for both native writes. Production pairing, certificate, deck and task data were preserved.
- Eight bidirectional swipe transitions: 340 frames, 95th percentile 9ms, 99th percentile 16ms, 18 modern janky frames (5.29%), 4 legacy janky frames (1.18%), zero missed vsync. These are one-device observations, not a universal performance guarantee.
- Directional transition uses cached native tile views. No bitmap screenshot allocation or per-frame layout is used by the page animation.
