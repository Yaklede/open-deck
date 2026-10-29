# Open Deck 0.11.0 실기기 검증

Samsung SM-T870 실기기의 **0.11.0 / build 19**에서 초기 16개, 보완 후 13개, 실제 시간축 4개로 총 **33/33개**를 확인했다. 검증 단계를 구분해 기록하며, 최종 공개 설치 파일의 커밋·서명·동일성과 설치 후 실행도 별도로 확인했다.

공개 [검증 결과 JSON](evidence/0.11.0-physical.json)은 통과 여부·검증 방법·원본 해시만 포함한다. 실제 지표 수치, 평가 시각, 프로젝트·호스트명, 사용자 설정, 기기 일련번호, 인증 정보, 사건 식별자와 개인 앱 목록은 포함하지 않는다. 원본 화면과 UI 트리·스냅샷은 공개하지 않는다.

## 검증 환경과 판정 기준

- Android: SM-T870의 네이티브 Open Deck 앱. 에뮬레이터가 아니다.
- Mac: 실제 Open Deck Mac 앱. Mac UI에서 한 조작과 확인은 실행 담당자의 관찰 기록으로 구분했다.
- 앱 연결: 태블릿 상단의 **Wi-Fi · 암호화 연결됨** 표시를 직접 검토했다. USB 케이블은 ADB 조작과 증거 수집용으로 연결되어 있었다. USB 케이블을 분리한 시험이나 패킷 캡처 시험으로 기술하지 않는다.
- 지표: 기존 Grafana 데이터를 사용했다. 평균 응답시간·5xx 오류율·RPS는 서비스 데이터의 같은 평가 시각으로 직접 조회한 결과와 원본 숫자를 비교해 정확히 일치했다. 현재 데이터는 **평균 응답시간**이며 P95 결과로 표기하지 않는다.
- 알림: 합성 테스트 알림으로 발생→확인→30분 중지→재개→복구 흐름을 검증했다. 운영 서비스 장애를 유발한 시험이 아니다.

## 초기 후보 실기기 검증 결과

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

## 보완 후 2차 실기기 검증

아래 항목은 `dba6382` 후보에서 다시 실행했다. 초기 16개 항목의 근거와 검증 범위를 유지하며, 새 결과를 초기 화면에 소급해 적용하지 않는다.

| 번호 | 확인 항목 | 결과 | 근거 |
| --- | --- | --- | --- |
| 17 | CPU 우선 배치와 작은 서비스 보조 지표 유지 | 통과 | 실행 담당자의 실기기 화면 관찰 |
| 18 | 평균 응답시간 그래프 탭 표시 | 통과 | 탭 선택 기록과 독립 시각 검토 |
| 19 | 5xx 오류율 그래프 탭 표시 | 통과 | 탭 선택 기록과 독립 시각 검토 |
| 20 | RPS 그래프 탭 표시 | 통과 | 탭 선택 기록과 독립 시각 검토 |
| 21 | 태블릿 알림 확인 후 Mac 미확인 건수 1→0 | 통과 | 호스트 상태·태블릿 XML·Mac Cua 직접 관찰 |
| 22 | Mac의 30분 알림 중지를 태블릿 상세에 반영 | 통과 | 호스트 상태·태블릿 XML·Mac 조작 기록 |
| 23 | 두 앱 종료·재실행 후 같은 사건의 확인·중지 이력 유지 | 통과 | 비공개 사건 해시·상태·이력 비교와 실행 기록 |
| 24 | 재실행 후 태블릿 상세의 버튼과 이력 복원 | 통과 | 재실행 전후 상세 XML 동일성 비교 |
| 25 | 합성 알림에 잘못된 수집 지연 표시 없음 | 통과 | 상세 XML 문구 검사와 실행 담당자 상태 확인 |
| 26 | 재개·합성 복구 후 이력 보존 및 처리 버튼 비활성화 | 통과 | JSON 이력 비교와 native 컨트롤 상태 |
| 27 | 운영 덱 설정 보존 | 통과 | 비공개 보존 검사 결과 |
| 28 | 페어링 기기 식별 목록 보존 | 통과 | 비공개 보존 검사 결과 |
| 29 | 태블릿별 설정 보존 | 통과 | 비공개 보존 검사 결과 |

확인·중지 후와 두 앱 재실행 후의 JSON은 같은 사건이며, 확인·중지 상태와 기존 처리 이력이 일치한다. 재실행 전후 알림 상세 XML의 해시도 같고, 확인 버튼은 비활성·재개 버튼은 활성 상태다. 합성 알림에 수집 지연·마지막 상태 유지 안내가 잘못 나타나지 않았다. 축약 JSON에는 `stale` 필드가 없으므로, 그 값 자체의 확인은 실행 담당자의 관찰로 구분했다.

태블릿에서 재개한 뒤 합성 복구를 실행하자 기존 이력에 재개·복구가 추가되고, 사건은 복구 상태로 바뀌었다. 확인·중지 버튼은 모두 비활성화됐다. 이 시험은 **Mac 호스트 앱과 Android 앱의 종료·재실행**이며 Mac 운영체제 재부팅 시험이 아니다.

실행 담당자가 마지막 호스트 시작 이후 진단 로그를 읽기 전용으로 확인한 결과 경고·오류는 각각 0건이었다. 기록된 이벤트는 호스트 시작·기기 설정 저장·알림 처리 각 1건이며 원본 로그는 공개하지 않는다.

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

### 보완 후 비공개 원본 해시

