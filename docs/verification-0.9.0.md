# Open Deck 0.9.0 — 기본 설정 기능 구현·검증 기록

이 문서는 기능의 화면, 저장 위치, 실제 적용 경로와 검증 결과를 연결한다. 화면에 항목이 보이는 것과 해당 설정이 실제 동작하는 것은 별도로 확인한다. 사용자 덱, 인증 토큰, Mac 키체인 값, 기기 페어링 비밀은 이 문서와 테스트 fixture에 포함하지 않는다.

## 비교 기준

공식 [Macro Deck 소스 `7089154c`](https://github.com/Macro-Deck-App/Macro-Deck/tree/7089154cde506c0884bb39c4712863e0fef83d84)를 기준으로 설정 기능을 조사했다. 다음 소스는 비교 범위를 재현할 수 있는 근거다.

| 참조 | Macro Deck 소스 경로 | 확인한 기능 |
| --- | --- | --- |
| MD 설정 | `ui/angular/projects/desktop-ui/src/app/components/shell/settings-modal/settings-modal.component.ts` 및 `sections/*-settings.component.html` | 외관, 실행, 언어, 네트워크, 기기, USB/ADB, 백업, 로그, 정보 |
| MD 설정 계약 | `ui/runtime/src/protocol/messages/settings.ts`, `localization.ts`, `logs.ts` | 설정 값 형식과 실제 변경 요청 |
| MD 기기 | `ui/runtime/src/protocol/messages/device.ts`, `device-client-settings.ts` | 이름, 시작 프로필, 화면 보호, 설정 버튼, 원격 열기, 권한 해제 |
| MD 클라이언트 | `ui/web-client/src/settings/client-settings.ts` | 외관, 표준/간소화 렌더, 아이콘 해상도, 화면 켜짐, 설정 버튼 숨김, 업데이트 |
| MD 프로필 | `ui/runtime/src/protocol/messages/profile.ts`, `folder.ts`, `widget.ts`, `portable.ts` | 프로필·폴더, 기본값, 배치, 고정, 복제, 이식 가능한 내보내기 |
| MD 백업 | `ui/runtime/src/protocol/messages/backup.ts`, `sections/backup-schedule-settings.component.html` | 생성·미리 보기·복원·일정·보관 개수·암호화 |

이 저장소에는 Macro Deck의 별도 유료 native Companion 앱 소스가 없다. 따라서 비교한 클라이언트 기능은 위 공개 소스로 확인한 항목이며, 유료 앱 내부 전체 메뉴를 독립적으로 검증했다는 의미가 아니다. Open Deck 태블릿은 native Android 구현을 유지한다.

## 참조 항목별 상태

아래 표는 **구현**(implemented), **대체 구현**(equivalent), **대상/범위 제외**(platform-out-of-scope), **미구현**(not-implemented)을 구분한다. 대체 구현은 같은 사용자 목적을 지원하지만 원본의 메뉴·보안 방식·파일 형식과 동일하지 않다는 뜻이다. 한 행에 포함된 제한은 해당 기능 전체를 완료로 간주하지 않기 위한 구분이다.

소스 경로 접두사는 `S = ui/angular/projects/desktop-ui/src/app/components/shell/settings-modal/sections/`, `P = ui/runtime/src/protocol/messages/`, `C = ui/web-client/src/settings/`이며, 모두 위에 고정한 공식 소스 revision 기준이다.

| 참조 기능 | 상태 | 참조 소스 | Open Deck 0.9.0 범위·차이 |
| --- | --- | --- | --- |
| 외관 모드·강조색·글꼴·팔레트 | 구현 | `S/appearance-settings.component.html`, `P/settings.ts` | 편집기 외관과 덱 디자인을 각각 설정 |
| 로그인 시 실행·최소화 시작·Dock 표시 | 구현 | `S/startup-settings.component.html`, `S/dock-icon-settings.component.html` | macOS LaunchAgent 및 activation policy |
| 설정 언어·시간 형식 | 대체 구현 | `S/language-settings.component.html`, `P/localization.ts` | 설정센터 한국어/영어와 12/24시간 선택 |
| 전체 앱 다국어 번역·원본 언어 목록 | 미구현 | `S/language-settings.component.html` | 모든 편집기·태블릿 문구를 번역하지 않음 |
| 로컬 편집기 비밀번호·잠금 | 대체 구현 | `S/security-settings.component.html`, `P/auth.ts` | 선택적 로컬 잠금·비밀번호 변경·유휴 잠금; 기기는 계속 동작 |
| 관리자 username 변경·로그인 세션 및 계정 복구 | 미구현 | `P/auth.ts`, `S/security-settings.component.html` | 원본 계정 모델과 다른 로컬 관리자/기기 인증 사용 |
| 비밀 저장소 보호 | 대체 구현 | `S/security-settings.component.html`, `P/key-ring.ts` | 연동 자격 증명은 기존 macOS Keychain; 별도 키링 관리 UI 없음 |
| Wi-Fi 활성화·포트·검색 | 구현 | `S/network-settings.component.html`, `P/settings.ts` | HTTPS listener와 DNS-SD/NSD |
| 인증서 정보·PEM 인증서/개인 키 교체 | 구현 | `S/network-tls-settings.component.html`, `S/network-tls-certificate-upload-modal.component.html` | 유효 기간·키 쌍 검증 후 TLS 컨텍스트 교체 |
| Local CA·HTTP/HTTPS 병행·TLS Replace/Additional 선택 | 미구현 | `P/settings.ts`, `S/network-tls-settings.component.html` | 인증서 pinning을 사용하는 HTTPS 한 종류의 LAN listener |
| ADB 활성화·경로·상태·기기·기본값·Wi-Fi ADB 연결 | 구현 | `S/adb-settings.component.html`, `P/settings.ts` | 설치된 ADB 사용, 상태 조회와 터널 복구 |
| ADB 서버 재시작·플랫폼 도구 다운로드 | 대체 구현 | `S/adb-settings.component.html`, `P/settings.ts` | 공유 서버 영향 확인 후 kill/start; 도구 설치는 공식 다운로드 링크를 통한 수동 설치 |
| 종료 시 ADB 서버 정지 | 미구현 | `S/adb-settings.component.html` | 다른 앱이 공유하는 서버를 자동으로 종료하지 않음 |
| ADB 플러그인 접근 권한 | 대상/범위 제외 | `S/adb-settings.component.html` | 플러그인 설정 범위 |
| native USB Android AOA / iOS transport | 대상/범위 제외 | `S/usb-settings.component.html`, `P/settings.ts` | 이번 대상은 ADB USB와 macOS/Android; 별도 transport 미제공 |
| 기기 이름·연결·모델·버전·시작 프로필·화면 보호 | 구현 | `S/devices-settings.component.html`, `P/device.ts` | Mac과 해당 태블릿에서 기기별 설정; 서버 저장 및 push |
| 기기 원격 열기·로그아웃·제거 | 대체 구현 | `S/devices-settings.component.html`, `P/device.ts` | 선택 프로필/페이지 변경, 원격 화면 보호, pairing 권한 해제 |
| 클라이언트 외관·렌더·아이콘 해상도·켜짐 유지 | 구현 | `C/client-settings.ts` | native Android의 테마·단순 렌더·decode 크기·Window 설정 |
| 클라이언트 설정 버튼 숨김·복구·연결 해제 | 구현 | `P/device-client-settings.ts`, `C/client-settings.ts` | 숨김과 모서리 길게 누르기 복구; 연결 해제/재페어링 |
| 클라이언트 설치·업데이트 | 대체 구현 | `S/companion-app-settings.component.html`, `P/settings.ts` | Open Deck 공개 APK checksum 확인 및 ADB install; 원본 스토어 경로 제외 |
| 프로필 관리·순서·기본값·앱 자동 전환 | 구현 | `P/profile.ts` | 프로필 CRUD/복제/순서/시작·앱 포커스 전환 및 복귀 |
| 폴더 계층·폴더 기본 디자인 상속 | 대체 구현 | `P/folder.ts`, `P/folder-view.ts` | 페이지 parent 관계와 프로필 디자인 상속/페이지 override; 원본 폴더 모델과 동일하지 않음 |
| 빈 셀·그림자·그리드·버튼 크기·고정 | 구현 | `P/folder.ts`, `P/widget.ts` | 페이지별 grid/span 및 global/profile 고정 |
| 다중 선택·복사·붙여넣기·페이지 이동 | 구현 | `P/widget.ts`, `P/folder.ts` | 편집기 일괄 선택·복제 ID 재매핑·이동 |
| 프로필/폴더/위젯 portable 내보내기 | 대체 구현 | `P/portable.ts` | Open Deck 프로필 JSON+이미지·전체/프로필 선택 암호화 백업; 원본 portable 형식 미지원 |
| 수동 백업·목록·미리보기·삭제·가져오기/내보내기 | 구현 | `S/backup-list.component.html`, `P/backup.ts` | 검증한 자체 archive와 참조 이미지 포함 |
| 자동 일/주/월 백업·보관 개수 | 구현 | `S/backup-schedule-settings.component.html`, `P/backup.ts` | interval도 유지; 재시작 후 같은 기간 중복 실행 방지 |
| 전체/선택 복원·복원 전 안전 백업 | 대체 구현 | `P/backup.ts` | 프로필 선택 및 상태 선택; full restore의 앱 설정 복원; 원본 component catalog와 동일하지 않음 |
| 암호화·복구키 | 대체 구현 | `S/backup-recovery-key-settings.component.html`, `P/backup.ts` | 암호를 사용하는 portable export(scrypt/AES-GCM); 로컬 백업은 평문 |
| 복구키 만들기·교체·분실 복구 상태 관리 | 미구현 | `S/backup-recovery-key-settings.component.html` | 원본 복구키 lifecycle 없음 |
| 호스트 버전 변경 시 안전 백업 설정 | 대체 구현 | `S/backup-schedule-settings.component.html`, `P/backup.ts` | 새 버전 첫 실행에서 백업. 설치 파일이 앱을 교체하기 전 단계의 백업은 보장하지 않음 |
| 플러그인 업데이트 전 백업·플러그인 설정 이식 | 대상/범위 제외 | `P/backup.ts` | 플러그인 범위이며 archive에 credentials를 넣지 않음 |
| 이전 버전 데이터 migration | 대체 구현 | `S/migration-settings.component.html`, `P/migration.ts` | 이전 Open Deck v1/v2 덱 대상; Macro Deck 파일 변환은 미구현 |
| 로그 수준·진단 내보내기·데이터 폴더 | 구현 | `S/logging-settings.component.html`, `P/logs.ts`, `P/settings.ts` | 필드 allowlist·회전 파일·JSON export |
| live 로그 검색·필터 목록 | 구현 | `P/logs.ts` | 5초 갱신, 수준·문자열 필터, 읽을 수 있는 시각/이벤트/상세 표 |
| HTTP User-Agent | 구현 | `S/http-settings.component.html`, `P/settings.ts` | 실제 connector 요청 header 적용 |
| 개발 모드 | 대체 구현 | `S/developer-settings.component.html` | 고급 동작 JSON 표시; 원본 개발 도구 전체는 아님 |
| 실험적 client target provision | 대상/범위 제외 | `S/experiments-settings.component.html`, `P/client-target.ts` | 원본의 별도 실험 기능·대상 하드웨어 범위 |
| 앱 버전·업데이트 확인 | 구현 | `S/about-settings.component.html`, `S/update-check.component.html` | 현재 버전·공식 repository 릴리즈/설치 파일 |
| build commit·오픈소스 notices | 구현 | `S/about-settings.component.html`, `S/third-party-notices-modal.component.html` | 패키지 build metadata와 의존성별 라이선스 안내/원문 링크 |
| 계정 구매·라이선스·프로모션·스토어·확장 설정 | 대상/범위 제외 | `S/account-settings.component.html`, `S/license-settings.component.html`, `S/promo-code-modal.component.html`, `S/extensions-settings.component.html` | 서비스 계정/상거래/플러그인 기능 |
| 별도 유료 native Companion 전체 메뉴 | 대상/범위 제외 | 공개 체크아웃에 해당 앱 소스 없음 | 공개 web-client의 확인 가능한 설정을 native Android로 구현 |

## 구현 연결표

`preferences.json`, `deck.json`, `devices.json`은 Open Deck의 로컬 데이터 폴더에 저장된다. 태블릿 로컬 설정은 Android 앱 전용 `SharedPreferences`에 저장된다. 아래의 자동 검증 파일명은 이 저장소의 `test/` 아래 파일이다.

| 비교 기능 | Open Deck 사용 위치 | 저장 키 | 실제 적용 코드·효과 | 자동 검증 |
| --- | --- | --- | --- | --- |
| 설정센터·분류·검색 | Mac → 설정 | 선택 내용은 설정 저장 시 반영 | `host/public/settings-ui.mjs`: 분류형 dialog, 검색, 저장/취소 | UI 실증 별도 확인 |
| 밝게/어둡게/시스템 | Mac 설정 → 화면·언어 | `appearance.themeMode` | `applyAppearance`, `app.css`: 실제 문서 테마 변경, 시스템 테마 변화 구독 | `settings.test.mjs`: 유효성·저장 |
| 강조색·글꼴·크기·팔레트 | Mac 설정 → 화면·언어 | `appearance.accentColor/fontFamily/uiScale/palette` | CSS 변수·문서 속성에 반영, 덱 페이지 스타일과 구분 | `settings.test.mjs` |
| 설정 언어·시간 형식 | Mac 설정 → 화면·언어 | `appearance.language/timeFormat` | 설정센터 한국어/영어, 미리보기 시간 표시 | `settings.test.mjs`; 전체 앱 번역 완료 주장 아님 |
| 자동 실행·창 숨김·Dock | Mac 설정 → Mac 시작·Dock | `startup.autostart/openMinimized/showDockIcon` | `macos/OpenDeck.swift`: 앱 전용 LaunchAgent, 초기 창 표시, 활성화 정책 | Swift 형식 검사; 실기기 증거 별도 |
| HTTPS 연결·포트 | Mac 설정 → 네트워크·USB | `network.wifiEnabled/wifiPort` | `server.mjs`: 새 listener가 성공한 뒤 기존 listener 교체 | `settings-integration.test.mjs`: 점유 포트 실패 시 기존 연결·저장 값 보존, 새 포트 실제 HTTP 200 |
| 호스트 검색 | Mac 광고 + 태블릿 연결 → Wi-Fi 호스트 검색 | `network.discoveryEnabled`, 태블릿 Wi-Fi 주소 목록 | Mac DNS-SD 광고; Android NSD 검색 후 기존 인증서가 일치하는 호스트만 선택 | Java URL 정책 검사; LAN 검색 실증 별도 |
| TLS 인증서 | Mac 설정 → 네트워크·USB → 인증서 | 앱 전용 인증서 파일 | `host/network.mjs`: 인증서·키 검증, 현재 listener 보안 컨텍스트 교체 | `settings-integration.test.mjs`: 키 불일치 시 파일·현재 TLS 보존, 유효 인증서의 실제 TLS 교체, 기기 접근 거부 |
| USB/ADB 선택·진단 | Mac 설정 → 네트워크·USB | `usb.enabled/autoConnect/executablePath/defaultDeviceSerial` | Swift USB 재연결, `host/system-tools.mjs` 실제 ADB 상태·터널·네트워크 연결·확인 후 서버 재시작 | 경로·입력 검증; 실제 장치 조작은 별도 증거 |
| 기기별 설정·이름 | Mac 설정 → 태블릿별 설정 / 태블릿 → 연결·기기 이름 | `devices[].name/settings/settingsRevision` | 인증된 자기 기기만 변경 가능; 서버 저장 및 SSE 전송 | `settings.test.mjs`, `settings-integration.test.mjs`: 기기 분리·재시작·권한·실제 SSE |
| 기기별 시작 프로필·페이지 | Mac 기기 설정 / 태블릿 프로필·시작 페이지 | `profileId/startPageId/rememberPage` | 서버가 선택 프로필 페이지를 전송; 잘못된 프로필 참조 정리 | `settings.test.mjs`, `settings-integration.test.mjs` |
| 프로필 생성·복제·이동 | Mac → 프로필 관리 | `deck.profiles[]/defaultProfileId` | `profiles.mjs`, `profile-tools.mjs`: 기존 ID 보존 migration, 복제 ID 재매핑, 삭제 시 페이지 보존 | `settings.test.mjs`, `profile-editor.test.mjs` |
| 프로필 기본 디자인·페이지별 설정 | Mac 프로필 관리 / 페이지 디자인 | `profiles[].defaults`, `pages[].inheritProfileDesign` | `effectivePages`: 상속 적용; 페이지 override, 간격·모서리·테마·배경·그림자·빈 셀 | `profile-editor.test.mjs` 및 레이아웃 검증 |
| 앱 포커스에 따른 프로필 | Mac 프로필 관리 → 앱 bundle ID | `profiles[].focusApps` | Swift 앱 활성화 알림 → 서버 프로필 전환; 포커스 이탈 복귀 | `settings.test.mjs`; 원격 프로필 상태 확인 |
| 공통 고정 위젯 | Mac 위젯 편집 → 다른 페이지에도 고정 | `widgets[].pinScope` | `effectivePages`: 원본 ID를 공유하고 충돌 배치 정리; 권한 검사도 실제 표시 위젯 기준 | `settings-integration.test.mjs`: 다른 프로필에서 global 고정 버튼 실제 액션 허용 |
| 다중 선택·복사·붙여넣기·이동 | Mac 덱 편집 도구 | 저장된 위젯·페이지 배열 | `app.js`: 일괄 선택, 복제 ID, 다른 페이지 이동, 실행 취소 | `profile-editor.test.mjs` 및 편집 화면 확인 |
| 프로필 내보내기·가져오기 | Mac 프로필 관리 / 가져오기 | 별도 JSON + 참조 이미지 | `profile-tools.mjs`: 디자인·기본 페이지 보존, 새 ID; 가져온 자동 실행 규칙은 안전하게 비활성화 | `profile-editor.test.mjs`: 6개 테스트 |
| 태블릿 화면·밝기·방향 | 태블릿 설정 → 화면·밝기 | `awake/orientation/brightness/fullscreen/textScale` | Window flags, 화면 방향, 앱 밝기, native Canvas 글자 크기 | `ClientSettingsPolicyTest.java`: 범위·밝기 복원 등 |
| 태블릿 터치·탭·스와이프 | 태블릿 설정 → 터치·페이지 이동 | `haptics/fixedVibration/vibrationMs/sound/swipeEnabled/reducedMotion/showHeader/showNavigation` | 실제 진동·클릭 소리·제스처·애니메이션·content inset 분기 | Java 설정 정책 검사; 실제 표시·입력은 별도 증거 |
| 태블릿 테마·렌더·아이콘 | 태블릿 설정 → 화면·밝기 | `theme/renderMode/iconResolution/timeFormat` | native 설정 화면 테마, 효과 축소, 이미지 decode 크기, 시계 형식 | Java 설정 정책 검사 |
| 화면 보호·첫 터치 | 태블릿 설정 → 화면 보호 / Mac 기기 설정 | `screenSaverMinutes/screenSaverMode/dimPercent/firstTouchWakes` | 유휴 타이머·밝기·시계; `WakeInteractionGuard`가 깨우는 전체 터치·키 이벤트를 소비 | Java 84개 검사 중 wake touch/key 시퀀스·유휴 시간 검증 |
| 숨긴 설정 복구 | 태블릿 우측 상단 길게 누르기 | `settingsButtonHidden` | 헤더·탭이 모두 숨겨져도 corner gesture로 native 설정 복구 | 실기기 증거 별도 |
| 알림 선택 | 태블릿 설정 → 알림 | `osNotifications/monitorNotifications/notificationBanner` | OS·모니터링 알림 게시 경로의 설정 분기 | 실제 알림 증거 별도 |
| 오프라인 설정 동기화 | 태블릿 모든 설정 | `clientSettings/pendingClientSettings` | 즉시 로컬 적용 → 미전송 patch 저장 → 재연결 시 재시도; 이전 revision 응답 거부 | Java revision 검사, 호스트 SSE 통합 검사 |
| 수동 백업·미리 보기 | Mac 설정 → 백업·복원 | `backups/<uuid>.json` | `Backups`: 검증한 덱·이미지·앱 설정·선택한 상태를 저장, 체크섬과 실제 크기 표시 | `backups.test.mjs` |
| 암호화 내보내기·가져오기 | Mac 설정 → 백업·복원 | 외부 archive; 암호 저장 안 함 | scrypt + AES-256-GCM; 잘못된 암호/변조 거부; 가져오기는 자동 적용하지 않음 | `backups.test.mjs`: 암호·변조·레거시 migration |
| 전체·선택 프로필 복원 | Mac 설정 → 백업·복원 | 덱 / 앱 설정 / 변수·할 일 상태 | 모든 참조·이미지 검증 → 안전 백업 → 적용. 선택 복원은 다른 프로필·앱 설정 유지 | `backups.test.mjs`, `settings-integration.test.mjs`: 원복·충돌·다른 프로필 보존·실제 API |
| 자동 백업·보관 | Mac 설정 → 백업·복원 | `backups.enabled/beforeUpdate/schedule/time/dayOfWeek/dayOfMonth/intervalHours/retention` | 일/주/월/간격 scheduler, 실행 기록·보관 제한; 호스트 버전 변경 후 첫 실행 백업 | `backups.test.mjs`: 재시작 후 중복 방지·3개 달력 주기·retention |
| 편집기 잠금 | Mac 설정 → 편집기 잠금 | `security.idleLockMinutes`, 소유자 전용 `editor-lock.json` | `EditorLock`: scrypt salted hash, 수동·유휴·재시작 잠금, 잘못된 암호 제한, 관리자 API 423 | `editor-lock.test.mjs`, `settings-integration.test.mjs`: 잠금 중 관리자 읽기/쓰기 차단 및 태블릿 정상 동작, 암호·키 비노출 |
| 진단·로그 수준 | Mac 설정 → 진단·로그 | `logging.minimumLevel`, `diagnostics.jsonl` | 기록 전 수준 필터, allowlist 필드, 0600 회전 로그; 5초 갱신 목록·검색·필터·export | `settings.test.mjs`, `settings-integration.test.mjs`: 수준·인증서 키/기기 토큰/암호 제외; UI 실증 별도 |
| HTTP User-Agent | Mac 설정 → 네트워크·USB | `http.userAgent` | `connectors.mjs` 실제 outgoing request header | `settings.test.mjs`: 전달된 header 검사 |
| 빌드·라이선스 정보 | Mac 설정 → 앱 정보 | 패키지 `host/build-info.json`, 라이선스 안내 목록 | 현재 버전·빌드·소스 commit 및 의존성별 원문 링크 | 최종 패키지/실행 증거 별도 |
| 업데이트·설치 | Mac 설정 → 앱 정보 / 태블릿 정보 / USB 앱 설치 | 현재 버전·GitHub 최신 릴리즈 | 공식 repository release 조회, 알려진 설치 파일, SHA-256 검증 후 ADB install | `settings.test.mjs`: 출처 필터·버전 비교; 실제 배포 검증 별도 |

## 자동 검증 결과

다음 검증은 개인 데이터와 분리된 임시 디렉터리·가상 덱·임시 서버에서 수행했다. 실제 사용자 앱 실행이나 외부 업무 서비스를 호출하지 않는다.

| 명령·범위 | 결과 | 입증하는 내용 |
| --- | --- | --- |
| `node --test test/*.test.mjs` | **106개 통과, 실패 0** | 기존 기능 포함 전체 호스트 회귀 검사 |
| `node --test test/backups.test.mjs` | 18개 통과 | 백업 파일 권한, 이미지 hash, 암호화, 변조 거부, migration, 상태·앱 설정 복원, 선택 복원, 안전 백업, 스케줄·보관, symlink 거부 |
| `node --test test/settings.test.mjs` | 7개 통과 | 설정 입력 검증·영속성, 관리자/기기 권한 분리, 기기별 설정, 재시작, 프로필 migration, 로그 필터, User-Agent·릴리즈 출처 |
| `node --test test/settings-integration.test.mjs` | 8개 통과 | 실제 HTTPS 포트 변경·충돌 복구, 인증서 mismatch 거부·정상 교체·비밀정보 없는 진단, 잠금 시 관리자 차단/태블릿 유지, 고정 버튼 액션, 프로필 복구, SSE 전파·기기 해제, backup API |
| `node --test test/editor-lock.test.mjs` | 1개 통과 | salted hash·0600 파일·재시작/유휴 잠금·암호 변경·실패 시도 제한 |
| `node --test test/profile-editor.test.mjs` | 6개 통과 | 프로필 선택·복제·가져오기, 참조 재매핑·디자인 보존·충돌 처리 |
| `JAVA_HOME=<JDK 17> bash scripts/test-settings.sh` | 84개 검사 통과 | 태블릿 설정 범위, TLS URL 정책, 밝기·유휴 시간, stale revision 거부, 첫 터치/키 오발 방지, `ProfileNavigation`의 프로필 간 이동 |
| `android/gradlew -p android assembleRelease lintRelease` (JDK 17) | 빌드 성공; lint 오류 0 / 경고 21 | 서명된 Android release 컴파일 및 정적 검사. 기존 호환성·인증서 pinning·할당·번역 관련 경고는 남아 있음 |
| Swift `-typecheck ... macos/OpenDeck.swift` | 통과 | native 설정·시작·USB·메시지 핸들러의 빌드 형식 |

sandbox의 로컬 listen 제한 때문에 호스트 통합 검증은 로컬 테스트 서버 실행 권한으로 수행했다. 단순 unit-test 성공을 실제 태블릿 실행 결과로 대신 표기하지 않는다.

## 실기기·화면·배포 증거

2026-10-22, macOS 설치 앱과 Samsung SM-T870 실기기에서 수행했다. ADB는 화면 조작에 사용했고 앱의 데이터 연결은 HTTPS Wi-Fi로 확인했다. 사용자 데이터가 보이는 실기기 원본 이미지는 로컬 증거 폴더에 보관하고 공개 저장소에는 합성 검증 덱의 편집기 화면만 포함했다.

| 실제 확인 | 결과 | 증거 |
| --- | --- | --- |
| Mac 설정센터 테마·크기 저장 | 밝게/110% 저장 → 새로 열기 후 유지 → 어둡게 전환 확인 | [설정센터](evidence/0.9.0/mac-settings.png) |
| 기기별 설정 UI | 분류형 화면·입력·화면 보호·알림 설정, 프로필/시작 페이지 | [기기 설정](evidence/0.9.0/mac-device-settings.png) |
| 프로필 생성·저장 | 합성 덱에 운영 검증 프로필 추가, 선택과 페이지 유지 | [프로필 관리](evidence/0.9.0/mac-profiles.png) |
| 백업 생성·미리보기 | 실제 UI 생성 후 프로필/페이지/버튼 수와 앱 설정 포함 확인 | [백업·복원](evidence/0.9.0/mac-backups.png) |
| 편집기 잠금 | 합성 서버에서 암호 설정 → 잠금 시 관리자 API 423 → 올바른 암호로 200 | `settings-integration.test.mjs`의 잠금/태블릿 유지 검사도 통과 |
| Mac → 실기기 설정 | 상단·하단 탭·설정 버튼 숨김 및 글자 110%가 Wi-Fi로 반영 | 로컬 `tablet-chrome-hidden.png` |
| 실기기 앱 재실행 | 강제 종료 후 다시 실행해 숨김·글자 설정 유지 | 로컬 `tablet-after-restart.png` |
| 숨긴 설정 복구 | 화면 우측 상단 1.2초 누르기 → native 설정 제목을 UI hierarchy에서 확인 | 로컬 `tablet-recovered.xml` |
| 실기기 → Mac 동기화 | 태블릿에서 터치 진동 끄기 → 서버 `haptics:false`, revision 증가 | 로컬 `tablet-touch-settings.png`, 인증 API 결과 |
| 원격 화면 보호·오발 방지 | Mac 명령으로 시계 표시 → ChatGPT 버튼 위치 첫 터치 → 덱으로 복귀, engine 결과 목록 변화 없음 | 로컬 `tablet-screensaver.png`, `tablet-after-wake.png` |
| 기존 덱 보존 | **3페이지·26위젯, ID 배열 및 실행 액션 SHA-256 동일** | 로컬 `installed-check.json` |
| Mac native 설정 | 자동 실행 LaunchAgent `RunAtLoad=true`, 대상 `/Applications/Open Deck.app`; native 상태 오류 없음 | 실제 plist 및 `native-status.json` 확인 |
| 설치 버전·연결 | Mac/Android **0.9.0**, Android build **15**, 실기기 모델·버전 metadata 수신, Wi-Fi online | 기존 앱 위 업데이트 설치 성공 |

테스트로 변경한 태블릿의 글자 크기·상단/하단 표시·설정 버튼·진동·화면 보호 방식은 기존 값으로 되돌렸다. Mac 재부팅은 수행하지 않았다. 새 비밀번호는 합성 검증 서버에서만 사용했으며 사용자 편집기에는 설정하지 않았다.

배포는 [v0.9.0 릴리즈](https://github.com/Yaklede/open-deck/releases/tag/v0.9.0)의 macOS Apple Silicon ZIP·서명 APK·`SHA256SUMS.txt`를 기준으로 한다. 소스 commit과 공개 파일 검증 결과는 별도 배포 기록에 남긴다.

## 차이와 제외 범위

이 기록은 위 표에 연결된 구현과 검증을 증명한다. Macro Deck의 모든 비플러그인 기능이 동작·화면·파일 형식까지 완전히 같다는 인증은 아니다.

- Macro Deck 계정·구매 라이선스·프로모션 코드·스토어 평점·플러그인 설치/업데이트/개발 설정은 이 작업의 기본 로컬 설정 범위에 넣지 않았다.
- Open Deck은 macOS 호스트와 Android native 클라이언트를 대상으로 한다. Windows/Linux 호스트, iOS, 별도 하드웨어 native USB 방식은 제공한다고 주장하지 않는다.
- 편집기 잠금은 로컬 비밀번호 방식으로 제공한다. Macro Deck식 관리자 username·계정 세션·복구키 수명주기는 동일 구현이 아니다. 기기별 인증·권한 해제와 암호를 사용하는 백업 내보내기는 별도로 제공한다.
- 로컬 백업은 소유자 전용 파일 권한을 가진 **평문**이다. 암호화는 사용자가 암호화 내보내기를 선택한 archive에 적용된다. 기기 pairing 정보·기기별 override·키체인·runtime 파일은 백업에 포함하지 않는다. 사용자가 덱의 명령·URL·텍스트에 직접 입력한 내용은 덱 내용의 일부로 포함된다.
- 설정센터 언어 선택을 전체 편집기와 모든 태블릿 문자열의 번역 완료로 간주하지 않는다.
- Macro Deck native `.macroDeckProfile`/`.macroDeckBackup` 형식의 완전한 import, plugin 설정/credentials 이식은 지원한다고 주장하지 않는다. Open Deck JSON 및 이전 v1/v2 덱 JSON을 대상으로 검증했다.
- Repeat/While/Switch 액션 편집기, 독립 스크립트 라이브러리, 일반 표현식 언어 등은 이번 설정 기능 확장과 별개로 남아 있다.
