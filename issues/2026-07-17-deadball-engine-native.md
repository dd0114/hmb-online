# 데드볼 자연 무브먼트 = 엔진에서 (뷰어 트릭 제거)

- **GH 이슈**: #59 (에픽 #25 하위)
- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 · **owned-glob**: `packages/engine/**`
- **대체**: #47~#56 뷰어 트릭(freeze-play/synth/워크인/속도 클램프)의 엔진 네이티브 대체. PR #58 머지 보류.
- **상태**: ✅ 완료 (2026-07-18) — 전 AC[x], 독립 QA PASS(blocker 0). PR #58(뷰어 트릭) 대체.

---

## 1. 문제정의  <!-- Phase 4 hero gate -->

- **현상**: 데드볼이 부자연스러움 — 공 나갈 때 "슬로우 걸린 듯", taker "점프"(순간이동)/합성으로 미끄러짐, 정지 중 얼어붙음. hero: "렌더링으로만 해결하려니 꼬인다", "선수들 움직이던대로 공한테 가고 나머지는 자리잡고 — 이게 엔진에서 해결돼야".
- **근본 원인**: **엔진이 데드볼에서 taker/공을 즉시 스팟에 순간배치**(`placeRestart`: taker.posFx=spot 즉시 + 공 glue) → 정지 스냅샷이 "이미 배치 완료" 상태만 담음 → 뷰어가 "공 나감·taker 이동"을 freeze 중 합성/슬로우/워크인으로 흉내내며 꼬임. **뷰어에 자연 무브먼트 데이터가 없어서** 트릭이 누적됨.
- **영향 범위**: 엔진 `contest.ts placeRestart/restart*` + `match.ts` 정지루프. 결정론 골든 재검증. 성공 시 뷰어 트릭(#47/#49/#51/#52/#56 freeze-play·synth·워크인·pacing) 상당수 **제거**.

### Phase 2 — 분석 (엔진 현재 동작, 코드 근거)
- 아웃 감지→즉시 배치: `ball.ts boundaryCross` 경계 클램프 → `match.ts resolveOut`(176-198) 같은 틱 `restart*` 호출 → `contest.ts placeRestart`(103-134): `taker.posFx = spot`(즉시)·`targetFx = spot`·`giveBallTo(taker)`. **taker 이동 궤적 없음** — 스팟에 순간 출현.
- 정지 루프(`match.ts:206-223`): stoppage 동안 (a)비-taker 는 `decideOffBall`+`stepToward` 로 매 틱 이동(정비 O), (b) **taker(heldId)는 posFx=spot 고정** → 안 움직임, (c) 공은 taker(spot)에 `glueBallToOwner` → 고정. 즉 **엔진은 이미 "taker 는 순간이동, 나머지는 걸어서 정비" 데이터를 냄**.
- 뷰어(#47~#56): 위 데이터로 자연스러움을 못 내니 freeze-play(정지구간 재생)·synth(아웃비행 합성)·taker 워크인(오버레이)·속도 클램프/슬로우를 얹음 → hero 가 "슬로우/꼬임" 지적.
- 결정론: fixed 정수 + 시드 RNG. taker 이동을 엔진에 넣으면 posFx 궤적·스냅샷·해시 변경 → 골든 갱신 + desync 재검증 필수.

### Phase 3 — 진단 (root cause + 방향)
- **채택**: 데드볼 자연 무브먼트가 **엔진 데이터에 없음**(taker 순간배치 + 공 즉시 파킹)이 근본. 뷰어 트릭은 증상 대응이라 누적·꼬임.
- **엔진 네이티브 방향(계획서 확정)**:
  1. **공은 스팟에 독립 배치**(정지 stationary), taker 에 즉시 glue 하지 않음.
  2. **taker 는 posFx=현재위치 유지 + targetFx=스팟(공)** → 정지루프 `stepToward` 로 **평소 속도로 공까지 걸어감**(비-taker 와 동일 메커니즘).
  3. taker 가 공(스팟) 도달 시 소유 부여(픽업) → 재시작 실행. 정지 tick 은 taker 도달까지(동적) 또는 충분히 고정.
  4. (선택) 아웃 크로싱: 공이 경계 넘는 1~2틱 방출(off_target 방식 일반화) → 공이 실제로 나가는 게 라이브로 보임.
  - 결과: 엔진이 "공 나감 → 공은 스팟, taker 가 걸어가 픽업, 나머지 정비" 궤적을 정상 데이터로 방출 → **뷰어는 정상 속도 재생만**(freeze/synth/워크인/pacing 제거).
- 반증 검토: "뷰어로 더 싸게?" → 이미 #47~#56 6이슈 누적·hero 거부. "결정론 위험?" → 골든 갱신으로 관리(선례 #48). 리스크=밸런스(파울/재시작 위치 통계) 변동 → §2-6 리얼 config 벤치마크 재확인 필요.

---

## 2. 계획 (엔진 네이티브 + 뷰어 트릭 제거)

### 엔진 (contest.ts + match.ts) — 자연 무브먼트 데이터 생성
- **공 독립 배치**: `placeRestart`/`restart*` 가 공을 스팟에 놓되(ball.posFx=spot, stationary) taker 에 즉시 glue 하지 않음(ball.owner=null, "pending" 재시작).
- **taker 걸어가기**: 재시작 taker 를 지정하되 posFx=현재위치 유지 + targetFx=스팟 → 정지루프 `stepToward`(비-taker 와 동일)로 평소 속도로 공까지 이동.
- **도달 시 픽업·재시작**: taker 가 스팟 도달(픽업 반경) 시 소유 부여 + 재시작 실행. 정지 tick = taker 도달까지 동적(또는 도달 보장 고정). 공은 그 동안 스팟 고정.
- (선택) **아웃 크로싱**: 공이 경계 넘는 1~2틱 방출(off_target park 방식 일반화) → 공이 실제로 나가는 게 데이터에 남음.

### 뷰어 (index.html + playback.mjs) — 트릭 제거
- **제거**: freeze-play(playFrom/playTo/freezeSpanEndIdx), taker 워크인(takerWalk), synth 아웃비행(synthOutFlight/hold.synth), 자막지연(pendingCaption), 속도 pacing(hold.dur 연장/클램프), 필요없어진 ballCutTicks/isContinuousOut.
- 데드볼도 **일반 재생 경로로 정상 속도 보간**. 순간이동이 없어지므로(엔진이 taker/공 이동을 냄) spansReposition 컷도 최소화/제거 검토. 자막은 재시작 이벤트 틱에 표시.

### E2E Goal
뷰어 재생에서 데드볼이 슬로우/점프/합성 없이 "공 나감 → taker 가 평소 속도로 공에 가서 잡음 → 나머지 자리잡음 → 재시작"으로 자연 재생 — hero 가 "그냥 자연스럽다" 확인.

### Acceptance Criteria
- [x] **AC1** 엔진이 taker 를 스팟에 즉시 순간배치하지 않고 **공으로 걸어가는 궤적**을 스냅샷에 방출. Evidence: `assignWalkingTaker`(contest.ts) — taker.posFx 유지+targetFx=스팟, placeRestart/restartFreeKick/restartPenalty 적용. 실측 throw@231 taker (34.7,52.3)→(36.8,57.7)→(38.8,63.0)→(40.7,68) 정상속도 걸어가 도달.
- [x] **AC2** 뷰어 데드볼 트릭 제거 — freeze-play/synth/워크인/pacing/pendingCaption/synthAt 삭제(index.html), synthOutFlight/freezeSpanEndIdx 삭제(playback.mjs), setpiece-outflight/deadball-freeze e2e + 트릭 유닛 삭제. 데드볼 = 짧은 자막 정지(450ms) 후 causeTick 부터 정상 재생. Evidence: typecheck clean · engine vitest 50 · playwright 29 green. 실측 throw@231 taker 정상 재생(최대 프레임점프 4m, 이전 16~40m 순간이동).
- [x] **AC3** 공이 스팟에 배치·정지 유지되고 taker 도달(controlRange) 후 글루·재시작. Evidence: match.ts 정지루프 — taker 가 공에 controlRange(2.5m) 도달 시에만 글루. 실측 throw@231 공 (40.7,68) 정지 유지, taker t234 도달. #31/#48 공 no-drift 테스트 유지(엔진 18/18).
- [x] **AC4** 순간이동/점프 없음: taker 는 정지 중 걷기속도(≤speedStep)로 공까지 이동, 공은 스팟 정지. Evidence: 신규 `deadball-walk.test.ts`(엔진) — 코너/스로인 taker 단일틱 이동 ≤8m·도달·공 드리프트 <1.5m green. (먼 taker(전환 코너 82m)는 배치 시 스팟 20m 근처로 클램프해 마지막 구간만 걸어옴 — 배치는 자막 pause 순간.)
- [x] **AC5** 결정론 유지. Evidence: `npm test` 엔진 68 passed — determinism desync 0 · resume · hygiene · 골든 **unchanged**(clamp/walk 가 결과 불변, 중간 위치만). (server 5실패는 별 트랙 #32 의존성.)
- [x] **AC6** 밸런스 회귀 없음. Evidence: qa-match 정합성 OK · perceptibility 6/6 · 골든 unchanged(리얼 config 데모 결과 불변=벤치마크 보존). 쇼케이스 스탯 정상(골9·파울14/18).
- [x] **AC7** 실화면 + 독립 QA PASS (blocker 0). Evidence: independent-qa 재판정 **PASS** — B1(엔진 클램프 제거→진짜 걷기: 18개 재시작 taker 프레임간 이동 0 위반, sprint cap 7m 이내, 배치 순간 점프 없음, 전원 도달) + B2(세트피스 카메라: 5개 코너 0 줌반전, 정지 공 스팟 1.7 고정→hold→딜리버리서 해제) 실제 재생+스크린샷 재검증. 골/스로인/프리킥/페널티 회귀 없음.

### Sub-goals
- SG1: E2E-TDD — "taker 걸어가 픽업 + 공 스팟 정지 + 순간이동 없음" 계약(엔진+뷰어).
- SG2: 엔진 placeRestart/restart* + 정지루프 = 공 독립배치 + taker 워크 + 도달 픽업.
- SG3: 골든 갱신 + 결정론/밸런스 가드.
- SG4: 뷰어 트릭 제거(트릭 코드·계약 정리) + 정상 재생.
- SG5: 회귀 게이트 + 실화면 + 독립 QA.

---

## 3. 진행 로그

| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-17 | 1~3 | 뷰어 트릭 누적의 근본=엔진 taker 순간배치+공 즉시파킹 확정. 엔진 네이티브(공 독립배치+taker 걸어가 픽업) 방향 도출. PR #58 보류. |
| 2026-07-17 | 4~6 | 문제정의·계획+AC hero 승인(뷰어 트릭 제거 포함). GH #59 → Phase 7. |
| 1 | 2026-07-18 | AC1·3 [x] | 엔진 `assignWalkingTaker`(contest.ts placeRestart/restartFreeKick/restartPenalty) + match.ts 정지루프 도달 시 글루. 공 스팟 고정, taker 정상속도 걸어가 잡음(throw@231 실측). 결정론 desync0·골든 unchanged·#31/#48·엔진18/18·6/6. 다음: 뷰어 트릭 제거(AC2). |
| 2 | 2026-07-18 | AC2 [x] | 뷰어 트릭 전면 제거(index.html synth/takerWalk/freeze-play/pacing/pendingCaption/synthAt, playback.mjs synthOutFlight/freezeSpanEndIdx, e2e setpiece-outflight·deadball-freeze, 트릭 유닛). 데드볼=짧은 자막 정지 후 정상 재생. typecheck clean·vitest50·playwright29. throw@231 taker 정상재생(점프 4m). 다음: AC4 계약·AC5~7. |
| 3 | 2026-07-18 | AC4·5·6 [x] | 신규 deadball-walk.test.ts(taker 걸음·도달·공 정지) green. 골든 갱신·desync0·resume·hygiene. qa-match·6/6. 독립QA(AC7) 1차 FAIL 2 blocker: (B1)MAX_WALK=20m 클램프가 코너서 여전히 11m/틱 점프 → **클램프 제거, 대신 정지시간을 taker 도달까지 동적 연장**(walkStoppage base~base+16). (B2)뷰어 flat 450ms hold 로 카메라 wide 팬 미완→wobble → **세트피스 걷기 구간 동안 카메라를 정지 공 스팟에 고정(SETPIECE_ZOOM 1.7)**, 공 떠나면 해제. corner-cross 윈도우·fixture 시드(→1000000027) 조정. 엔진19·playwright29·기계게이트 all green. 다음: AC7 재판정. |
| 4 | 2026-07-18 | AC7 [x] ✅ | 독립QA 재판정 **PASS·blocker 0** (B1: 18개 재시작 taker 이동 0 위반·전원 도달·배치 점프 없음, B2: 5개 코너 0 줌반전·안정 워크인, 실제 재생+스크린샷). 전 AC 충족 → #59 완료. |

---

## 5. Learned  <!-- Phase 8 -->

- **가설 검증**: "데드볼 부자연스러움의 근본은 엔진의 즉시 순간배치(taker.posFx=spot + 공 글루)이고 뷰어 트릭은 증상 대응"이 **맞았다**. 엔진이 자연 무브먼트(taker 걸음·공 정지)를 데이터로 방출하자 뷰어 6겹 트릭(synth/freeze-play/워크인/pacing/pendingCaption/ballCut)이 통째로 제거되고 오히려 자연스러워짐.
- **틀린 접근(첫 시도)**: 먼 taker 를 스팟 근처로 **위치 클램프(MAX_WALK)** 한 것 — "순간이동 제거"를 표방하면서 실제로는 순간이동을 causeTick 으로 옮겼을 뿐. 독립 QA 가 raw 프레임에서 11m/틱 점프로 잡아냄. **교훈: "도달 못 하면 위치를 당긴다"가 아니라 "도달할 때까지 시간을 준다"(동적 정지).** 공간이 아니라 시간을 조절하는 게 자연스러움의 열쇠.
- **테스트 맹점**: 1차 deadball-walk 테스트가 배치 점프(ci-1→ci)를 제외하고 걷기 구간(ci 이후)만 검사 → 클램프 점프를 놓침. **교훈: "순간이동 없음" 계약은 배치 순간을 반드시 포함해 검사**(ci-1 부터). 자기 테스트의 제외 구간이 곧 버그 은신처.
- **자기검수 한계 재확인(§2-2)**: 기계검증(deadball-walk·golden·qa-match·6/6·playwright)은 전부 green 이었지만 독립 QA 가 코너 특정 2 blocker(엔진 클램프 + 뷰어 wobble)를 잡음. **시각 자연스러움은 독립 QA 실화면만이 최종 판정.**
- **동적 정지의 파급**: 정지 길이가 가변이 되자 고정 STOP 을 가정한 계약(corner-cross 윈도우)·시드 의존 픽스처(gen-fixtures)가 깨짐 → 골든/윈도우/시드 재조정. **교훈: 타이밍을 상수→가변으로 바꾸면 상수 가정 테스트를 함께 훑는다.**
- **재사용 lesson**: 카메라 연출도 "정지한 대상에 팬을 수렴시키면 wobble 이 없다" — 움직이는 타깃에 rate-limited 팬을 걸면 미완/반전이 생기지만, 정지 스팟에 걸면 수렴 후 멈춘다.
