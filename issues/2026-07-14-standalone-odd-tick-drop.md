# standalone 다운샘플이 홀수틱 이벤트 스냅샷을 드롭 → 세트피스 자막/freeze 스킵

- **GH 이슈**: #50 (에픽 #25 하위)
- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 서브이슈
- **owned-glob**: `packages/engine/dev-viewer/**` (순수 빌드 도구, 결정론 무관)
- **발견 경위**: #49 독립 QA 가 코너@765 "코너킥!" 자막 누락으로 발견(순서 문제 아닌 완전 누락).
- **상태**: Phase 4 문제정의 (hero gate)

---

## 1. 문제정의

- **현상**: standalone 뷰어(`viewer-standalone.html`)에서 코너@765의 "⛳ 코너킥!" 판정 자막/freeze 가 **아예 안 뜸**(관객이 코너 선언을 인지 못 하고 다음 플레이로 넘어감). 풀해상도 e2e 뷰어(viewer-test.html)엔 정상 → standalone 전용. (독립 QA 실측: seek(765)→cur().tick===766.)
- **근본 원인**: `build-standalone.mjs`가 용량 축소로 **틱 2개당 1개(짝수 인덱스)** 서브샘플(STEP=2)해 720 스냅샷을 만드는데 **이벤트는 전부 유지**한다. → 홀수틱 causeTick(코너@765)의 스냅샷이 standalone 에 부재 → `idxOfTick(765)`가 다음 짝수틱(766)으로 반올림 → 선행 세이브(762) 정지의 `hold.jumpTo=idxOfTick(restartTick=765)`가 766 을 가리켜 다음 프레임 `beforeTick=766` → 코너 정지 가드 `causeTick(765) >= beforeTick(766)` 실패 → 코너 정지 스킵.
- **영향 범위**: `build-standalone.mjs` (빌드 도구). standalone 뷰어에서 **홀수틱에 발생하는 모든 이벤트 정지**(코너/스로인/골 등 자막·freeze)가 선행 정지 jump 와 겹치면 스킵될 수 있음(구조적). 엔진/결정론/골든 무관. e2e(풀해상도)는 못 잡음.

### Phase 2 — 분석 (발견 사실)
- `build-standalone.mjs:12-23`: `STEP=2`, `for(i=0;i<len;i+=STEP)` → 짝수 인덱스(=짝수틱, match-log 는 0..1439 연속) 스냅샷만 push. `events: log.events`(28행)로 전 이벤트 유지.
- match-log tickSnapshots = 1440 연속틱(홀수 포함). 코너 causeTick: 148/644/978/1314(짝수) + **765(홀수)**. 스로인 525/559(홀수)·542(짝수) 등.
- 뷰어 idxOfTick(index.html): `snaps.findIndex(s=>s.tick>=tick)` → 홀수틱 요청 시 다음 짝수틱 인덱스로 반올림.
- 정지 트리거 가드(index.html:461-464): `!st.done && causeTick>=beforeTick && causeTick<=afterTick`. 선행 정지 jumpTo 가 causeTick 을 초과 착지하면 실패.

### Phase 3 — 진단
- **채택(확정)**: STEP=2 서브샘플이 이벤트 참조 틱(홀수 causeTick)을 드롭 → idxOfTick 반올림 → 선행 jump 초과 → 정지 스킵. 독립 QA 실측(seek(765)→766)과 코드 일치.
- **수정**: 서브샘플에서 **이벤트 틱(및 정지 restartTick)은 항상 보존**. `keep = (i % STEP===0) || eventTicks.has(tick)`. 홀수 causeTick 스냅샷 유지 → idxOfTick 정확 → 정지 정상 트리거. 용량 증가 미미(이벤트 틱 ~434, 상당수 이미 짝수).

---

## 2. 계획