| 원본 파일명 | SHA-256 |
| --- | --- |
| `10-final-monitor.png` | `578ba14663d252fee3cb90dfcd9ed487c8e02b3e3d8a84f6612bb0147360e780` |
| `11-final-details.png` | `1042f31ddf07b998ed04f34598cb042029c2f0a2052657c3642abcf0d0bb448c` |
| `12-final-response-chart.png` | `fe0e3b24c73a7ac3c5349b55f741b28be804f9e8dfaee46d99bb8399fed4338f` |
| `13-final-error-chart.png` | `0caaffbbd015e7dcced7161e197df87c24fd30bbe8487795c712a43929cce9fb` |
| `14-final-rps-chart.png` | `215bd001f2699071fbab8f1099182bc8380269885e3958789aca4db87c70650c` |
| `15-final-ack-snooze.xml` | `32220b88df4f24f5abb78ab5806f8b355a28d3e2f1832fc79bf3e3e89e02fec8` |
| `16-final-apps-restarted.xml` | `b8c66fbfa19f66b4c97117d69806879e52f0b6b15e2278c37deecf0c7087667e` |
| `17-final-restored-inbox.xml` | `32220b88df4f24f5abb78ab5806f8b355a28d3e2f1832fc79bf3e3e89e02fec8` |
| `18-final-recovered.xml` | `577a987e73d0c7df39dd83271b4907651783d053c7c4f33b96991f59d66d4b70` |
| `final-ack-snooze.json` | `b59968b23808d0d3af86cc70ef277adca917e04b393e28800235fa352fee7b25` |
| `final-apps-restarted.json` | `7189a7dfa31bb5d9a88252f96c6bc214deefacdcb4025424d8164c72d34f68ed` |
| `final-recovered.json` | `3b2d61cd17727a05f5d55bd54bb25bc96f524e7ebf992bd7d34eacf98ab8986b` |
| `final-configuration-preserved.json` | `5935bb6156088641ed991a74bb5b4771375284af103136435122f815ff605669` |

## 자동 검사

- 호스트 테스트: **247/247 통과** (`node --test test/*.test.mjs`).
- Android 서비스 지표 표시·알림 처리 정책: **38/38 통과**.
- 번역: 19개 언어, 1,556개 고정 문자열, 누락·placeholder 오류 0건.
- `dba6382` 후보: Mac 빌드·Android release 빌드 성공, Android lint 오류 0건·경고 22건(실행 담당자 기록).
- 실제 시간축·최고점 계산: **14/14 통과**.
- 최종 소스의 Mac/Android release 빌드 성공, Android lint 오류 0건·경고 22건.
- 초기 단계의 검사와 최종 배포 파일 동일성 확인은 구분한다.

## 상세 그래프 실제 시각 검증

CPU·응답시간·5xx 오류율·RPS 탭을 실제 태블릿에서 각각 눌러 시작·중간·끝 시각, 최고점 시각·점·수직선의 정렬을 확인했다. 별도 시각 검토에서도 잘림이나 겹침이 없었고 CPU 우선 표시가 유지됐다. 이 네 항목은 `a4e8f20`의 실행 증거다. 이후 최종 소스는 점선 효과 객체를 재사용하도록 바꿨으며, 최종 설치 앱에서도 CPU 그래프의 시각과 최고점 표시를 다시 확인했다.

| 비공개 원본 | SHA-256 |
| --- | --- |
| `20-time-cpu.png` | `e8a831ece8bf3845a3633ff0d56916502da93fb54fb84e329b96ddd84c7114c6` |
| `21-time-response.png` | `8b738377dfefa9540bb49f0938fa1967f3fb7717bcbdbf21e3f204b7a0c0174b` |
| `22-time-error.png` | `0ccc48444a8183ae9f1ac272570d681b627241211e4c310252d609a4613f258c` |
| `23-time-rps.png` | `7508049bf79ace5f466e0ee92a8fddfb4eb23d4c55f2d6d294340b65bbe1fdc9` |
| `24-release-final.png` | `6d609f9ba2e9078f1b1f50efbc2f3455b9dc0497fdc6813b751eb6df6da04fd1` |
| `25-release-time-cpu.png` | `f798832ab100cabaf50fae1926a0edc24a99c4e585b989d40745aea7bb637760` |
| `release-installed-verification.json` | `a67b240ae73ee5de874c411555095e9ed7684701395706976bfe793c0543d0d9` |

## 최종 릴리즈 설치 파일 확인

- 버전: **0.11.0 / build 19** (Mac·Android 일치)
- 소스·태그 커밋: `0afaa36a8df99d3aafedf97757147a91427148bb`
- [GitHub v0.11.0 릴리즈](https://github.com/Yaklede/open-deck/releases/tag/v0.11.0): 최신 릴리즈 지정, 공개 설치 파일 3개 업로드 완료
- Mac ZIP 내부의 build-info와 설치 앱의 build-info 일치
- 실기기에서 설치된 APK를 읽어 배포 APK와 SHA-256 일치 확인
- 기존 Android 서명 유지; 덱·페어링·기기 설정 유지
- GitHub 제공 digest와 업로드 전 파일이 일치하고, 공개 파일 3개를 다시 다운로드해 모두 SHA-256 일치 확인

| 공개 파일 | SHA-256 |
| --- | --- |
| `Open-Deck-Android.apk` | `d947a23ea2f70cd2a99dcd40a244b71a66b7843c11be1be2500684d44eac6945` |
| `Open-Deck-macOS-arm64.zip` | `fe81cd4330b07e8a7d674713d3fdb15d4231a162b0c61063bf0d7e066fdfdb21` |
| `SHA256SUMS.txt` | `e38830f595d67b062accb68db12c53a255a3d3ec80ad838fbc724c060c90344e` |


최종 확인까지 Mac 운영체제 재부팅은 수행하지 않았다. 실행 검증에는 앱 재시작만 사용했다.
