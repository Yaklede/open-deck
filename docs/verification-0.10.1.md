# Open Deck 0.10.1 — Mac·Android 설정 동기화 검증

이번 검증은 Mac에서 바꾼 태블릿 설정이 열린 Android 설정 화면에 반영되고, Android에서 바꾼 설정도 열린 Mac 설정 화면에 반영되는지 확인한다. 앱을 각각 또는 함께 종료한 뒤 다시 실행했을 때 저장된 설정과 연결이 유지되는지도 별도로 검사한다. 자동 검사, 합성 UI 검사, 실제 Mac 앱과 Android 에뮬레이터 검사를 구분한다.

## 검증 대상

- 앱 버전: `0.10.1`, Android `versionCode 17`
- 양방향 동기화·재시작 검증 소스: 중간 빌드 [`b7d7b3cc0d62d91883bf6485fc1194d37b81c015`](https://github.com/Yaklede/open-deck/commit/b7d7b3cc0d62d91883bf6485fc1194d37b81c015). 최종 배포 소스는 [`a7f2185e350588371299b8fde30f37acc64bfe8b`](https://github.com/Yaklede/open-deck/commit/a7f2185e350588371299b8fde30f37acc64bfe8b)이며, 설정창 테마 재생성 보완을 포함한다.
- 동작 확인 환경: 네이티브 Mac 앱과 Android API 34 태블릿 에뮬레이터
- 범위: 태블릿별 설정, 열린 설정 화면의 갱신, 저장 경합, 재연결 및 앱 재시작 후 유지

물리 태블릿이나 Mac 운영체제 재부팅을 이번 검증에서 수행했다고 주장하지 않는다. 최종 배포 파일의 소스·설치·공개 체크섬 대조는 마지막 절에서 별도로 기록한다.

## 수정 전 재현한 문제

0.10.0의 실제 Mac 앱과 에뮬레이터에서 다음 네 문제를 재현했다. 값과 수행 조건은 [재현 기록](evidence/0.10.1/baseline-reproduction.json)에 있으며, 화면을 닫았다 다시 여는 방식으로 문제를 가리지 않았다.

| 재현 동작 | 실제 관측한 문제 |
| --- | --- |
| Mac 기기 설정을 열어 둔 채 Android에서 시계를 12시간제로 변경 | 서버에는 `12h`가 저장됐지만 열린 Mac 선택 항목은 `24h` 유지 |
| Android 화면 설정을 열어 둔 채 Mac에서 글자 크기를 110%로 변경 | Mac과 서버는 110이지만 열린 Android 표시값은 100% 유지 |
| Mac에서 기기 글자 크기를 115%로 수정한 뒤 하단 ‘설정 저장’ 클릭 | 저장 완료로 표시했으나 서버는 이전 값 110을 유지하고 편집값 소실 |
| 오래 열린 Mac 기기 설정에서 글자 크기만 변경·적용 | Android에서 이미 바꾼 시간 형식까지 Mac의 오래된 폼 값으로 되돌아감 |

## 수정 동작과 코드·검증 연결

| 수정 항목 | 구현 경로 | 검증 |
| --- | --- | --- |
| Android 변경을 열린 Mac 화면에 전달 | `host/server.mjs`의 관리자 SSE에 안전한 기기 목록·설정·revision 포함 → `app.js`의 `receiveSnapshot` → `settings-ui.mjs`의 컨트롤 바인딩 | `test/device-settings-sync.test.mjs`, 합성 UI 검사, 실제 양방향 확인 |
| 다른 필드의 변경 보존 | `host/public/device-drafts.mjs`가 서버 상태와 명시적 편집을 분리하고 변경 필드만 PUT | `test/device-drafts.test.mjs`: 원격 변경과 로컬 초안 병합, 다른 기기 초안 보존 |
| 저장 응답 중 추가 편집 보존 | Mac·Android 모두 필드별 편집 generation을 보관하고 해당 요청이 보낸 편집만 ACK | A→B→A 재편집, 요청 중 원래 값으로 복귀, 늦은 HTTP 응답보다 최신 SSE 우선 검사 |
| Mac의 개별 적용·하단 저장·Cmd+S | `settings-ui.mjs`가 앱 설정과 기기별 pending patch를 각각 저장하고 성공한 항목만 해제 | 합성 UI 9개 검사, 입력 중 Cmd+S·탭 변경·초안 취소 검사 |
| Mac 변경을 열린 Android 컨트롤에 반영 | `ClientSettingsPanel.java`, `SettingsControlBinding.java`가 모델을 읽어 선택·스위치·슬라이더 갱신 | 자동 검사로 프로그램 렌더의 재저장 방지와 드래그 도중 원격 갱신 지연 확인. 열린 선택지의 목록·선택값 갱신 경로는 소스 검토 |
| Android 오프라인 편집 유지 | `ClientSettingsSync.java`의 pending patch → `MainActivity.java`의 `pendingClientSettings` SharedPreferences 저장 → 연결 후 재전송 | `ClientSettingsSyncTest.java`: 앱 상태를 복원한 뒤 미전송 편집과 다른 원격 필드 보존, ACK 후 재시작 시 불필요한 재전송 방지 |
| 삭제된 프로필·페이지로 인한 재시도 정체 방지 | `reconcileNavigation`이 최신 프로필 목록에서 무효가 된 pending navigation만 정리 | 삭제된 프로필·페이지 복구 시 소리 등 무관한 pending 설정 보존 검사 |
| 재페어링·이름 변경의 오래된 응답 차단 | SSE·설정 PUT·이름 PUT에서 페어링 generation과 토큰을 고정하고 오래된 콜백 제외 | 소스 검토와 revision 경합 검사. 이름은 최신 수락 snapshot에서만 적용 |
| Mac·Android 기본값 일치 | `deviceDefaults`와 `ClientSettingsPolicy`를 자동 대조 | 기본 테마 `system`, 진동 80ms 등 기본값 일치 검사 |
| 기기 간 정보 분리 | 관리자만 전체 기기 목록 수신, 태블릿은 자신의 설정만 수신 | 실제 HTTP/SSE 검사에서 다른 기기 목록·토큰·hash·관리자 키 비노출 확인 |

동일 필드의 충돌은 서버에서 마지막으로 적용된 쓰기를 기준으로 한다. 오프라인 편집은 재연결 시 전송되므로 이전에 서버에 저장된 같은 필드를 바꿀 수 있다. 서로 다른 필드는 부분 patch로 보존한다. 응답 도착 순서가 뒤바뀌더라도 revision을 낮추지 않으며, 아직 ACK되지 않은 새로운 로컬 편집은 유지한다.

Mac에서 아직 ‘저장’하지 않은 폼 초안은 실행 중 편집 상태다. 이를 앱 강제 종료 후 복구되는 저장 데이터라고 표현하지 않는다. Android에서 변경한 설정은 즉시 로컬에 저장하며, 미전송 변경도 재연결 대상에 포함한다.

## 자동 검사와 합성 UI 검사

| 검사 | 결과 | 확인 범위 |
| --- | --- | --- |
| 전체 host 테스트 | **176개 통과, 실패 0** | `node --test test/*.test.mjs` |
| Android 설정 정책·동기화 | **131개 검사 통과** | 기존 정책 100개 + 신규 동기화 31개, `scripts/test-settings.sh` |
| 제스처·데이터 최신성 | **18개 + 15개 검사 통과** | `scripts/test-swipe.sh` |
| Android release 빌드·lint | **빌드 성공, 오류 0·경고 21** | 설정 동기화 코드가 포함된 release 컴파일 및 정적 검사 |
| Mac 기기 설정 합성 UI | **9개 통과, 페이지 오류 0** | [실행 결과](evidence/0.10.1/device-settings-sync-ui.json), [합성 설정 화면](evidence/0.10.1/device-settings-sync.png) |
| 독립 호스트 재기동 검사 | **통과** | 임시 localhost 서버 종료·재생성 후 pairing·settings·revision 보존, 서로 다른 필드 보존, 같은 필드의 적용 순서 확인 |

합성 UI 검사는 열린 입력칸의 포커스와 선택 영역 유지, 카테고리 이동 후 초안 유지, 개별 적용과 전체 저장, blur 이전 Cmd+S, 저장 이후 계속되는 원격 변경, 최신 서버 값으로 취소, 닫기 확인을 검사했다. 테스트 환경의 UI 기록을 실제 Mac·Android 앱 재시작 검증으로 대신 사용하지 않는다.

## 네이티브 Mac·Android 에뮬레이터 동작 확인

다음은 중간 빌드 `b7d7b3c`의 실제 설치 앱에서 수행해 확인한 결과다. Mac 앱 UI, Mac 호스트의 저장값, Android 에뮬레이터 화면을 대조했다. 개인정보를 제외한 [실행 기록](evidence/0.10.1/live-settings-validation.json)에 관측값과 최종 빌드의 추가 검증을 함께 기록했다.

| 시나리오 | 현재 결과 | 관측 기준 |
| --- | --- | --- |
| 열린 Android 설정에 Mac 변경 반영 | **확인 완료** | Mac에서 글자 크기 130%를 하단 ‘설정 저장’으로 저장한 뒤 Android 설정 화면을 닫거나 다시 열지 않고 130% 표시 확인 |
| 열린 Mac 설정에 Android 변경 반영 | **확인 완료** | Android에서 24시간제로 변경한 뒤 Mac 기기 설정 화면을 닫거나 다시 열지 않고 `24h` 반영 확인 |
| 서로 다른 필드의 동시 편집 | **확인 완료** | Mac에 글자 크기 135%의 미저장 초안을 둔 상태에서 Android를 `12h`로 변경. 열린 Mac 폼은 초안 135%와 원격 변경 `12h`를 함께 보존했고, Mac 적용 후 서버에도 `{textScale:135,timeFormat:"12h"}` 저장 |
| Android 앱만 종료·재실행 | **확인 완료** | Android 앱을 force-stop한 뒤 재실행. 글자 크기 135%와 `12h`를 유지하고 호스트에 다시 연결 |
| Mac 앱만 종료·재실행 | **확인 완료** | 네이티브 Mac 앱과 호스트를 모두 종료한 뒤 다시 실행. Mac 설정 UI·호스트 저장값·Android에서 모두 135%와 `12h` 확인 |
| Mac·Android 앱 모두 종료·재실행 | **확인 완료** | Mac과 호스트가 꺼진 동안 Android를 `24h`로 변경하고 Android도 force-stop. Mac이 계속 꺼진 상태로 Android를 재실행했을 때 135%와 `24h`가 유지됨. 이어 Mac 실행 후 페어링 재입력 없이 자동 연결 |
| 오프라인 편집의 재시작 후 재전송 | **확인 완료** | 위 동시 종료 순서에서 Mac 실행 후 호스트와 열린 Mac 설정 UI에도 135%와 `24h`가 반영되고 기기 settings revision 15 확인. Android의 미전송 변경이 앱 재실행에도 남아 서버로 전달됨 |

이 검사는 앱과 호스트 프로세스의 종료·재실행이며 운영체제 재부팅을 수행한 결과는 아니다. 운영 덱 화면, 일정·업무 정보, 사용자 기기 식별자, 페어링 토큰은 공개 증거에 포함하지 않는다.

## 최종 빌드 추가 검증

최종 커밋 `a7f2185`에서 다시 빌드하고 Mac과 에뮬레이터에 업데이트 설치했다.

- Mac에서 어두운 테마를 밝게 바꾸면 열린 Android 설정창이 새 테마로 유지됐다. 화면 하단으로 이동해 둔 스크롤 위치도 그대로였다(시계 행 bounds 전후 동일).
- Android에서 화면 켜짐 유지를 끄자 열린 Mac 체크박스도 해제됐다. Android에서 시스템 테마를 선택하면 Mac 표시도 ‘시스템에 맞춤’으로 바뀌었다.
- Mac 하단 저장으로 글자 크기를 100%, 화면 켜짐 유지를 켜짐으로 복원하자 열린 Android 표시도 100%로 갱신됐다.
- **최종 빌드의 양쪽 앱을 다시 완전히 종료·재실행**했다. 페어링 코드 재입력 없이 자동 연결됐고 `{textScale:100,timeFormat:"24h",theme:"system",awake:true}`가 유지됐다.
- 테스트 전후 기존 실태블릿 레코드 전체와 덱의 3개 페이지·26개 위젯 ID가 동일했다.

Android 테마 수정 후 설정 검사 131개와 release 컴파일·lint를 다시 통과했다. 전체 동기화 검사에 영향을 주지 않는 설정창 재생성 변경이며, 최종 설치 앱에서 위 화면 전환을 별도로 검증했다.

## 최종 설치·릴리즈 검증

최종 설치 앱: Mac `0.10.1 / build 17 / a7f2185`, Android `0.10.1 / versionCode 17`.

- Mac 앱의 build-info와 공개 배포 ZIP의 build-info가 버전·빌드·커밋 모두 일치했다.
- Android 업데이트 설치에 기존 서명을 사용했다. 서명 SHA-256: `15cfc6762d9b063abd2ce5b8cd665757f1e30b03707b921abb4619ff38aeba4a`.
- 에뮬레이터에 설치된 APK를 다시 가져와 배포 APK와 SHA-256이 같은 것을 확인했다: `5bc6d92995dfdc63cbd1679c4964789b8774d7308a0f2c3558717c2d99018496`.
- [GitHub 0.10.1 릴리즈](https://github.com/Yaklede/open-deck/releases/tag/v0.10.1)를 최신 릴리즈로 게시했다. 태그는 `a7f2185`를 가리킨다.
- Mac ZIP·Android APK·SHA256SUMS.txt 3개 파일의 공개 업로드를 확인하고 모두 다시 다운로드했다. 로컬 파일·공개 다운로드·GitHub asset digest·체크섬 명세가 일치했다. [릴리즈 검증 JSON](evidence/0.10.1/release-verification.json)에 파일 크기와 SHA-256을 기록했다.

테스트 내역은 이 문서에 기록하고, 사용자용 릴리즈 노트에는 변경 사항과 업데이트 안내만 포함한다.
