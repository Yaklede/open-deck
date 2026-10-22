# Open Deck 0.10.0 — 기본 설정 구현 및 검증

이 문서는 0.9.0 비교표에서 남아 있던 기본 설정을 다시 감사한 기록이다. 원본과 기능을 대응시키되, 같은 목적을 다른 저장 방식으로 구현한 항목과 실제로 지원하지 않는 별도 기능을 구분한다. 설정 항목의 존재, 저장, 적용 경로, 자동 검증을 연결하며 실제 기기·설치 파일 검증은 마지막 절에서 따로 기록한다.

## 비교 기준과 판정

비교 기준은 공식 [Macro Deck v3.0.0-beta.18 소스](https://github.com/Macro-Deck-App/Macro-Deck/tree/7089154cde506c0884bb39c4712863e0fef83d84), commit `7089154cde506c0884bb39c4712863e0fef83d84`다.

- `S/`: `ui/angular/projects/desktop-ui/src/app/components/shell/settings-modal/sections/`
- `P/`: `ui/runtime/src/protocol/messages/`
- `C/`: `ui/web-client/src/settings/`
- `H/`: `host/src/`

**구현**은 해당 설정의 사용자 동작이 연결되어 있다는 의미다. **대체 구현**은 같은 목적을 지원하되 파일 형식·보안 방식·데이터 모델에 차이가 있다는 의미다. **별도 기능**은 원본에 실제 존재하지만 이번 기본 설정 완료 범위에 포함되지 않는 실험 transport, 플러그인, 상거래 또는 매크로 실행 기능이다. 이를 해당 플랫폼에서 지원하지 않는다는 주장으로 바꾸지 않는다.

## 0.9.0에서 남은 설정 재검토

| 원본 설정·근거 | 0.10.0 상태 | 화면 → 저장 → 실제 적용 | 검증·남는 차이 |
| --- | --- | --- | --- |
| 전체 언어 목록·언어 변경 — `S/language-settings.component.html`, `P/localization.ts` | 구현 | Mac 설정 언어 / Android 언어 → `appearance.language`, 기기 `language` → `host/public/i18n.mjs`, native `L10n.java`, `LocalePolicy.java`, Swift 메뉴 번역 | 원본의 19개 언어와 시스템 언어 선택. 카탈로그·플레이스홀더·RTL·사용자 데이터 보존은 `i18n.test.mjs`. 사용자 카드 이름과 외부 서비스 응답을 번역하지 않음 |
| 관리자 username·암호·세션 — `P/auth.ts`, `S/security-settings.component.html` | 구현 | 설정 → 관리자 계정 → 소유자 전용 `account.json` → `AccountManager`의 암호 hash·만료 세션·현재/다른 세션 해제 | `account-vault.test.mjs`, `account-api.test.mjs`. 로컬 편집기 로그인이며 Macro Deck 온라인 상거래 계정과 별개 |
| 관리자 계정 복구 — `P/auth.ts`, `S/security-settings.component.html` | 구현 | 계정 복구 키 생성 → 저장 확인 → 교체/분실 처리/암호 재설정 → `account.json`의 recovery verifier·상태 | 복구 후 기존 세션을 폐기하고 키를 소모. 새 키 미확인·잘못된 키·재사용 거부 및 재시작 보존 검사 |
| 비밀 저장소·복구키 관리 — `P/key-ring.ts`, `S/security-settings.component.html` | 대체 구현 | 설정 → 암호화 저장소 → `vault-keyring.json`, `vault-secrets.json` → `SecretVault`, 서버 `resolveSecret` | AES-GCM 암호화, 별도 암호, 키 생성·확인·교체·분실·복구. 앱 재시작 후 잠김. macOS Keychain 연동은 기존 방식도 유지; 원본 .NET key ring 바이너리를 복제하지 않음 |
| 로컬 백업 암호화·복구키 lifecycle — `S/backup-recovery-key-settings.component.html`, `P/backup.ts` | 구현 | 백업·복원 → 저장소 복구 키 확인·로컬 백업 암호화 켜기 → `localBackupsEncrypted`, vault-encrypted archive → `Backups`/`SecretVault` | 기존 평문 백업 암호화 전환, 복구키로 이식 가능한 읽기, 잠긴 저장소에서 평문 fallback 금지. 암호화는 사용자가 켜는 옵션이며 기본 평문 파일을 암호화되었다고 표시하지 않음 |
| HTTP/HTTPS 선택·Replace/Additional — `P/settings.ts`, `S/network-tls-settings.component.html` | 구현 | 네트워크 → HTTPS 켜기·방식·별도 포트 → `network.tlsEnabled/tlsMode/tlsHttpsPort` → `NetworkListeners` | Replace / Additional / HTTP 모드 실제 요청 및 점유 포트 원복 검사. 관리자 경로는 loopback 전용. Android의 평문 Wi-Fi는 별도 명시적 허용 필요 |
| Local CA·인증서 재발급 — `P/settings.ts`, `S/network-tls-settings.component.html` | 구현 | 네트워크 → 로컬 인증기관 생성/교체·서버 인증서 재발급·공개 CA 내보내기 → 앱 전용 PEM → `issueLocalCertificate`, `exportAuthority` | 실제 CA 서명·SAN·유효기간 검증. 개인 키는 내보내지 않음. Android는 페어링한 leaf 인증서를 계속 pinning하므로 인증서 변경 시 신뢰 갱신 필요 |
| ADB 플랫폼 도구 자동 다운로드 — `P/settings.ts`, `S/adb-settings.component.html` | 구현 | 네트워크·USB → 도구 다운로드·설치 → `usb.executablePath` → `downloadPlatformTools` | Google 공식 repository XML에서 stable macOS ZIP·체크섬을 읽고 검증 후 앱 데이터 하위에 원자적 설치. 시스템 SDK 덮어쓰기 없음. 실제 공식 37.0.1 패키지 다운로드 검증 완료 |
| 종료 시 ADB 서버 정지 — `S/adb-settings.component.html` | 구현 | 네트워크·USB → 앱 종료 시 서버 정지 → `usb.stopServerOnExit` → Swift 종료 시 `adb kill-server` | 기본 끔. 다른 도구가 공유하는 ADB 연결에도 영향을 준다는 설명 제공. Swift 형식 검사 완료; 실제 공유 서버 종료를 검증 목적으로 수행하지 않음 |
| Companion 자동 업데이트 — `S/companion-app-settings.component.html`, `P/settings.ts` | 구현 | 네트워크·USB → 연결된 태블릿 앱 자동 업데이트 → `usb.companionAutoUpdate` → `CompanionUpdater`, 60초 host tick | 기본 끔. 이미 앱이 설치된 ADB 기기만 대상. APK manifest versionCode 비교, SHA-256 검증, Android의 기존 서명 검증을 사용하는 `install -r`; 다운그레이드/앱 삭제 없음. 중복 실행 방지·재시도 backoff·실패 로그 검사 |
| 원본 Profile/Folder/Widgets portable 파일 — `P/portable.ts`, `H/MacroDeckHost.Infrastructure/Portable/PortableArchive.cs` | 대체 구현 | 설정 → Macro Deck → 파일 미리보기·변환 보고·가져오기 / 내보내기 → 새 Open Deck 프로필과 이미지 → `Migration`, `macrodeck-portable.mjs` | `.macroDeckProfile`, `.macroDeckFolder`, `.macroDeckWidget` ZIP 및 원본 암호 형식 읽기/쓰기. 동작·위젯은 지원되는 항목만 변환하며 지원하지 않는 항목은 실행하지 않고 보고. 모든 원본 위젯이 동일하게 동작한다는 뜻이 아님 |
| 원본 backup·이전 데이터 migration — `P/migration.ts`, `S/migration-settings.component.html`, `H/MacroDeckHost.Infrastructure/Migration/MacroDeck2/` | 대체 구현 | Macro Deck 원본 backup/프로필 JSON/ZIP 미리보기 → 기존 덱을 보존한 추가 가져오기 → 복원 전 안전 백업 → ID·변수 충돌 재매핑 | 원본 recovery-key encrypted backup의 프로필·이미지·기본 변수 읽기. Macro Deck 2 프로필 JSON의 폴더·위치·라벨 이전. DB-only·플러그인 액션·credentials·원본 계정 복원은 수행하지 않으며 보고에 표시 |
| 외관 글꼴·변수 강조색·팔레트 — `S/appearance-settings.component.html`, `P/settings.ts` | 구현 | 화면·언어 → 시스템 글꼴 목록·색상/변수 입력·팔레트 → `appearance.fontFamily/accentColor/palette` → `NSFontManager`, CSS font-family, `applyAppearanceVariables` | 시스템 글꼴 목록을 표시하고 선택을 적용. `{{variable}}`에 연결한 강조색은 상태 변경을 반영. 6/8자리 hex 팔레트·강조색 및 초기화 지원 |
| 업데이트 전 안전 백업 — `S/backup-schedule-settings.component.html` | 구현 | `backups.beforeUpdate` → 릴리즈·설치 파일 열기 전 `/api/admin/update/prepare` → `backups.create("before-update")` 성공 후 링크 열기 | `update-preparation.test.mjs` 2개 통과: 설정 켬/끔·기존 덱 보존·잠긴 암호화 저장소의 423 및 평문 fallback 금지. 새 버전 첫 실행 백업은 보조 경로. 외부에서 앱 번들을 직접 교체하는 작업은 사전 가로채기 대상이 아님 |

## 유지되는 기본 설정 연결표

아래 기능은 0.9.0 구현을 유지하면서 새 계정·언어·네트워크 설정과 함께 동작한다. 0.9.0의 실기기 결과를 0.10.0 실기기 검증으로 재사용하지 않는다.

| 원본 기능·근거 | 상태 | Open Deck 저장·적용 경로 | 검증 파일 |
| --- | --- | --- | --- |
| 설정센터·검색·화면 모드·UI 크기 — `S/appearance-settings.component.html` | 구현 | `settings-ui.mjs`, `appearance.themeMode/uiScale` → 문서 CSS·시스템 테마 구독 | `settings.test.mjs`, `i18n.test.mjs` |
| 로그인 자동 시작·최소화·Dock — `S/startup-settings.component.html`, `S/dock-icon-settings.component.html` | 구현 | `startup.*` → Swift LaunchAgent·초기 창·activation policy | Swift typecheck, 실제 설치 검증 별도 |
| 로그 수준·목록·검색·내보내기·데이터 폴더 — `S/logging-settings.component.html`, `P/logs.ts` | 구현 | `logging.minimumLevel` → allowlist 진단 기록·회전·5초 갱신 검색 표 | `settings.test.mjs`, `settings-integration.test.mjs` |
| HTTP User-Agent — `S/http-settings.component.html` | 구현 | `http.userAgent` → 실제 connector 요청 | `settings.test.mjs` |
| 개발 모드 — `S/developer-settings.component.html` | 대체 구현 | `developer.enabled` → 고급 액션 JSON 도구 | 설정 저장·표시 검사. 플러그인 SDK 개발 환경은 별도 |
| HTTPS 포트·검색·인증서 업로드 — `S/network-settings.component.html`, `S/network-tls-certificate-upload-modal.component.html` | 구현 | `network.wifiEnabled/wifiPort/discoveryEnabled` → listener/DNS-SD, PEM 인증서와 키 검증 | `settings-integration.test.mjs`, `network-modes.test.mjs` |
| ADB 활성화·경로·기기·기본 기기·무선 연결·서버 재시작 — `S/adb-settings.component.html` | 구현 | `usb.enabled/autoConnect/executablePath/defaultDeviceSerial` → 실제 ADB 명령·Swift 터널 복구 | `platform-tools.test.mjs`, 기존 연결 검증 |
| 기기 이름·모델·버전·연결 상태 — `S/devices-settings.component.html`, `P/device.ts` | 구현 | `devices.json`·기기 metadata → Mac 기기 목록 | `settings.test.mjs`, `settings-integration.test.mjs` |
| 기기 시작 프로필·페이지·원격 이동·권한 해제 — `P/device.ts` | 대체 구현 | 기기 `profileId/startPageId/rememberPage` → 프로필 필터·SSE·native navigation | `settings-integration.test.mjs`, Java `ProfileNavigation` 검사 |
| 프로필 생성·이름·복제·순서·삭제·기본값 — `P/profile.ts` | 구현 | `deck.profiles[]/defaultProfileId` → `profiles.mjs`, `profile-tools.mjs` | `profile-editor.test.mjs`, `settings.test.mjs` |
| 앱 포커스 전환 — `P/folder.ts` focus rules | 대체 구현 | 프로필 `focusApps` → Swift 활성 앱 bundle ID·프로필 전환/복귀 | 원본은 폴더·기기별 focus rule도 표현 가능. Open Deck은 프로필 수준 연결 |
| 폴더/페이지 계층·디자인 상속·크기·간격·고정 — `P/profile.ts`, `P/folder.ts`, `P/widget.ts` | 대체 구현 | 페이지 `parentId`, 프로필 `defaults`, 페이지 override, 위젯 `w/h/pinScope` → `effectivePages` | `profile-editor.test.mjs`, layout/config 검사. 플러그인 folder view는 별도 |
| 다중 선택·복사·붙여넣기·이동 — `P/widget.ts`, `P/folder.ts` | 구현 | `app.js` 편집기 → 새 ID·참조 remap·undo | `profile-editor.test.mjs` |
| 태블릿 테마·표준/간소화 렌더·아이콘 해상도 — `C/client-settings.ts` | 구현 | 기기 `theme/renderMode/iconResolution` → native Canvas/이미지 decode | Java 설정 정책 검사 |
| 화면 켜짐·밝기·방향·전체 화면·글자 — `C/client-settings.ts`, 기기 설정 | 구현 | `awake/brightness/orientation/fullscreen/textScale` → Android Window·Canvas | Java 설정·밝기 검사 |
| 진동·소리·스와이프·효과 줄이기·헤더/탭 표시 | 구현 | 기기 설정 → 터치·그리기·layout inset 분기 | Java 설정 정책·wake sequence 검사 |
| 화면 보호·첫 터치 오발 방지 — `P/device.ts` | 구현 | `screenSaverMinutes/screenSaverMode/dimPercent/firstTouchWakes` → 유휴 타이머·`WakeInteractionGuard` | Java 전체 touch/key 시퀀스 검사 |
| 설정 버튼 숨김·복구·연결 해제 — `P/device-client-settings.ts`, `C/client-settings.ts` | 구현 | `settingsButtonHidden`, 모서리 길게 누르기, pairing 권한 해제 | Java 및 실제 기기 검증 별도 |
| 태블릿 오프라인 설정 저장·재연결 동기화 | 구현 | SharedPreferences pending patch → 연결 시 재전송·revision 비교 | Java stale revision 검사, host SSE 검사 |
| 알림 선택 | 구현 | `osNotifications/monitorNotifications/notificationBanner` → 각 알림 게시 분기 | 실제 알림 검증 별도 |
| 백업 생성·목록·미리보기·삭제·내보내기/가져오기 — `P/backup.ts` | 구현 | `Backups`, 참조 이미지·앱 설정·상태·체크섬 | `backups.test.mjs` |
| 일/주/월/간격·보관 수 — `S/backup-schedule-settings.component.html` | 구현 | `backups.schedule/time/dayOfWeek/dayOfMonth/intervalHours/retention` → 재시작 중복 방지 scheduler | `backups.test.mjs` |
| 전체/선택 프로필·상태·앱 설정 복원 — `P/backup.ts` | 대체 구현 | 완전 검증 → 안전 백업 → 원자적 config 적용 → 타입/참조에 맞춘 상태 | `backups.test.mjs`, `settings-integration.test.mjs`. 기기 pairing/기기 override·OS Keychain·runtime 파일은 복원 대상 아님 |
| 편집기 잠금·유휴 잠금 — `S/security-settings.component.html` | 구현 | `security.idleLockMinutes`, `editor-lock.json` → 423 gate·기존 태블릿 연결 유지 | `editor-lock.test.mjs`, `account-api.test.mjs` |
| 앱 버전·릴리즈 확인·설치 파일·라이선스 — `S/about-settings.component.html`, `S/update-check.component.html` | 구현 | build-info, 공식 GitHub release 조회, APK checksum·업데이트 서명 | `settings.test.mjs`, `companion-update.test.mjs`; 공개 배포 확인 별도 |

## 원본 파일 상호운용 증거

[합성 원본 fixture](../test/fixtures/macrodeck/README.md)는 실제 Macro Deck C# `PortableArchiveCrypto` 및 `BackupPayloadCrypto`를 원본 revision 그대로 임시 .NET 프로젝트에 포함해 생성했다. 비밀번호·복구 키는 공개된 합성 테스트 벡터이며 사용자 credential이 아니다. 원본 코드나 원본 실행 바이너리를 Open Deck 앱에 번들하지 않는다.

1. 원본 C#가 만든 password-encrypted `.macroDeckProfile`을 Open Deck가 복호화하고 프로필·위젯을 읽는다.
2. 원본 C#가 만든 recovery-key encrypted `.macroDeckBackup`을 Open Deck가 HKDF·chunked AES-GCM 검증 후 읽는다.
3. Open Deck가 내보낸 password-encrypted `.macroDeckProfile`을 원본 C# decryptor가 직접 읽는 역방향 검증을 수행했다.
4. ZIP 경로 traversal·중복·특수 파일/symlink·CRC·확장 크기 제한·파일 hash·암호 변조 거부를 검사한다.
5. 가져오기 preview는 실행하지 않는다. 명시적 적용 후에도 기존 프로필·기본 프로필을 보존하며 새 ID와 충돌 없는 변수 이름으로 추가한다. 지원하지 않는 plugin/action/widget은 실행하지 않고 보고한다.

이는 원본 UI에서 모든 위젯을 클릭해 동작을 확인했다는 의미가 아니다. 지원되는 동작은 URL 열기, macOS 앱 열기, 단순 명령, 지연, 기본 변수 조작, 단독 폴더 이동이다. 복합 flow·다중 상태·원본 custom view·폰트·플러그인과 일부 위젯은 변환 보고에 차이를 남긴다. 원본 backup의 계정·DB·credential 복원은 이 migration 기능의 목적이 아니다.

## 자동 검증 기록

| 범위 | 확인 결과 | 실제로 입증하는 것 |
| --- | --- | --- |
| `node --test test/macrodeck-portable.test.mjs test/platform-tools.test.mjs test/companion-update.test.mjs` | **20개 통과, 실패 0** | archive 9개 + ADB installer 4개 + companion updater 7개 |
| 원본 C# decryptor 역방향 실행 | 통과 | Open Deck export가 원본 password encryption 형식과 상호운용 |
| Google 공식 Platform Tools 실제 다운로드 | 통과 | stable 37.0.1 macOS ZIP, manifest의 SHA-1 `6ae73f4de6452dc57e62ec02b68eed92a4c21661` 검증·앱 전용 임시 폴더 설치. ADB 서버나 사용자 기기를 실행/변경하지 않음 |
| 실제 Android binary manifest 파싱 | 통과 | 공개 0.9.0 manifest fixture에서 package `app.opendeck.client`, versionCode 15, versionName 0.9.0 추출 |
| Swift typecheck | 통과 | 종료 시 opt-in ADB 정지와 native 메뉴·파일 저장 코드의 형식. 기존 selector/unused 경고 있음 |
| 계정·저장소 unit | **9개 통과, 실패 0** | `account-vault.test.mjs`: 인증·만료·키 확인·복구·암호화·재시작·비밀정보 비노출 |
| 계정·저장소 / network / migration API | **8개 통과, 실패 0** | `account-api.test.mjs` 4개 + `network-modes.test.mjs` 3개 + `migration-api.test.mjs` 1개. 실제 로컬 HTTP/HTTPS 요청·세션 해제·잠긴 저장소·CA·인증서·가져오기 무실행과 데이터 보존 |
| i18n | **22개 통과, 실패 0** | `i18n.test.mjs`: 19언어 카탈로그·플레이스홀더·Android assets 일치·사용자 문자열 보존·URL 정책 |
| Android 정책·제스처·최신성 | 설정 정책 **100개**, 제스처 **18개**, 데이터 최신성 **15개 통과** | `scripts/test-settings.sh`, `scripts/test-swipe.sh`: 설정 검증·터치 처리·오래된 응답 거부 |
| Android release 빌드/lint | **assembleRelease 성공, lintRelease 오류 0·경고 20** | release APK 빌드 및 정적 검사. 공개 설치 파일의 서명·버전·digest 대조는 릴리즈 검증에서 별도 기록 |
| 업데이트 준비 API | **2개 통과, 실패 0** | `update-preparation.test.mjs`: 관리자 권한·설치 링크 전 안전 백업·설정 off·잠긴 저장소에서 실패 반환 |
| 전체 호스트 회귀 | **168개 통과, 실패 0** | `node --test test/*.test.mjs` |

자동 업데이트 테스트는 fake ADB runner와 합성 APK·가상 시각을 사용한다. opt-in·동시 tick 병합·미설치 앱 제외·같거나 높은 versionCode 제외·checksum 거부·설치 후 버전 재조회·재시도 지연·임시 파일 정리를 검사했다. 사용자의 실기기에서 자동 설치를 유발하지 않았다. `adb install -r`의 실제 signature continuity 판정은 Android 패키지 설치기의 역할이다.

## 별도 기능과 정확한 차이

- **ADB 없는 native USB는 실험적 transport다.** 원본 `S/usb-settings.component.html`은 Experimental badge와 안내를 명시한다. macOS에서도 `H/MacroDeckHost.Infrastructure/Usb/Native/LibUsbNative.cs`의 `.dylib` 탐색을 통해 Android AOA를 지원한다. Open Deck은 ADB USB와 Wi-Fi를 제공하며 AOA·iOS usbmux transport를 구현한 것으로 표시하지 않는다. macOS 미지원이라서 제외했다는 설명은 사용하지 않는다.
- 원본 플러그인 설치/스토어/업데이트/플러그인별 설정, 계정 구매·라이선스·프로모션·스토어 평점은 기본 로컬 설정 범위와 구분한다. 관리자 username·암호·세션·복구는 별도이며 위 표에 실제 구현되어 있다.
- Repeat/While/Switch flow 편집기, 독립 스크립트 라이브러리, 일반 표현식 엔진, 원본 MusicPlayer/Weather/Stopwatch/Battery의 전체 동작은 매크로·위젯 실행 기능이다. 설정 메뉴 완료를 이러한 실행 엔진의 완전한 호환으로 표현하지 않는다.
- 새 저장소는 앱을 재시작하면 잠긴다. 저장소가 잠겨 있으면 암호화 자동 백업과 해당 비밀을 사용하는 연동은 해제될 때까지 대기한다. 조용히 평문 백업을 만들거나 secret을 노출하는 fallback은 없다.
- 원본 backup의 전체 installation clone과 Open Deck의 선택 프로필/상태/앱 설정 복원은 데이터 모델이 다르다. 기기 pairing과 기기별 override·외부 Keychain·runtime 파일은 가져오거나 내보내지 않는다. 덱 명령·URL·사용자 텍스트에 직접 입력한 값은 덱 내용으로 포함된다.

## 화면 조작 증거

합성 데이터로 실제 설정 화면을 조작해 확인했다. [계정/보안 검증 기록](security-verification-0.10.0.md), [실행 결과](evidence/0.10.0/security-ui-results.json), [가져오기/내보내기 결과](evidence/0.10.0/migration-ui-results.json)에 수행한 동작과 검증 결과가 있다.

- [관리자 계정과 세션](evidence/0.10.0/security-settings.png)
- [암호화 비밀 저장소](evidence/0.10.0/secret-vault.png)
- [암호화 백업](evidence/0.10.0/encrypted-backup.png)
- [원본 파일 미리보기](evidence/0.10.0/migration-settings.png) / [암호화 내보내기](evidence/0.10.0/migration-export.png)
- [TLS·USB 설정](evidence/0.10.0/network-settings.png)
- 실기기 SM-T870의 [영어](evidence/0.10.0/tablet-settings-english.png), [일본어](evidence/0.10.0/tablet-settings-japanese.png), [아랍어](evidence/0.10.0/tablet-settings-arabic.png). 영어 설정은 앱 강제 종료 후 재실행에서도 유지되는 것을 화면으로 확인했다.

## 0.10.0 실제 화면·기기 검증 결과

아래 기록은 2026-10-22에 이번 변경으로 수행한 검증이다. 실제 태블릿 검증은 Samsung SM-T870의 격리 패키지 `app.opendeck.verification`으로 진행했다. 운영 앱의 USB 포트 8840은 유지하고 검증용 포트 18840만 제어했다. 따라서 이 결과는 실제 Android 하드웨어에서의 동작을 입증하며, 최종 배포 APK가 운영 앱 위에 설치되었다는 증거와는 구분한다.

| 검증 | 수행 결과·증거 | 확인 범위 |
| --- | --- | --- |
| 태블릿 언어 변경 | 실제 기기에서 [영어](evidence/0.10.0/tablet-settings-english.png)·[일본어](evidence/0.10.0/tablet-settings-japanese.png)·[아랍어](evidence/0.10.0/tablet-settings-arabic.png) 설정 화면 확인 | 언어 적용과 아랍어 표시를 확인했고, 영어 선택은 강제 종료 후 재실행에도 유지. 모든 19개 언어를 실기기에서 각각 검수한 것은 아님 |
| USB 페어링 → HTTPS Wi-Fi 전환 | [연결 검증 9개 모두 PASS](evidence/0.10.0/tablet-wifi-reconnect.json) | 격리 USB 페어링 후 자동 TLS 연결. 검증용 USB 터널 제거 및 앱 재실행 후 Wi-Fi로 약 1.0초에 재연결 |
| 인증서 교체와 신뢰 갱신 | [이전 pin 거부](evidence/0.10.0/tablet-new-certificate-needs-usb.png), [USB로 신뢰 갱신 후 Wi-Fi 복구](evidence/0.10.0/tablet-certificate-refreshed-wifi.png) | Local CA로 인증서를 교체하면 이전 pin으로 연결하지 않음. 검증용 USB 연결을 추가한 뒤 인증된 신뢰 갱신과 TLS Wi-Fi 재연결 확인 |
| 평문 Wi-Fi의 명시적 선택 | [HTTP 허용 확인](evidence/0.10.0/tablet-http-explicit-opt-in.png), [HTTPS 기본값 복구](evidence/0.10.0/tablet-final-encrypted-wifi.png) | 기본값에서는 HTTP listener가 있어도 연결 거부. 사용자가 평문 LAN을 허용하면 USB 없이 연결하며, 검사 후 해당 옵션을 끄고 HTTPS 연결 복구 |
| Wi-Fi 중단 중 데이터 유지·자동 재연결 | [중단 중 덱 유지](evidence/0.10.0/tablet-network-interrupted-retains-deck.png), [상세 결과](evidence/0.10.0/tablet-wifi-reconnect.json) | 검증용 USB 터널 없이 실행 중 listener를 중단. 재연결 표시와 기존 카드의 흐린 상태 유지 확인, listener 복구 후 약 6.9초에 재연결. 이 검사는 Mac 잠금·해제 동작을 새로 수행한 검증은 아님 |
| 계정·복구·암호화 백업 UI | [실행 결과](evidence/0.10.0/security-ui-results.json), [검증 설명](security-verification-0.10.0.md) | 격리 Chrome와 합성 localhost 데이터로 계정 생성·로그인·전체 로그아웃·복구 키 확인 및 다운로드·저장소 생성·비밀 추가·기존 평문 백업 암호화·암호화 백업 4개 확인. 브라우저 오류 0 |
| 원본 파일 가져오기·내보내기 UI | [실행 결과](evidence/0.10.0/migration-ui-results.json) | 암호화 프로필 미리보기·확인 후 가져오기·기존 프로필/페이지 보존·암호화 내보내기 다운로드 및 재가져오기·페이지 제목 보존·원본 복구 키 암호화 백업 가져오기. 브라우저 오류 0 |
| Mac 네이티브 파일 저장 | `NSSavePanel`에서 `native-roundtrip.macroDeckProfile` 저장 성공 | 운영 프로필을 사용한 파일은 비공개 작업 출력 폴더에 보관. 파일 권한 `0600`, ZIP 무결성 정상, Open Deck importer로 재해석하여 3개 페이지·26개 위젯 확인. 운영 덱에 다시 적용하지 않음 |

기기 연결 검증의 재연결 시간은 해당 실행에서 측정한 값이며 일반적인 성능 보장 값은 아니다. 공개 계정·보안 UI는 합성 데이터를 사용했다. 운영 프로필 파일 자체와 계정 암호·복구 키·기기 credential은 공개 증거에 포함하지 않는다.

## 최종 설치 파일·릴리즈 확인

[Open Deck 0.10.0](https://github.com/Yaklede/open-deck/releases/tag/v0.10.0)을 최신 릴리즈로 게시했다. 실제 배포 소스는 `cb83101c9e4c722d391908cc6153ea40d832ec17`이며, [GitHub 검증](https://github.com/Yaklede/open-deck/actions/runs/39757808561)의 host·Android 작업이 모두 통과했다. 아래 값과 공개 파일의 SHA-256은 [릴리즈 확인 결과](evidence/0.10.0/release-results.json)에 기록했다.

- **Mac:** `/Applications/Open Deck.app`을 0.10.0 / build 16으로 업데이트했다. 설치된 build-info의 커밋과 배포 소스가 일치하며, 기존 자동 시작 설정과 시스템 글꼴 247개 목록을 확인했다. Mac을 재부팅하지 않았다.
- **실제 태블릿:** Samsung SM-T870의 운영 패키지 `app.opendeck.client`를 기존 서명을 유지한 `adb install -r`로 업데이트했다. versionName 0.10.0 / versionCode 16을 확인하고, 설치된 APK를 다시 가져와 배포 APK와 바이트 해시가 같은지 검증했다. 실제 설정 화면의 버전 표시와 운영 화면의 암호화 Wi-Fi 연결을 확인했다.
- **사용자 데이터:** 기존 3개 페이지·26개 위젯의 ID와 동작 전체를 업데이트 전 값과 비교했다. 태블릿 페어링의 ID·인증 해시도 일치한다. 운영 데이터와 인증 값 자체는 공개하지 않는다.
- **Mac 내보내기:** 실제 네이티브 파일 저장 창으로 저장한 파일의 권한은 0600, ZIP 무결성은 정상이다. importer로 읽은 결과 3개 페이지·26개 위젯을 확인했으며, 이 파일을 운영 덱에 다시 적용하지 않았다.
- **공개 배포:** macOS ZIP·Android APK·`SHA256SUMS.txt`를 공개 URL에서 직접 내려받아 로컬 빌드 및 GitHub asset digest와 대조했다. 공개 Mac ZIP에 포함된 build-info의 소스 커밋도 일치한다.
- **정리:** 이번 검증용 Android 패키지와 격리 호스트를 제거/종료했다. 검증용 USB 터널 18840은 없고 기존 운영 USB 터널 8840은 유지했다.

증거를 추가한 문서 커밋은 배포 소스 커밋 이후에 만들어졌다. 릴리즈 태그와 앱 build-info는 위의 실제 빌드 소스를 가리킨다. 0.9.0의 설치·릴리즈 결과를 0.10.0 증거로 대신 사용하지 않았다.
