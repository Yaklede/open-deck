# Macro Deck 3 plugin inventory

Registry snapshot: 2026-10-21. These are static feasibility assessments for macOS, not a compatibility certification. Open Deck 0.3 ships an experimental action/eager-variable/event adapter. No store plugin has been certified end to end.

| Plugin                                                                                  | Function               | macOS arm64 package | Feasibility                 | Requirement / limit                                          |
| --------------------------------------------------------------------------------------- | ---------------------- | ------------------- | --------------------------- | ------------------------------------------------------------ |
| [CountTogether](https://github.com/CountTogether/Macro-Deck-Plugin)                     | 카운터 연동            | Yes                 | 가능                        | CountTogether 서비스/API 연결                                |
| [HWiNFODeck](https://github.com/Cjhackeryt/HWiNFODeck)                                  | HWiNFO 센서            | No                  | 맥 단독 원본 불가           | Windows 공유 메모리 의존; Mac 센서는 별도 구현               |
| [ScreenxDeck](https://github.com/Cjhackeryt/ScreenXDeck)                                | 화면·창·모니터 제어    | No                  | 조건부                      | macOS 네이티브 어댑터와 디스플레이별 지원 범위 확인          |
| [SoundBox](https://github.com/Cjhackeryt/soundbox)                                      | 사운드보드             | No                  | 가능·재구현                 | Mac 오디오 재생으로 구현; 가상 마이크 라우팅은 별도          |
| [SpicetifyDeck](https://github.com/Cjhackeryt/SpicetifyDeck)                            | Spotify·Spicetify 제어 | Yes                 | 조건부                      | Spicetify 설치와 로컬 브리지                                 |
| [SteelSeries GG Sonar](https://github.com/Cjhackeryt/SteelseriesSonar)                  | Sonar 오디오 제어      | No                  | 맥 단독 원본 불가           | 현재 Windows Sonar 환경 의존                                 |
| [VolumeMixerPlugin](https://github.com/DiegoFdezAb/MacroDeck3VolumeMixerPlugin)         | 앱별 음량              | No                  | 조건부·고난도               | Mac 오디오 믹서 엔진 필요; 시스템 음량과 구별                |
| [GPU-Z Plugin](https://github.com/DodecaDev-LLC/Macro-Deck-3-GPU-Z)                     | GPU-Z 센서             | No                  | 맥 단독 원본 불가           | Windows GPU-Z 공유 메모리 의존                               |
| [Philips Hue Plugin](https://github.com/DodecaDev-LLC/Macro-Deck-Philips-Hue)           | Hue 조명               | Yes                 | 가능                        | Hue Bridge 인증과 기기                                       |
| [VS Code Plugin](https://github.com/DodecaDev-LLC/Macro-Deck-VS-Code)                   | VS Code 제어           | Yes                 | 가능                        | VS Code 측 확장/브리지                                       |
| [FxCommands](https://github.com/hashashin/hashashin.FxCommands)                         | FiveM·RedM 콘솔        | No                  | 맥 단독 원본 불가           | 현재 Windows 클라이언트 환경 필요                            |
| [OctoPrint](https://github.com/hashashin/hashashin.OctoPrint)                           | 3D 프린터 제어         | No                  | 가능·재구현                 | 공개 OctoPrint API; 원본 패키지는 Windows만 제공             |
| [MBXHub (MusicBee)](https://github.com/InariIX/InariIX.MbxHubPlugin)                    | MusicBee 제어          | No                  | 맥 단독 원본 불가·원격 가능 | MusicBee+MBXHub를 실행하는 Windows 장비 필요                 |
| [calendar](https://github.com/jhnnr/macrodeck3-calendar)                                | 달력 위젯              | Yes                 | 가능                        | 기본 날짜 달력은 외부 계정 불필요                            |
| [Razer App Controller](https://github.com/keystonedigitalinc/MacroDeck-RazerController) | Razer 제어             | No                  | 맥 단독 원본 불가           | 현재 플러그인은 Windows Synapse 제어 경로 의존               |
| [Vesktop Bridge](https://github.com/kickfireice/vesktop-macrodeck-bridge)               | Discord 음성 제어      | Yes                 | 조건부                      | Vesktop와 브리지 필요                                        |
| [WaveLink Bridge](https://github.com/kickfireice/WaveLink-Bridge)                       | Wave Link 제어         | No                  | 추가 조사                   | 현재 패키지 Windows 전용; Mac 버전 프로토콜 동등성 검증 필요 |
| [Windsurf Gauges](https://github.com/m-hume/windsurf-gauges)                            | Windsurf 사용량        | No                  | 추가 조사                   | 공식/허용된 사용량 API와 인증 경로 검증 필요                 |
| [Multi-Display VCP Client](https://github.com/doggdogpack/MultiDisplayVCPClient)        | 모니터 제어            | Yes                 | 조건부                      | VCP 서버와 DDC/CI 지원 모니터 필요                           |
| [Device Battery Info](https://github.com/PyFlat/Device-Battery-Info)                    | 배터리 표시            | Yes                 | 조건부                      | OS/주변기기가 제공하는 항목만                                |
| [Printer Control](https://github.com/PyFlat/Printer-Control)                            | 3D 프린터 상태·제어    | Yes                 | 조건부                      | 지원 프린터 서버/API                                         |
| [System Hotkeys](https://github.com/PyFlat/System-Hotkeys)                              | 전역 단축키            | Yes                 | 조건부                      | macOS 입력 관련 권한과 장치별 기능 검증                      |
| [System Media](https://github.com/PyFlat/System-Media)                                  | 미디어 제어            | Yes                 | 조건부                      | 앱별 제어/메타데이터 제공 범위 상이                          |
| [DoriDeck](https://github.com/Sarti2004/DoriDeck)                                       | Dorico 제어            | Yes                 | 조건부                      | Dorico와 브리지 필요                                         |
| [Metronome](https://github.com/Sarti2004/Metronome)                                     | 메트로놈               | Yes                 | 가능                        | 오디오 타이밍과 UI 분리                                      |
| [BeefWeb](https://github.com/SquibsLand/MacroDeck-BeefWeb)                              | 음악 플레이어 제어     | Yes                 | 조건부                      | BeefWeb 서버와 지원 플레이어                                 |
| [GHub Batteries](https://github.com/manuelmayer-dev/Macro-Deck-GHUB-Batteries)          | Logitech 배터리        | Yes                 | 조건부                      | G HUB 실행·지원 기기                                         |
| [Todo List for Macro Deck](https://github.com/manuelmayer-dev/Todo-List-For-Macro-Deck) | 할 일 관리             | Yes                 | 가능                        | 로컬 저장·위젯·입력 UI                                       |
| [ETS2/ATS Telemetry](https://github.com/tabsik30/ETS2TelemtryMD3)                       | ETS2/ATS 텔레메트리    | No                  | 추가 조사                   | 게임 측 SDK/브리지 플랫폼 지원 검증                          |
| [MacroLink for Minecraft](https://github.com/tabsik30/MinecraftMacroLinkMD3)            | Minecraft 상태         | No                  | 가능·재구현                 | Fabric MacroLink 모드 WebSocket                              |
| [Tuya Control](https://github.com/tabsik30/TuyaControlMD3)                              | Tuya 기기 제어         | No                  | 조건부·재구현               | 클라우드/로컬 API 인증과 기기별 지원                         |
| [ComfyUI Job Monitor](https://github.com/YuziIV/MacroDeck-comfyui-job-monitor)          | ComfyUI 작업 상태      | Yes                 | 가능                        | ComfyUI 서버 API                                             |
| [Image Slideshow](https://github.com/YuziIV/MacroDeck-slideshow)                        | 사진 슬라이드쇼        | Yes                 | 가능                        | 크기별 디코딩·이미지 캐시                                    |
| [NVIDIA VRAM Monitor](https://github.com/YuziIV/MacroDeck-vram-monitor)                 | NVIDIA VRAM            | No                  | 맥 단독 원본 불가           | Apple Silicon에 해당 NVIDIA 장치/드라이버 없음               |
| [Custom Button](https://github.com/ziopuzzle/MacroDeck3-CustomButton)                   | 사용자 정의 위젯       | Yes                 | 가능·대규모                 | XML/선언형 UI·입력·템플릿 네이티브 렌더러 필요               |
| [Teamspeak3Plugin](https://github.com/DaNeo61/MacroDeck.Teamspeak3Plugin)               | TeamSpeak 3 제어       | Yes                 | 조건부                      | TeamSpeak 서버/클라이언트 인터페이스                         |

Source: [official store registry](https://github.com/Macro-Deck-App/Macro-Deck-Store-Registry/blob/main/index.json). A missing macOS package can require a port; Windows driver and hardware dependencies can make the original function unavailable on a Mac.

## Delivery stages

1. **Shipped:** independent page geometry, resize and portrait packing.
2. **Shipped:** styling, assets, undo/redo and portable deck backup.
3. **Shipped:** typed state, controls, native local widgets, weekday and variable triggers.
4. **Foundation shipped:** HTTP/webhooks and Keychain Bearer tokens. OAuth and account-specific service connectors remain.
5. **Experimental subset shipped:** managed plugin actions, eager variable reads and event triggers. Next adapter work must implement real config flows, host callbacks and UI/resource rendering before certifying store plugins.

Certification gate for each plugin: macOS package available → required capabilities/host callbacks implemented → credentials/hardware configured → actual operation and reconnect tested.
