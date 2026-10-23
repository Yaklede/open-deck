# Open Deck 0.11.0 실기기 검증

Samsung SM-T870 실기기에 설치한 **0.11.0 / build 19 후보 앱**에서 아래 16개 검증 항목을 확인했다. 이 문서는 후보 앱의 실행 증거이며, 최종 릴리즈 설치 파일의 확인 결과는 배포 담당자가 아래 별도 구역에 추가한다.

공개 [검증 결과 JSON](evidence/0.11.0-physical.json)은 통과 여부·검증 방법·원본 해시만 포함한다. 실제 지표 수치, 평가 시각, 프로젝트·호스트명, 사용자 설정, 기기 일련번호, 인증 정보, 사건 식별자와 개인 앱 목록은 포함하지 않는다. 원본 화면과 UI 트리·스냅샷은 공개하지 않는다.

## 검증 환경과 판정 기준

- Android: SM-T870의 네이티브 Open Deck 앱. 에뮬레이터가 아니다.
- Mac: 실제 Open Deck Mac 앱. Mac UI에서 한 조작과 확인은 실행 담당자의 관찰 기록으로 구분했다.
- 앱 연결: 태블릿 상단의 **Wi-Fi · 암호화 연결됨** 표시를 직접 검토했다. USB 케이블은 ADB 조작과 증거 수집용으로 연결되어 있었다. USB 케이블을 분리한 시험이나 패킷 캡처 시험으로 기술하지 않는다.
- 지표: 기존 Grafana 데이터를 사용했다. 평균 응답시간·5xx 오류율·RPS는 서비스 데이터의 같은 평가 시각으로 직접 조회한 결과와 원본 숫자를 비교해 정확히 일치했다. 현재 데이터는 **평균 응답시간**이며 P95 결과로 표기하지 않는다.
- 알림: 합성 테스트 알림으로 발생→확인→30분 중지→재개→복구 흐름을 검증했다. 운영 서비스 장애를 유발한 시험이 아니다.

## 실기기 검증 결과

| 번호 | 확인 항목 | 결과 | 근거 유형 |
| --- | --- | --- | --- |
| 1 | CPU를 가장 큰 숫자로 표시하고 서비스 지표는 작은 보조 행으로 분리 | 통과 | independent-visual-review |
| 2 | 평균 응답시간 표기 및 ms 단위 | 통과 | json-and-native-ui |
| 3 | 5xx 오류율과 RPS의 이름·단위 구분 | 통과 | json-and-native-ui |
| 4 | 평균 응답시간의 Grafana 직접 조회 결과 일치 | 통과 | independent-numeric-comparison |
| 5 | 5xx 오류율의 Grafana 직접 조회 결과 일치 | 통과 | independent-numeric-comparison |
| 6 | RPS의 Grafana 직접 조회 결과 일치 | 통과 | independent-numeric-comparison |
| 7 | 상세 화면의 CPU·응답 시간·5xx 오류율·RPS 그래프 선택 컨트롤 | 통과 | native-ui-and-visual-review |
| 8 | 태블릿에서 알림 확인 후 호스트와 Mac UI 반영 | 통과 | host-state-and-runner-observation |
| 9 | Mac에서 30분 알림 중지 후 태블릿에 재개 버튼 표시 | 통과 | host-state-native-ui-and-runner-observation |
| 10 | 연결 중단 중 발생·확인·중지 이력 유지 | 통과 | native-ui-comparison |
| 11 | 연결 중단 안내와 확인·재개 버튼 비활성화 | 통과 | native-control-state |
| 12 | Mac 호스트 재시작 후 같은 알림의 확인·중지 상태와 이력 유지 | 통과 | host-state-native-ui-and-runner-observation |
| 13 | 호스트 재시작에 이어 태블릿 앱을 재시작해도 확인·중지 이력 복원 | 통과 | native-ui-comparison-and-runner-observation |
| 14 | 알림 재개 후 중지 해제와 재개 이력 보존 | 통과 | host-state-and-native-ui |
| 15 | 정상 복구 후 이전 처리 이력 유지 및 처리 버튼 비활성화 | 통과 | native-control-state-and-timeline |
| 16 | 태블릿 앱의 암호화 Wi-Fi 연결 표시 | 통과 | independent-visual-review |

