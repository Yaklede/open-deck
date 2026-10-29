# Mac control component

This separate executable component is GPL-3.0-or-later. Upstream sources in `upstream/` and `daemon/main.swift` are from Vorssaint 3.4.2, commit `833967fd45153fc9dc95651d34c867f5c4aee7f1`, https://github.com/vorssaint/vorssaint-utils. Copyright notices and GPL license are retained.

Open Deck adaptations use a distinct privileged service and state paths, require a pinned client executable and the active console user, and add a local JSON-lines client for real-time controls. The official installed Vorssaint app and its protected helper are unchanged. The source files in this directory are distributed under GPL-3.0-or-later. The MIT host communicates with these independent processes over a bounded protocol.
