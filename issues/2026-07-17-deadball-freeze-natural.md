# 데드볼 정지 자연화 — 정지 중 선수 정비 재생 + taker 순간이동 제거 (전 타입)

- **GH 이슈**: #52 (에픽 #25 하위)
- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 · **owned-glob**: `packages/engine/**`
- **선행**: #51 (데드볼 R1 — 스로인 라이브 아웃). 이번은 R1 후속: **정지(freeze) 구간 렌더**를 전 데드볼 타입에 통일 자연화.
- **상태**: Phase 3 진단 (분석 완료, hero gate 전)

---

## 1. 문제정의  <!-- Phase 4 hero gate -->

- **현상**: 데드볼(스로인/코너/프리킥·파울/골킥/페널티)에서 (1) 공이 나가자마자 **taker 가 스팟으로 순간이동**(코너 31m·스로인 15.6m 점프), (2) 정지 중 화면이 얼어붙어 선수들이 정비하는 게 안 보임 → 인위적. hero 모델: `공 나감(라이브) → 정지 → 알림 → **선수들이 자연스럽게 정비(이동)** → 재개`.
- **근본 원인(가설)**: (a) 엔진이 taker 를 causeTick 에 스팟으로 즉시 glue(순간이동), (b) **뷰어가 정지를 정적 프레임 하나로 홀드**해 정지 구간에 이미 존재하는 선수 리포지셔닝 움직임(데이터상 114→61px 등)을 숨김.
- **영향 범위**: 뷰어 정지 렌더(hold) + taker 배치. 전 데드볼 타입. 엔진 taker glue 를 뷰어 워크인으로 덮을지/엔진 변경할지는 계획에서(결정론 영향 여부 포함).

### Phase 2 — 분석 (전 타입 실측)
- 정지 구간 선수 움직임은 **모든 타입에서 데이터에 존재**(뷰어가 홀드로 숨김):
  - corner@148: taker 점프 31.1m · 정지중 전체이동 114,113,95,84,65,61
  - throw_in@231: 15.6m · 107,72,43,17,16,16
  - penalty@163: 4.2m · 76,47,38,22,18,14
  - free_kick@828: 0m · 61,54,38,32,29,20
  - goal_kick@1403: 7.5m · 69,58,51,40,36,36