### 채택 방향 (순수 빌드도구, build-standalone.mjs)
- 서브샘플 로직을 순수 함수 `subsampleSnapshots(tickSnapshots, events, step)` 로 추출·export.
- keep 규칙: `i % step === 0 || eventTicks.has(tick)` — 이벤트 참조 틱(causeTick, 그리고 restartTick 은 대부분 다른 이벤트의 틱이라 자동 포함)을 항상 보존. 이벤트 틱의 직전 스냅(ci-1, 보간용)은 짝수라 기존 유지.
- 스냅샷은 tick 오름차순 유지(중복 제거). 뷰어 idxOfTick/보간 불변.

### E2E Goal
standalone 뷰어(`viewer-standalone.html`) 재생에서 코너@765 등 홀수틱 세트피스의 "코너킥!/스로인!" 자막·freeze 가 정상 표시된다 — hero 가 standalone 을 열어 확인.

### Acceptance Criteria
- [x] **AC1** 서브샘플 결과가 **모든 이벤트 틱**을 포함한다(홀수 포함). Evidence: `subsample.test.ts` — 합성(홀수 이벤트틱 5 보존) + 실 match-log(빠진 이벤트 틱 []) green. (구 STEP=2 는 765 누락.)
- [x] **AC2** standalone 에서 코너@765 "코너킥!" 자막이 뜬다(정지 트리거됨). Evidence: 재빌드 standalone 로드 → `seek(765)→cur().tick===765`(구 766) + 재생 시 "⛳ 코너킥!" 발화, 공 (105,0) 깃발. 실화면 캡처 확인.
- [x] **AC3** 서브샘플 크기 회귀 없음(대폭 증가 X). Evidence: 720→**928 스냅**(+208=보존한 홀수 이벤트틱), 파일 1.1→**1.3MB**(+18%). 디버그 뷰어에 무해(초기 ×1.2 추정보다 이벤트가 홀수틱에 많았음 — bloat 아님, 정확성 위해 전 이벤트틱 보존).
- [x] **AC4** 회귀 0: 뷰어 보간/기존 e2e 계약 유지. Evidence: `npx playwright test` **31 green** + vitest **76 green**.
- [x] **AC5** 결정론/엔진 불변(빌드도구·뷰어 전용). Evidence: #50 변경 = `build-standalone.mjs`(M) + `subsample.mjs`/`subsample.test.ts`(신규)만. engine/src 무관.
- [x] **AC6** 실화면: standalone 코너@765 freeze/자막 캔버스 캡처 육안(§2.5). Evidence: `c765_standalone_fixed.png` Read — "⛳ 코너킥!" 배너 + 공/taker 우상단 코너 깃발(105,0).
- [x] **AC7** 독립 QA PASS (blocker 0). Evidence: 별도 컨텍스트 판정 PASS — seek(765)→765 정확, save→jump→"⛳ 코너킥!" 발화 실화면 확인. 전수(정지 이벤트 35건, 홀수 17건) seek↔cur().tick mismatch 0. 회귀(짝수 코너 4·스로인 3) 자막 정상. 크기 928/1.3MB 정상.

### Sub-goals
- SG1: E2E-TDD — `subsampleSnapshots` 추출 + "모든 이벤트 틱 보존" 유닛 계약(red).
- SG2: keep 규칙 구현(green) + build-standalone 사용부 교체.
- SG3: standalone 재빌드 + 코너@765 자막 실화면/e2e 확인.
- SG4: 회귀 게이트 + 독립 QA.

---

## 3. 진행 로그

| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-14 | 1~3 | 발견(#49 QA)·분석·진단 완료. STEP=2 홀수 causeTick 드롭 → 정지 스킵 확정(build-standalone.mjs:12-23). |
| 2026-07-14 | 4~6 | 문제정의+계획+AC hero 승인(작은 QA fix 는 게이트 생략·QA 세션 보고 진행 OK 방침). GH #50. |
| 1 | 2026-07-14 | AC1~AC6 [x] | E2E-TDD(subsample.test red 개념) → `subsample.mjs` 추출(keep=짝수 OR 이벤트틱) + build-standalone 교체 → 재빌드 928 스냅. 코너@765 자막 발화 확인(seek 765=765, "코너킥!" 실화면). 게이트 vitest76·playwright31. AC7 독립QA 진행. |

---

## 5. Learned  <!-- Phase 8 -->
