# Android 0.5.1 validation

- Replaces release-triggered page movement with direct manipulation, a cached adjacent-page preview and distance/velocity settling.
- 18 standalone Java gesture checks passed: bidirectional movement, clamping, boundary resistance, slow cancellation/commit, short flings, reversal, minimum travel, settle bounds and position preservation when re-grabbing.
- Signed release build and release lint passed.
- Samsung SM-T870 / Android 13 / pinned HTTPS Wi-Fi: separately injected DOWN/MOVE/UP events confirmed movement before release. The OS calendar's left edge moved from x=38 to x=338 for a 300px drag and to x=638 for a 600px drag. Screenshots were captured while touch was still held.
- A held 600px drag returned to the original OS page; a held 1100px drag committed to the monitor page. Leftward navigation, direction reversal at the last page, and explicit CANCEL were also checked on device.
- Original launcher actions and production schedule/task writes were not invoked during gesture verification.
- Re-grabbing a return animation was verified with a second DOWN 78ms after release: a further 100px move held the OS calendar at x=289 rather than restarting at x=138. The gesture then received CANCEL and returned to OS.
- Eight bidirectional direct-drag transitions on the final signed build: 591 rendered frames, p95 6ms, p99 11ms, 11 modern janky frames (1.86%), 10 legacy janky frames (1.69%), zero missed vsync. One-device observations only.