CPU는 가장 큰 숫자로 먼저 읽히고, 평균 응답시간·5xx 오류율·RPS는 작은 보조 행으로 표시된다. DB는 기존 노드별 배치와 그래프를 유지했다. 검토한 화면에서 지표 숫자와 이름의 겹침은 없었다. 상세 화면의 그래프 선택 컨트롤과 기본 CPU 그래프를 확인했으며, 이 기록만으로 모든 그래프 탭의 실제 터치까지 검증했다고 주장하지 않는다.

연결 중단 때 같은 발생·확인·중지 이력이 남아 있고, 연결 안내와 비활성 처리 버튼이 표시되었다. 호스트를 재시작한 뒤 같은 알림의 확인·중지 상태가 유지되었으며, 이어 태블릿 앱을 종료·재실행한 뒤에도 상세 이력과 버튼 상태가 복원되었다. 재개 후에는 중지 상태가 해제되었고, 복구 화면에는 이전 처리 이력과 정상 복구 이력이 함께 남았다.

Mac UI 확인과 앱 종료·재실행 조작은 실행 담당자의 직접 관찰 기록을 인용한다. JSON/XML은 저장 상태·이력·컨트롤 활성 여부를 독립적으로 검증하는 근거이며, 클릭 주체나 프로세스 재시작을 화면 덤프 하나에서 추론한 것은 아니다.

## 원본 증거 해시

아래 파일은 비공개 원본이다. 저장소에는 파일 내용이나 원본 스크린샷을 추가하지 않았다.

| 원본 파일명 | SHA-256 |
| --- | --- |
| `01-tablet-monitor.png` | `de53dac845f29a3a2c20584e3e626eaae7bc7e4bbdf7d41b250b1adbdf2bc53b` |
| `02-tablet-ack-snooze.xml` | `57c272cc1ce8aee42e5f6b226c67518561c0ede9e80e07db3a0b29a97b4ac3b8` |
| `03-tablet-offline-inbox.xml` | `bb394634019b10c35db50b3904da4a361ce1a341b5d8cee0052d3af9b435a727` |
| `04-tablet-after-host-restart.xml` | `ea7adf4aaccb4b132424c55c2e01308df13fc9e2b0c0cc476f45a302e32952ec` |
| `05-tablet-app-restarted.xml` | `39944eb2b322bcf4b584c761c356cf278761933c8bd89f7d832fbffa9cba38e8` |
| `06-tablet-restored-inbox.xml` | `ea7adf4aaccb4b132424c55c2e01308df13fc9e2b0c0cc476f45a302e32952ec` |
| `07-tablet-recovered.xml` | `bbb1d90aa73c1a59940eb4d374d40fdb7436a2eb66f4ca158c4e0964fcec234b` |
| `08-service-details.png` | `04d9ebd3ef326fb7ec3cd0a035b32636086597cd2895a93f558ed39dd15b8115` |
| `08-service-details.xml` | `84afed9a986a757993108530bd4caec3bf4df35670e02e1fd84cf099149e976d` |
| `ack-snooze.json` | `e6dec83bb8e65029369a7ae118ac6d98eae010a606e9355b0af271f94e06dc36` |
| `after-host-restart.json` | `042eaf1852537dbaeb0404cbf5cfac47f1c1b3deb556dd0970819f811f11d0c3` |
| `after-resume.json` | `1c9d4ec68f10feef31946afc291f65bf7106280bd9755735a4ed27cbbc82307c` |
| `direct-grafana-comparison.json` | `8fba2d5e9b5fd900e17f336dd45a7cb6ab70521d45760d1b8d967c4f7a338114` |
| `first-live.json` | `49a5cd51a486a73230b6434630257398a5fb05d3e602a22f6297d507ffa2e975` |

## 자동 검사

- 호스트 테스트: **247/247 통과** (`node --test test/*.test.mjs`).
- Android 서비스 지표 표시·알림 처리 정책: **38/38 통과**.
- 번역: 19개 언어, 1,556개 고정 문자열, 누락·placeholder 오류 0건.
- 최종 커밋의 Mac/Android release 빌드 및 lint 결과는 아래 배포 확인에 추가한다.

## 최종 릴리즈 설치 파일 확인

배포 담당자 기입 예정: 최종 커밋·태그, Mac/Android 버전과 빌드 번호, 서명, 설치 파일 SHA-256, 최종 설치·실행 확인, GitHub 릴리즈 링크.

후보 앱의 실기기 검증 통과를 최종 배포 파일의 동일성 검증으로 대신하지 않는다.
