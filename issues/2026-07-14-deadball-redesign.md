# 데드볼 연출 대대적 재설계 — "라이브로 나감 → 컷 → 세트피스"

- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 · **owned-glob**: `packages/engine/**` (엔진+뷰어)
- **성격**: 아키텍처 재설계(패치 누적 되돌리기). #47(synth 아웃비행)·#49(자막 지연)이 이 재설계로 대체될 수 있음. #48(PK 스팟)·#50(홀수틱)은 직교 — 유지.
- **GH 이슈**: #51 (에픽 #25 하위)
- **상태**: Phase 6 계획 (Phase 4 승인 완료, 방향 = **R1**)

---

## 1. 문제정의  <!-- Phase 4, hero gate 후 확정 -->

- **현상**: 스로인 등 데드볼이 부자연스러움 — "경기가 먼저 멈추고(freeze) 그 안에서 공이 인위적으로 스팟으로 이동"하는 느낌(hero 육안). 관객이 원하는 인과: **공이 라인 밖으로 나가는 걸 라이브로 봄 → 컷(점프) → 세트피스/판정**. 지금은 freeze·자막이 아웃 모션보다 먼저/동시라 순서가 꼬임.
- **근본 원인(가설, Phase 3)**: 엔진이 공의 아웃 크로싱 궤적을 데이터로 안 남기고 곧장 스팟 파킹 → 뷰어가 그 부재를 freeze 중 합성(#47)·자막 지연(#49)·보간 컷(spansReposition)으로 메우며 **매커니즘이 6겹으로 누적**됨. "라이브 아웃 모션"이라는 단일 진실 소스가 없어 재현할 수 없고, 대신 freeze 안에서 흉내 냄.
- **영향 범위**: 엔진(아웃 좌표 보존 여부) + 뷰어(데드볼 렌더 파이프라인 전체). 결정론 영향 시 골든 재검증.

---

## 2. 계획 (R1 — 뷰어 재구성, 결정론 무관)

### 핵심 아이디어
데드볼을 **연속 아웃(continuous)** vs **순간이동 아웃(teleport)** 으로 나눈다.
- **연속 아웃**(스로인, off_target 슛): 직전 인플레이 틱이 **움직이는 공**이고 스팟이 곧 크로싱 지점 → 그 구간 보간을 **컷하지 않고 라이브 재생**(뷰어 분수 tickPos 가 여러 렌더프레임으로 부드럽게). 공이 스팟(사이드라인) **도착한 뒤** 짧은 정지+자막. synth 불필요(실 데이터 모션).
- **순간이동 아웃**(코너=세이브 park→깃발): 직전이 **정지 파킹공** → 자연 궤적 없음 → 기존처럼 **명시적 컷 + 정지 + 자막**(공이 골 안으로 안 보이게 유지). 코너 디플렉션 synth 는 유지 또는 최소화.

### 판별 (이미 있는 로직 재사용)
`synthOutFlight`의 moving/parked 판별처럼, causeTick 직전 스냅 속도로 continuous/teleport 구분. continuous 면 라이브 재생 경로, teleport 면 컷 경로.

### 순서 재정의 (hero 모델)
연속 아웃: `라이브 공 이동(나감)` → 스팟 도착 프레임에서 `컷/짧은 freeze` → `자막`. freeze·자막이 아웃 모션보다 **먼저 오지 않음**.

### E2E Goal
뷰어 재생에서 스로인 시 공이 라이브 모션으로 사이드라인까지 가는 게(합성 아닌 실 보간) 보이고, 도착한 뒤 "스로인!" 자막이 뜬다 — hero 가 "나감(라이브)→컷→판정" 순서를 자연스럽게 확인.

### Acceptance Criteria
- [x] **AC1** 연속 아웃(스로인)에서 공이 직전 인플레이→사이드라인 스팟까지 **실 스냅샷 보간으로 라이브 이동**(freeze 중 합성 아님). Evidence: e2e `caption-order.spec.ts:#51` — renderAt(ci-0.5) 공이 prev·spot 중간값으로 보간(컷이면 prev 고정) green. 실측 throw@525 tick524 ball(26.7,51.7) 필드 안 자막없이 이동 → tick525 (29.6,68).
- [x] **AC2** 순서: 스로인 자막은 공이 스팟(사이드라인) 도착 **후** 뜬다. Evidence: e2e #49 caption-order(자막 순간 공 사이드라인) green + 실측(라이브 크로싱 프레임 자막 없음).
- [x] **AC3** 코너(순간이동 아웃)는 공이 골문 안으로 안 보이고(골 오인 없음) 순간이동 티 안 나게 유지. Evidence: corner ballCutTicks 유지(컷) + synth 디플렉션 유지 → e2e #47 corner·restarts corner green.
- [x] **AC4** 파이프라인 단순화: **연속 아웃 경로에서 synth·pendingCaption 제거**(index.html `if(st.setPiece && !st.continuous)` → 연속 스로인은 synth 안 만듦·자막 즉시). synth/자막지연은 이제 teleport(코너)만. 공/선수 컷 분리(ballCutTicks vs restartTicks)로 "라이브 아웃"이 데이터 진실로 표현됨. Evidence: playback.mjs `isContinuousOut`/`buildBallCutTicks` + 유닛 4건 green.
- [x] **AC5** 회귀 0(#47/#49 계약 하위호환 유지). Evidence: `npx playwright test` **32 green** + `npm test` **80 green**(engine/src 무관, 골든 무관) + qa-match·perceptibility 6/6.
- [x] **AC6** 실화면: 스로인 "나감(라이브)→자막" 순서 캡처 육안(§2.5). Evidence: `r1_live_crossing.png` Read — renderAt(ci-0.4) 공 (28.4,61.1) 하단 사이드라인으로 이동 중, **자막/freeze 없음**(경기 진행). 도착 후 자막.
- [x] **AC7** 독립 QA PASS (blocker 0) — "관객이 납득하는 데드볼" 판정. Evidence: 재판정 PASS(재빌드 standalone) — 스로인 9/9 라이브(프레임당 <0.54m, 순간이동 0, 사전정지 0), isContinuousOut 9/9 true, 코너 5·taker 회귀 없음, 관객 관점 "공 나감→판정→재개" 자연스러움 확인. (직전 blocker 4건 해소.)

### Sub-goals
- SG1: E2E-TDD — "연속 아웃은 라이브 재생(freeze 전 공 이동), 자막은 도착 후" 계약 박제.
- SG2: continuous/teleport 판별 + `spansReposition`/정지 트리거를 continuous 는 라이브 재생·도착 후 freeze 로 변경.
- SG3: 연속아웃 경로에서 synth/pendingCaption 제거·단순화(코너 teleport 경로만 유지).
- SG4: 기존 e2e(#47/#49) 계약 새 모델로 개정 + 게이트 + 실화면 + 독립 QA.

---

## Phase 2 — 분석 (데드볼 파이프라인 전체 매핑)

### A. 엔진 쪽 (Explore 조사, 코드 근거)
- **아웃 감지**: `ball.ts:80-110 advanceBall` → 비행 공 한 틱 전진 후 `boundaryCross`(ball.ts:36-73)로 선분-경계 교점 계산. 교점을 **경계선으로 클램프**(ball.ts:54-57).
- **즉시 파킹**: `match.ts:176-198 resolveOut` 이 **같은 틱**에 `restartThrowIn/GoalKick/Corner`(→ `contest.ts:103-134 placeRestart`) 호출 → taker+공을 스팟에 글루, `stoppage=12`. **아웃 크로싱 지점→스팟 사이 중간 틱 없음.**
- **핵심 실측**: match-log 1440 스냅샷 중 경계 밖(y>68/y<0, x>105/x<0) 공 좌표 **0개**. 아웃 궤적은 `OutCross{edge,x,y}`로 축약돼 버려짐. → **엔진은 "공이 라인 넘어가는" 데이터를 보존하지 않는다.**
- **단, 스로인은 1틱 모션 존재**: 예 throw@231 = `t230 (34.7,52.8) 인필드 비행 → t231 (40.7,68) 사이드라인 스팟`. 즉 **직전 인플레이 틱→스팟 = 자연스러운 아웃 크로싱이 이미 연속 스냅샷으로 있음**(스팟이 곧 크로싱 지점).
- **예외 — off_target 슛**: `parkForRestart`(contest.ts:607-618)가 x를 클램프 안 함 → 골라인 살짝 넘은(x>105) park 프레임이 3틱 남음. **유일하게 아웃 좌표가 데이터에 남는 경로**(샘플 시드엔 off_target 없어 미관측).
- **shot_out(세이브→코너)**: 공을 GK 캐치 스팟(102.5,34 중앙)에 3틱 park → 그 뒤 코너 깃발로 스냅. **park(중앙)→깃발 = 진짜 순간이동**(자연 궤적 없음).
- 결정론: 전부 fixed 정수 + 시드 RNG. 아웃 판정은 순수 기하(RNG 무관). 아웃 좌표 보존하려면 advanceBall/resolveOut/snapshot 사이 계층 필요(결정론 재검증 대상).

### B. 뷰어 쪽 (누적된 6겹 메커니즘)
1. `spansReposition`/`restartTicks`(playback.mjs): 재배치 틱 구간 보간 **컷**(순간이동 방지). → 스로인의 자연 아웃 모션(t230→t231)도 컷됨.
2. `buildStoppages`(playback.mjs): CAUSE(선방/빗나감/파울/오프사이드/PK) + SETPIECE_STOP(코너/스로인) + PAUSE_BEAT(프리킥) + goal. + skip(nextRestart, LIVE_LEAD=2) + 같은틱 병합 + wide(leadsToWideRestart) + nextKickoff.
3. `hold`(index.html): freeze 상태머신 — until/start/dur/jumpTo/zoom/wide/synth/pendingCaption/koIdx/tween/formFrom.
4. `synthOutFlight`(#47): freeze 도입부에 아웃비행 **합성**(스로인=스팟까지, 코너=디플렉션 via 2레그).
5. `pendingCaption`(#49): 자막을 SYNTH_MS 뒤로 지연.
6. camera wide/zoom 억제 + 스무딩(#39/#45).
- → "라이브 아웃 모션"을 엔진이 안 줘서, 뷰어가 컷+합성+지연+카메라로 흉내. 인과가 freeze 안에 갇힘 = hero 가 느낀 부자연스러움.

---

## Phase 3 — 진단 (root cause + 재설계 방향)

**채택 근본원인**: 데드볼의 "공이 나가는 사건"이 **엔진에 데이터로 없다**(즉시 스팟 파킹). 뷰어가 이를 freeze 중 합성으로 메우며 6겹 메커니즘이 쌓였고, 순서(나감→판정)가 freeze에 종속돼 꼬인다. 스로인은 실은 직전 인플레이 틱→스팟 1틱 모션이 **이미 데이터에 있는데 뷰어가 컷**한다(가장 아이러니).

### 재설계 방향 후보 (Phase 6에서 확정·hero 승인)
- **R1 (뷰어 우선, 최소 엔진)**: 데드볼을 "freeze 먼저"에서 "**라이브 아웃 모션 → 컷 → 짧은 세트피스 비트**"로 재구성. 스로인/off_target 처럼 직전틱→스팟이 연속이면 **그 구간을 라이브 재생(컷 안 함)** 후 도착하면 자막·짧은 정지. 코너(park→깃발 순간이동)만 명시적 컷. synth/pendingCaption 상당 부분 제거 가능 → 단순화.
- **R2 (엔진이 아웃 레그 방출)**: 엔진이 아웃 크로싱을 실제 몇 틱(경계 밖 좌표 포함)으로 방출(off_target 방식 일반화) → 뷰어는 그냥 라이브 재생 후 컷. 가장 "진짜"지만 결정론 골든 재검증 + 엔진 변경.
- **R3 (하이브리드)**: 엔진은 최소(아웃 크로싱 지점 1틱만 경계 밖으로 살짝 방출) + 뷰어 파이프라인 단순화. R1+R2 절충.
- 공통 목표: 데드볼 렌더 메커니즘 수를 줄이고(6→2~3), 순서를 "나감(라이브)→컷→판정"으로 고정.

---

## 3. 진행 로그

| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-14 | 1~3 | 데드볼 파이프라인 엔진+뷰어 전체 매핑. 근본원인=엔진이 아웃 궤적 미보존→뷰어 6겹 합성. 재설계 방향 R1/R2/R3 도출. |
| 2026-07-14 | 4~6 | 문제정의 승인, 방향 R1 확정. GH #51 등록. 계획+AC 승인 → Phase 7 진입. |
| 1 | 2026-07-16 | AC1~AC6 [x] | R1 구현: 공/선수 컷 분리(ballCutTicks/restartTicks), 연속 스로인 라이브 보간·synth 제거, 코너 teleport 유지. 유닛4+e2e1, 게이트 playwright32·vitest80·6/6. |
| 2 | 2026-07-16 | 블로커 수정 | 독립 QA: 4/9 스로인이 standalone 다운샘플로 prev 밀려 non-continuous 오판→순수 순간이동. 수정: subsample 이 데드볼 causeTick-1/-2 보존(#50 확장) + synthOutFlight 스로인 near 가드 25→45(폴백 슬라이드). standalone 9/9 라이브 확인. 게이트 재통과. AC7 재QA. |
| 3 | 2026-07-16 | AC7 [x] ✅ goal met | 독립 QA 재판정 PASS(blocker 0). 스로인 9/9 라이브·순간이동 0, 관객 자연스러움 확인. 전체 AC1~AC7 완료. |

---

## 5. Learned

- **가설 정확도**: Phase 3 근본원인(엔진이 아웃 궤적 미보존 → 뷰어 6겹 합성)이 정확. R1 핵심 통찰 = "스로인은 직전 인플레이 틱→스팟 1틱 모션이 **이미 데이터에 있는데 뷰어가 컷**한다" → 컷 안 하고 라이브로 틀면 됨. 재합성(synth)보다 실 데이터 재생이 단순·자연.
- **패치 누적 되돌리기**: #47 synth + #49 자막지연은 "엔진이 안 주는 아웃 모션"을 freeze 안에서 흉내낸 것. R1 은 공/선수 컷을 분리(ballCutTicks vs restartTicks)해 연속 아웃은 공 라이브·선수 컷 → synth/자막지연을 연속 경로에서 제거. 근본을 바꾸니 메커니즘이 줄었다.
- **다운샘플 함정(재발, #50 과 동류)**: 최대 교훈 — **거리 기반 판별(isContinuousOut near≤25)이 standalone 짝수틱 다운샘플에서 깨진다**. prev 스냅이 causeTick-1(홀수)이 아니라 2틱 전으로 밀려 거리가 뻥튀기 → 오판 → 순수 순간이동. e2e(풀해상도 viewer-test)는 통과하고 **독립 QA(standalone)만** 잡았다. → 스냅샷 밀도에 의존하는 뷰어 로직은 **사용자가 실제 보는 산출물(standalone)로 검증**해야 하고, 다운샘플은 렌더에 필요한 접근 틱(causeTick-1/-2)을 보존해야 한다.
- **독립 QA 의 가치**: 자기 e2e 는 풀해상도라 다 통과했지만, 독립 QA 가 재빌드 standalone 을 실재생해 4/9 순간이동 blocker 를 잡았다. §2.2 "판정은 독립 QA로만"의 실증. (QA 가 자기 스크립트 오독(영구정지)도 재검증으로 스스로 정정.)
- **다음 단축**: 뷰어 데드볼/보간 관련 작업은 처음부터 standalone(다운샘플)로도 검증. 거리 임계 대신 "직전이 움직였나 + 접근 틱 보존" 조합.
