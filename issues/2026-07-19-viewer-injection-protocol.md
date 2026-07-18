# R1 뷰어 소비 주입 계약 네이티브화 (postMessage) — #65

- **GH 이슈**: #65 (에픽 #25 하위 · 상위 트래킹 #60 · 관련 #57)
- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 · **owned-glob**: `packages/engine/**`
- **요청 출처**: web 에픽(v2) → QA 도메인. 매니저 지시(2026-07-19): 새 인터페이스 설계 말고 **현행 소비측 프로토콜을 그대로 정식화**.
- **상태**: ✅ 완료 (2026-07-19) — 네이티브 지원 + 하드닝, 게이트 green, 독립 QA PASS.

---

## 1. 문제정의

- **현상/가치**: web은 이미 우리 `viewer-standalone.html`을 후처리 브리지(`apps/web/scripts/build-viewer.mjs`)로 감싸 소비 중(PR #77/#79). 그 브리지가 뷰어 **내부(fetch("./match-log.json") 로드 경로)를 가로채** 부모 주입 로그로 resolve → **우리가 내부 로딩을 바꾸면 브리지가 깨짐**. 정식 주입 인터페이스를 뷰어가 네이티브 지원해 견고화(브리지 제거 → web 변경 0 수렴).
- **계약(현행 그대로 — 2메시지)**:
  - iframe → parent: `{type:'viewerReady'}` (로드 완료, 주입 받을 준비)
  - parent → iframe: `{type:'loadMatchLog', matchLog}` (해당 로그로 (재)초기화)
  - 레이스: 어느 쪽이 먼저든 부모 reducer(`shouldPostLog`)가 처리 — 우리는 리스너를 먼저 등록 후 viewerReady 송신.
- **소비측 참조(읽기 전용, 타 세션 소유)**: `apps/web/src/match/viewer-bridge.ts`(부모 프로토콜·상태머신), `apps/web/scripts/build-viewer.mjs`(현행 fetch-가로채기 브리지).
- **근본**: 뷰어에 주입 훅이 없어 소비측이 fetch 경로를 가로채는 취약 후처리에 의존. → 뷰어가 계약을 네이티브 지원.
- **영향 범위**: 뷰어 `index.html` 로드 부트스트랩만. 엔진·결정론·연출 무변경. standalone(`__LOG__`)·e2e·직접 열기 경로 불변.

## 2. 계획 (뷰어 전용)

### 방향
`index.html` 부트스트랩에:
1. **리스너 먼저 등록**: `message` 이벤트 → `{type:'loadMatchLog', matchLog}` 수신 시 `loadLog(matchLog)`(멱등 재초기화).
2. **임베드 감지**(`window.parent !== window`)면 로드 시 부모에 `postMessage({type:'viewerReady'}, '*')` 송신(초기 + `load`).
3. 로드 소스 분기: `__LOG__` 있으면 즉시 로드(standalone) → 이후 주입 오면 override. `__LOG__` 없고 임베드면 **fetch 대신 주입 대기**(상태 "호스트 주입 대기…"). 둘 다 아니면 기존 fetch.

### Acceptance Criteria
- [x] **AC1** 임베드(iframe) 로드 시 부모에 `{type:'viewerReady'}` 송신. Evidence: `e2e/embed-inject.spec.ts` + `embed-host.html`(동종오리진 호스트) — readyCount>0. green.
- [x] **AC2** `{type:'loadMatchLog', matchLog}` 수신 시 그 로그로 (재)초기화. Evidence: e2e — 주입 후 Playwright frame API 로 iframe `__viewer.events()`=2·home 골·status seed "inject-marker-777" 확인.
- [x] **AC3** 레이스 안전 + 재주입 지원. Evidence: 리스너를 `__LOG__`/embed 분기 **전에** 등록(먼저 온 loadMatchLog 수신); 톱레벨 재주입 테스트(데모→주입 로그 재초기화, loadLog 멱등) green.
- [x] **AC4** 회귀 없음 — standalone(`__LOG__`)·직접 열기·기존 e2e 정상. Evidence: playwright 31(기존 29+embed 2)·뷰어 유닛 34·typecheck 0·standalone 재빌드 score 6:5(‌__LOG__ 로드) green. 엔진/골든 무변경.
- [x] **AC5** 독립 QA PASS(blocker 0) + #65 명세 코멘트. Evidence: independent-qa — 임베드 핸드셰이크·주입·재주입·실제 재생(골 연출)·standalone/직접열기 회귀·계약 일치 전부 확인. #65 에 명세+경로 코멘트(매니저 web 브리지 제거 처리).
- [x] **AC6 (하드닝)** 손상 MatchLog 주입이 렌더를 죽이지 않음. Evidence: (독립 QA 발견 — 서버 스키마 드리프트/하프 손상 시 뷰어 통째 멈추던 기존 리스크, #65 가 신뢰경계 밖 데이터에 노출) → loadLog 원자적 검증(변경 전)·주입 핸들러 try/catch·tickLoop 예외 방어 래퍼. e2e "손상 페이로드…회복" green(손상 주입→실패 표시→유효 재주입→play 진행·pageerror 0).

### Sub-goals
- SG1: E2E-TDD — iframe 임베드 핸드셰이크 계약(viewerReady↔loadMatchLog) 박제.
- SG2: index.html 부트스트랩 네이티브 지원.
- SG3: 회귀 게이트 + #65 코멘트(명세·경로) + 버전 발행.

---

## 3. 진행 로그

| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-19 | 1~2 | 매니저 지시 접수 — 현행 계약(viewerReady/loadMatchLog) 정식화. 소비측 브리지(fetch 가로채기) 파악. loadLog 멱등 확인 → 주입 적합. |
| 2026-07-19 | 6~7 | E2E-TDD(embed-inject.spec + embed-host.html, red→green) → index.html 부트스트랩 네이티브 지원(리스너 선등록·embed 감지·viewerReady·로드분기). 독립 QA PASS(blocker0)가 malformed-payload 렌더 사망 리스크 발견 → 하드닝(원자검증+try/catch+tickLoop 래퍼) 추가·e2e 박제. playwright32·뷰어유닛34·typecheck0·엔진/골든 무변경. 전 AC[x]. |

---

## 5. Learned

- **정식 인터페이스 = 소비측 계약을 그대로 승격**: 새 설계 대신 현행 브리지(viewer-bridge.ts)의 2메시지를 뷰어가 네이티브 지원 → web 변경은 브리지 제거뿐(0 수렴). 소비측이 이미 굳힌 계약을 존중하면 마이그레이션 비용이 없다.
- **file:// 크로스프레임 테스트**: Chromium 은 file:// 프레임 간 JS 접근을 opaque-origin(null) 으로 막는다. 호스트 JS 로 iframe `__viewer` 접근 불가 → **Playwright frame API(CDP)** 로 프레임 내부 evaluate(브라우저 same-origin 정책 우회). 동종오리진 호스트 파일(embed-host.html)로 핸드셰이크만, 검증은 frame API.
- **신뢰 경계 확장 = 하드닝 필요**: 주입 API 는 뷰어를 신뢰경계 밖(부모/서버) 데이터에 노출 → 기존 loadLog 의 방어코드 부재가 실질 리스크로 승격(손상 페이로드 → rAF 렌더루프 영구 사망). 원자적 검증(변경 전) + 렌더루프 예외 방어가 필수. **입력 출처가 바뀌면(내부→외부) 같은 코드도 재평가**한다.
- **독립 QA 의 잠복결함 발굴**: 정상 케이스는 통과여도 독립 QA 가 malformed 입력 내구성(비차단이지만 실서비스 리스크)을 잡아냄 → 게이트 통과 + 후속 하드닝을 그 자리에서 반영.
