# Feature coverage — Open Deck 0.2.0

Open Deck is an independent application implementing a subset of the macro-deck workflow. It does **not** load Macro Deck plugins, connect to the Macro Deck Store, or provide all of Macro Deck's features. REA source analysis is evidence of inspection, not a feature migration or a compatibility layer.

| Area          | Open Deck implementation                                                       | Remaining gap                                                                                     |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Host / client | macOS host, native Android Canvas app                                          | Windows/Linux hosts, iOS client                                                                   |
| Connectivity  | USB, certificate-pinned Wi-Fi HTTPS, stored pairing, reconnect                 | Initial pairing requires USB; no mDNS discovery or Bluetooth                                      |
| Layout        | Multiple pages, visual editor, reorder/duplicate, colors, bundled vector icons | Nested folders, separate profiles, automatic profile activation, icon-pack import                 |
| Actions       | App/URL launch, Chrome-profile tab reuse, shell command, wait, volume, mute    | Dedicated app/service APIs, keyboard/mouse action editor, reusable script library                 |
| Flows         | Ordered actions and basic `if` branches against host state                     | General variables/templates, Switch/Repeat, integration event triggers                            |
| Automation    | Daily local-time execution of a configured button                              | App focus, device connection, variable change, calendar/email events                              |
| Widgets       | Clock, CPU/memory gauges, countdown, Mac volume, text                          | History graph, weather, calendar, inbox, music player, battery, stream chat/stats                 |
| Integrations  | Local macOS actions and Chrome handling                                        | No dedicated OBS, Spotify, Home Assistant, Twitch, YouTube, Discord, calendar or IMAP integration |
| Plugins       | None                                                                           | No plugin SDK, plugin runtime, marketplace or Macro Deck plugin compatibility                     |
| Backup        | Open Deck JSON import/export                                                   | Macro Deck profile/plugin import, cloud account sync                                              |

A shell command can call an external tool, but that does not provide a native service integration, login flow, state subscription, plugin lifecycle or compatible plugin API.

Reference checked 2026-10-21: [Macro Deck official concepts, widgets, triggers and integrations](https://docs.macro-deck.app/guide/concepts/). The table describes Open Deck source in this release; it is not a claim that every original feature has been audited or ported.
