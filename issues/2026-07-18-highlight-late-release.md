# 하이라이트가 세이브(키퍼 처리) 후에도 늦게 풀림 — 비대칭 창

- **GH 이슈**: #83 (에픽 #25 하위)
- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 · **owned-glob**: `packages/engine/**`
- **발견**: hero 뷰어 관전 2026-07-18 — "하이라이트 순간 끝났는데 계속 하이라이트. 키퍼가 공을 찬 이후로는 풀려야 되는데 늦게 풀려."
- **상태**: ✅ 완료 (2026-07-18) — 비대칭 창, 게이트 green, 독립 QA PASS.

---

## 1. 문제정의  <!-- Phase 4 hero gate -->

- **현상**: 유효슛→세이브 후 키퍼가 잡고 다시 플레이하는데도 하이라이트(슬로우+줌인)가 ~5~9틱 더 지속되다 늦게 풀린다.
- **근본 원인**: 하이라이트 자동페이싱의 `HL_WINDOW=8`이 keyTick(유효슛/골/PK) 기준 **대칭(±8)**. 그래서 슛 keyTick 이후로도 8틱 슬로우+줌이 이어짐. 클라이맥스(슛→세이브)는 슛+1~2틱에 끝나는데, 뒤 8틱은 과함 → 세이브 후 열린 플레이(키퍼 배급)까지 슬로우.
- **영향 범위**: 뷰어 `index.html` nearKey 계산 2곳(카메라 줌 L~214, 재생속도 L~462). 엔진 무변경.

### Phase 2 — 분석 (사실, 실측)
- keyTicks(`index.html:537`) = goal · penalty · on-target shot(detail≠saved/off_target). `HL_WINDOW=8`, `HL_SPEED=1`(1x), `CRUISE_SPEED=4`. nearKey = `keyTicks.some(kt => Math.abs(kt-curTick) <= HL_WINDOW)`.
- 깨끗한 세이브 케이스 shot@439(7:19): t440 세이브(캐치) → t444/447/448 패스(보유 유지, 코너 없음).
- 실제 재생 샘플(zoom+틱속도): t438~448 zoom 2.6 + 슬로우(~500~950ms/틱) 지속 → **t449에야 릴리스**(zoom 2.31→2.01→1.74, cruise 125ms/틱). 즉 세이브(t440) 후 ~9틱, 플레이 재개(t444) 후 ~5틱 늦게 풀림.
- keyTick=439, ±8 → 하이라이트 431~447(+버퍼 ~449). 뒤쪽 8틱이 세이브 이후 열린 플레이를 덮음.

### Phase 3 — 진단 (root cause + 방향)
- **채택**: 대칭 창의 **뒤쪽(post)이 과함**. 빌드업(앞, 기대감)은 길어도 좋지만, 클라이맥스(슛/세이브) 후엔 빨리 풀려야 자연스럽다.
- **방향**: 하이라이트 창을 **비대칭**으로 — `HL_PRE`(앞, ≈8 유지) · `HL_POST`(뒤, ≈3 축소). keyTick 후 POST 틱만 슬로우+줌 → 세이브/골 직후 릴리스. config성 튜닝값, 순수 함수로 추출해 테스트.
- 반증 검토: "골 클라이맥스도 짧아지나?" → 골은 별도 freeze(bigCaption)가 세리머니 담당 → nearKey POST 짧아도 무방. "엔진 문제?" → 아니오, 순수 뷰어 페이싱.

---

## 2. 계획  <!-- Phase 6 hero gate -->

### E2E Goal
유효슛→세이브 재생 시 하이라이트가 세이브(키퍼 처리) 직후 풀려 열린 플레이가 정상 속도로 이어진다 — hero "제때 풀린다" 확인.

### 방향 (뷰어 전용, 엔진 무변경)
- `playback.mjs`: 순수 함수 `inHighlight(tick, keyTicks, pre, post)` 추가(비대칭 창).
- `index.html`: nearKey 2곳을 `inHighlight`로 교체 + `HL_PRE`(8)·`HL_POST`(3) 상수.

