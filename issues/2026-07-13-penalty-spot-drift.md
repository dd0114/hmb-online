# PK 좌표 드리프트 — 페널티킥이 스팟이 아닌 파울 직전 위치에서 실행됨

- **GH 이슈**: #48 (에픽 #25 하위)
- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 서브이슈
- **owned-glob**: `packages/engine/**` (엔진 — **결정론 골든 갱신 필요**)
- **선례**: #31 (코너/스로인 taker 드리프트를 `targetFx` 핀으로 수정) — 페널티만 누락
- **상태**: Phase 6 계획 (hero gate)

---

## 1. 문제정의

- **현상**: hero 육안(2026-07-13, 뷰어 2'43" 페널티). PK가 페널티 스팟(정중앙)이 아니라 옆으로 치우친 위치에서 실행됨. 실측: 선언틱 t163 공 `(94.0, 34.0)`=정스팟이지만, freeze 7틱(t164~171) 동안 공이 `(96.0, 37.7)`로 밀려나 거기서 슛(y=37.7은 골포스트 37.66 바로 밖 → 각도도 부자연).
- **근본 원인**: `restartPenalty`(contest.ts:277-292)가 taker 의 `posFx`만 스팟으로 고정하고 **`targetFx`는 파울 직전 오픈플레이 값(96,37.7) 그대로** 둠. 세트피스 freeze 이동 루프(match.ts:213-219)가 매 틱 모든 선수를 `targetFx`로 한 스텝 이동시키므로, PK 타자가 freeze 첫 틱에 스팟에서 걸어나가고 공이 딸려감(`glueBallToOwner`, match.ts:220-223). → 동일 버그가 코너/스로인엔 #31에서 `taker.targetFx = spot`(contest.ts:118-122)으로 수정됐으나 **페널티만 그 라인 누락**.
- **영향 범위**: 엔진(`packages/engine/src/contest.ts`). PK 발생 시마다 좌표·슛 각도 왜곡. 결정론 데이터가 바뀌므로 골든 스냅샷 갱신 필요. PK xG/성공 자체는 유지(위치만 정정).

### Phase 2 — 분석 (발견 사실)
- match.ts:206-223 freeze 블록: `state.stoppage>0`이면 모든 선수를 `stepToward(posFx→targetFx)` 한 스텝 이동(213-219) 후, held owner 에 `glueBallToOwner`(220-223). held owner 도 이동 대상.
- contest.ts `restartSetPiece`(코너/스로인/골킥, 110-134): taker `posFx`+**`targetFx` 둘 다 스팟**(118-122). 주석에 #31 드리프트 수정 명시.
- contest.ts `restartPenalty`(277-292): taker `posFx`만 스팟(281-282), `targetFx` 미설정.
- match.ts:248-273 PK 실행: 정지 종료 시 `state.ball.owner`(현재 위치)에서 골로 슛 발사 — 공을 스팟으로 재배치하지 않음.
- 실데이터(match-log showcase, penalty t163): t163 (94,34) → t164~171 (96,37.7) → t172 goal.

### Phase 3 — 진단
- **채택(확정)**: `restartPenalty` 의 `taker.targetFx` 누락. 코너/스로인 선례(#31)와 동일 메커니즘. 반증 없음 — 코드에 선례 주석 + 실데이터 드리프트 일치.
- **수정**: `restartPenalty` taker 분기에 `taker.targetFx = { x: spot.x, y: spot.y }` 추가(restartSetPiece 패턴 그대로).

---

## 2. 계획

### E2E Goal
헤드리스 재생(또는 showcase 재생성)에서 PK freeze 전 구간 공/타자가 페널티 스팟(정중앙, y=34)에 머물고, PK 슛이 스팟에서 발사된다 — 뷰어에서 PK가 중앙에서 실행되는 걸 hero 가 확인.

### Acceptance Criteria
- [x] **AC1** PK freeze 전체 구간(선언~슛 직전) 공이 페널티 스팟에 유지된다(드리프트 0). Evidence: 뷰어 render 궤적 t163~t171 전부 `(94.0, 34.0)` 유지(수정 전 5.8m 드리프트). penalty-spot.test.ts green.
- [x] **AC2** PK 슛 발사 위치가 스팟(정중앙). Evidence: showcase PK슛@171 ball `(94.0, 34.0)` (수정 전 96.0,37.7). render t172 골 비행 104.5,34.
- [x] **AC3** 결정론 유지 + 골든 갱신 반영. Evidence: `npm test` **74 green** desync 0 + resume + hygiene, 골든 스냅샷 갱신(events 1626→1562·goals 6→9·lastHash ee8961f9). firstHash·ticks 불변.
- [x] **AC4** 회귀 0: 코너/스로인 taker 스팟(#31)·규칙·뷰어 계약 유지. Evidence: `npx vitest run packages/engine` **49 green** + `npx playwright test` **29 green**(#42 픽스처 시드 재선정) + qa-match·perceptibility 6/6.
- [x] **AC5** E2E-TDD: PK 스팟 유지 계약 red→green. Evidence: penalty-spot.test.ts(penalty + free_kick no-drift) 수정 전 red(5.8m/22m) → 수정 후 green.
- [x] **AC6** 실화면 확인: 뷰어 PK 중앙 실행 캔버스 캡처 육안(§2.5). Evidence: `pk_freeze.png` Read — taker(9)+공이 페널티 스팟(94,34) 정중앙, 골 중앙·키퍼와 일직선.
- [x] **AC7** 독립 QA PASS (blocker 0). Evidence: independent-qa 별도 컨텍스트 판정 PASS — renderAt 정적 + live rAF(180프레임) 둘 다 공 (94,34) 고정·드리프트 0, 슛 y=34 고정 매끄럽게 골, free_kick(t828) 회귀 없음. Non-blocker 2건(카메라 seek/live 훅 불일치 코스메틱, 트레일선 기존 #8) — QA 에픽 백로그.

**스코프 확장(투명 기록)**: 진단 중 `restartFreeKick`도 동일하게 `targetFx` 누락(demoSeed FK@226 수정 전 22m 드리프트) 발견 → 같은 1줄로 함께 수정. 두 재시작만 `restartSetPiece`(#31 핀)를 안 거쳤음.

### Sub-goals
- SG1: E2E-TDD — penalty spot no-drift 계약을 엔진 테스트로 박제(red).
- SG2: `restartPenalty` 에 `taker.targetFx = spot` 추가(1줄) → green.
- SG3: 골든 스냅샷 갱신(`npm test` 동작 변경 반영) + 결정론 가드.
- SG4: 게이트(vitest·playwright·qa-match·perceptibility) + 실화면 캡처 + 독립 QA.

---

## 3. 진행 로그

| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-13 | 1~3 | 발견·분석·진단 완료. restartPenalty targetFx 누락 확정(코너/스로인 #31 선례 대비). 실데이터 드리프트 (94,34)→(96,37.7) 확인. |
| 2026-07-13 | 4~6 | 문제정의·계획+AC hero 승인. GH 서브이슈 #48 등록. → Phase 7 /sk-goal 진입. |
| 1 | 2026-07-13 | AC1~AC6 [x] | E2E-TDD(penalty+free_kick no-drift red) → contest.ts restartPenalty/restartFreeKick 에 `taker.targetFx = spot` 추가(1줄) → green. 골든 갱신. 게이트 vitest49/npm74/playwright29·desync0·6/6. 실화면 PK 중앙 캡처. free_kick 22m 드리프트도 동반 수정. AC7 독립QA 진행. |
| 2 | 2026-07-13 | AC7 [x] ✅ goal met | 독립 QA PASS(blocker 0). 전체 AC1~AC7 완료. |

---

## 5. Learned

- **가설 정확도**: Phase 3 진단(restartPenalty targetFx 누락)이 100% 정확. 실데이터 트레이스(공 94,34→96,37.7)로 증상 확인 → 형제 함수(restartSetPiece)와 코드 비교로 누락 라인 즉시 특정. 좌표 추론 아닌 데이터+코드 대조가 빨랐다.
- **공유 헬퍼 미경유 사이트 감사**: #31 은 `restartSetPiece`(코너/스로인/골킥)에 `targetFx = spot` 핀을 넣어 고쳤지만, **헬퍼를 안 거치는 `restartPenalty`·`restartFreeKick` 두 곳이 누락**돼 같은 버그가 남아 있었다. → 교훈: 공유 헬퍼에 버그픽스를 넣을 때, **그 헬퍼를 안 쓰는 형제 경로를 전부 감사**해야 한다(중복 로직 = 누락 위험). free_kick 은 이번에 동반 발견·수정.
- **결정론 변경의 픽스처 파급**: 엔진 동작 변경은 골든 스냅샷뿐 아니라 **특정 이벤트 패턴에 의존하는 픽스처 테스트(#42)를 깨뜨린다**(real 픽스처 매치가 바뀌어 '세이브→라이브→빗나감' 패턴 이동). → 교훈: determinism-affecting 변경 시 골든 갱신 + **패턴 의존 픽스처 시드 재선정**을 예상하라. 다중 제약 시드 스캔(offside+card+penalty+체인)으로 해결.
- **다음 단축**: 세트피스 taker 위치 관련 버그는 `restartSetPiece` vs 개별 restart 함수의 `targetFx` 세팅 유무부터 확인.

### Non-blocker (QA 에픽 #25 백로그로)
- 뷰어 `cam()` 훅이 seek 경로(줌인 스팟)와 live play 경로(줌아웃 센터)에서 다른 카메라 상태 반환 — 코스메틱, PK 위치 정확성엔 무관.