- 엔진: `contest.ts placeRestart/restartFreeKick/restartPenalty` 가 taker.posFx=스팟 즉시(+ targetFx 핀 #31/#48). match.ts 정지 루프(206-282)는 나머지 선수를 decideOffBall+stepToward 로 매 틱 이동 → 정지 스냅샷에 자연 리포지셔닝이 기록됨.
- 뷰어: `hold` 가 tickPos 를 causeTick 에 고정하고 `until` 까지 draw() 만 반복(index.html tickLoop 436-447) → 단일 프레임 정지. 선수 컷(pt=0, restartTickSet)으로 정비 이동도 안 보임.

### Phase 3 — 진단
- **채택**: 정지 자연스러움의 두 결함 = ① taker 즉시 glue(순간이동) ② 뷰어가 정지를 정적 홀드해 정비 움직임 은폐. 데이터엔 이미 자연 리포지셔닝이 있으니 **뷰어가 정지 구간을 재생**하면 정비가 보이고, **taker 를 워크인**시키면 순간이동이 사라진다.
- 재설계 방향(계획에서 확정): 정지 = 정적 홀드 → **정지 구간 재생**(선수 리포지셔닝 자연 노출) + taker 워크인(뷰어 트윈 or 엔진 non-glue). 전 데드볼 타입 통일. 알림(자막)은 정지 초입, 그 뒤 정비.

---

## 2. 계획 (뷰어 전용, 결정론 무관)

### 설계 판단
- 엔진은 taker+공을 스팟에 glue(공이 스팟 고정돼야 하므로, #31/#48). 엔진을 풀면 공이 taker 따라 드리프트 → **taker 워크인은 뷰어 오버레이**(공=스팟 고정, taker 렌더만 이동)로. 엔진 미변경.
- 정지 중 선수 리포지셔닝은 이미 데이터에 있음(엔진 정지 루프가 매 틱 이동) → 뷰어가 정지를 **재생**하면 노출.

### 채택 방향
1. **정지 재생(freeze play)**: hold 가 tickPos 를 causeTick 에 고정하는 대신, 정지 구간(causeTick~공이 스팟 유지되는 마지막 틱) 동안 **tickPos 를 진행**시켜 비-taker 선수들의 정비 이동을 렌더. 공은 스팟(또는 코너 디플렉션) 유지. 알림(자막)은 정지 초입.
2. **taker 워크인**: taker(공 소유자)를 causeTick 에 스팟으로 컷/글루하지 않고, 직전 인플레이 위치(P)에서 스팟(S)까지 **걷기 속도로 뷰어 트윈**(정지 초반 구간). 단일 프레임 점프 제거. #26(빠른 슬라이드=순간이동)과 구분: 워크인은 정지 중 걷기 페이스(느림).
3. **전 타입 통일**: 스로인/코너/프리킥/골킥/페널티 모두 동일 정지-재생 + taker 워크인.

### E2E Goal
뷰어 재생에서 데드볼 시 공 나감(라이브) → 정지/알림 → **선수들이 걸어서 정비**(taker 도 스팟으로 걸어옴, 순간이동 없음) → 재개 — hero 가 관객 관점 자연스러움 확인.

### Acceptance Criteria
- [x] **AC1** 정지 중 비-taker 선수들이 실제로 이동(정비)하는 게 렌더된다(정적 홀드 아님). Evidence: e2e `deadball-freeze.spec.ts` — 정지 중 cur().tick 진행(고정 아님) green. 실측 throw@525 자막 중 tick 525→534.
- [x] **AC2** taker 가 스팟으로 순간이동하지 않고 워크인. Evidence: e2e — taker 단일프레임 점프 ≤4m green. 실측 H4 경로 (22.5,54.4)→…→(26.0,61.0) 최대점프 1.1m(이전 16m 순간이동).
- [x] **AC3** 전 데드볼 타입: 스로인·코너 e2e green, 프리킥(pauseOnly)도 정지-재생 적용(taker 점프 원래 0m). 페널티는 CAUSE·골킥은 무정지(범위 밖). Evidence: e2e throw_in+corner.
- [x] **AC4** #51 순서 유지. Evidence: caption-order(#49/#51) + setpiece-outflight(#47) e2e green(playwright 34).
- [x] **AC5** 회귀 0: #26·#47/#49/#50/#51 계약 유지. Evidence: `npx playwright test` **34 green** + `npm test` **82 green**.
- [x] **AC6** 결정론/엔진 불변(뷰어 전용). Evidence: `git diff packages/engine/src` 에 #52 변경 없음(index.html/playback.mjs/subsample + e2e/unit 만) + qa-match·6/6.
- [~] **AC7** 독립 QA — **FAIL (blocker 1 + major 1)**. 재작업 필요.
  - **Blocker**: 파울→프리킥(tick 828 등, `foul`+`card`+`free_kick` 겹침)은 `foul`이 CAUSE 분기라 `st.setPiece || st.pauseOnly` 조건에 안 걸림 → 정지-재생/워크인 미발동. 파울 정지 1.1s 전원 정지 + 재개 시 32m 순간이동. **hero "파울도 마찬가지" 미충족.** save/off_target/offside/penalty 동일 구조.
  - **Major**: setPiece 정지-재생 정비가 겉보기 18~24m/s(과속) — freezeSpan(10~14 game-tick)을 hold.dur(650~1250ms)에 압축. 프레임간은 매끄러우나(≤0.23m) 집계속도 비현실적.
  - **정상 확인**: setPiece(코너/스로인) taker 워크인·비-taker 정비·자막순서·기계검증 6/6 정상.
  - → **재작업**: 정지-재생/워크인 조건을 CAUSE 스토피지(파울 등)로 확장 + 압축비(hold.dur↑ 또는 정지 tick 제한) 재검토. #52 는 PR #53 로 merge 됐으므로 follow-up.

### Sub-goals
- SG1: E2E-TDD — "정지 중 선수 이동 렌더 + taker 워크인" 계약 박제.
- SG2: hold 를 정지-재생으로(tickPos 진행) + 정지 범위 판별.
- SG3: taker 워크인 트윈(뷰어 오버레이, 공은 스팟 고정) 전 타입.
- SG4: 회귀 게이트(#26 등) + 실화면 + 독립 QA.

---

## 3. 진행 로그

| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-17 | 1~3 | 전 데드볼 타입 실측: taker 순간이동(코너31·스로인15.6…) + 정지중 선수이동 데이터 존재하나 뷰어가 홀드로 은폐 확정. |
| 2026-07-17 | 4~6 | 문제정의·계획+AC hero 승인(뷰어 전용, taker 워크인은 오버레이). GH #52 → Phase 7. |
| 1 | 2026-07-17 | AC1~AC6 [x] | 정지-재생(`freezeSpanEndIdx` + hold playFrom→playTo 진행) + taker 워크인 오버레이(직전위치→스팟 트윈). 유닛2+e2e2. 게이트 vitest82·playwright34·6/6·engine무관. 실화면 워크인 확인. AC7 독립QA 진행. |

---

## 5. Learned  <!-- Phase 8 -->