### Acceptance Criteria
- [x] **AC1** 비대칭 하이라이트 창 순수 함수. Evidence: `playback.mjs inHighlight(tick,keyTicks,pre,post)` + `playback.test.ts` #83 계약(kt+3 true·kt+4 false·kt+8 false·kt-8 true·kt-9 false) green(30 tests).
- [x] **AC2** keyTick(슛) 후 하이라이트가 POST(3) 틱 내 풀린다. Evidence: 실측 재생 shot@439 — 속도가 **t443/444에 cruise 복귀**(zoom 2.6→1.0 부드럽게), 세이브(t440) 후 ~4틱. 기존 t449(세이브 후 ~9틱)에서 개선.
- [x] **AC3** 빌드업(앞) + 골/PK 연출 회귀 없음. Evidence: HL_PRE=8 유지(shot@439 빌드업 t431~438 슬로우 확인). 골은 별도 `st.isGoal` hold 경로(inHighlight 무관) — goal@92/318 GOAL freeze 정상.
- [x] **AC4** 결정론/기계게이트 무영향(뷰어 전용). Evidence: npm test 엔진/뷰어 186 passed·qa-match·perceptibility 6/6·playwright 29·**골든 unchanged**·typecheck clean.
- [x] **AC5** 실화면 + 독립 QA PASS(blocker 0). Evidence: independent-qa autoPace play() 프레임별 zoom/속도 실측 — 세이브 후 4틱 내 릴리스, 빌드업 유지, 골 연출·세이브→코너(spSpot 별도 경로) 회귀 없음. PASS.

### Sub-goals
- SG1: E2E-TDD — inHighlight 비대칭 계약 박제.
- SG2: inHighlight 추출 + index.html 2곳 교체 + 상수.
- SG3: 회귀 게이트 + 실화면 + 독립 QA.

---

## 3. 진행 로그

| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-18 | 1~3 | 4:55(현 데모 shot@439/7:19) 하이라이트 늦은 릴리스 실측 확인(세이브 t440 후 t449까지 슬로우+줌). root=HL_WINDOW 대칭 ±8. 방향=비대칭 창(PRE 8·POST 3). |
| 2026-07-18 | 4~7 | E2E-TDD(inHighlight 비대칭 계약 red→green) → playback.mjs inHighlight 추출, index.html HL_PRE 8/HL_POST 3 + nearKey 2곳 교체. 실측 릴리스 t449→t443. npm test186·playwright29·6/6·골든 unchanged·typecheck clean. 독립 QA PASS. 전 AC[x]. |

---

## 5. Learned  <!-- Phase 8 -->

- **연출 창은 비대칭이 자연스럽다**: 클라이맥스(슛/세이브/골) 앞의 빌드업은 길게(기대감), 뒤는 짧게(빨리 복귀). 대칭 창은 뒤쪽이 과해 "끝났는데 계속 슬로우"를 만든다. keyTick 뒤 POST 를 앞 PRE 보다 작게.
- **속도 vs 카메라 분리 인지**: hero 체감 "늦게 풀림"의 본질은 **틱 진행 속도**(슬로우). 줌은 CAM_SMOOTH 로 부드럽게 따라 감소해도, 속도가 cruise 로 복귀하면 "풀린" 것. 독립 QA 도 속도(ms/틱)와 줌을 분리 측정해 확인.
- **연출 경로 분리의 이점**: 골 세리머니(`st.isGoal` hold)·세트피스 줌(`spSpot`)이 하이라이트 창(`inHighlight`)과 별도 경로라, 창을 줄여도 골·코너 연출은 회귀 없음. 경로가 분리돼 있으면 한 축 튜닝이 다른 축을 안 건드린다.
- **데모 재생성으로 타깃 틱 이동**: hero "4:55" 는 이전 빌드 기준 — 2단계 페널티/버전 범프로 데모가 바뀌어 실제 케이스는 shot@439(7:19). 관전 좌표(시:초)는 데모 버전에 종속 → 이벤트 성격(깨끗한 세이브)으로 케이스를 재특정.
