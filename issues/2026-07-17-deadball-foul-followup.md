# 파울/데드볼 연출 follow-up — CAUSE 정지 커버 + 정비 속도 + 파울 접촉

- **GH 이슈**: #56 (에픽 #25 하위, #54 흡수)
- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 · **owned-glob**: `packages/engine/**`
- **통합**: #52 독립 QA FAIL(파울 미커버·과속) + #54(파울 접촉 표시)를 하나로. #54 흡수.
- **상태**: Phase 3 진단 (분석 완료, hero gate 전)

---

## 1. 문제정의  <!-- Phase 4 hero gate -->

- **현상**: (A) **파울→프리킥**(및 save/off_target/offside/penalty) 정지에서 선수들이 얼어붙고 재개 시 순간이동(#52 가 커버 못 함 — hero "파울도 마찬가지" 미충족, 독립 QA blocker). (B) 코너/스로인 정지-재생 정비가 **너무 빠름**(18~24m/s). (C) 파울이 접촉 없이 보임(실은 0.51m 접촉, 뷰어가 피해자 스팟 이동 후 표시 → 접촉 은폐).
- **근본 원인**: (A) 정지-재생/워크인 트리거 조건이 `st.setPiece || st.pauseOnly` 뿐 → `foul` 등 **CAUSE 스토피지 제외**(playback.mjs buildStoppages CAUSE 분기). (B) `freezeSpanEndIdx`(10~14 game-tick)를 `hold.dur`(650~1250ms)에 그대로 압축 → 겉보기 과속. (C) `commitFoul`→`restartPenalty`가 같은 틱에 피해자를 스팟 이동, 접촉 프레임(0.51m)이 스냅샷에 없음.
- **영향 범위**: 뷰어(A·B) + (C)는 엔진 reposition 1틱 지연 여부(결정론 골든) 판단 필요. 엔진 파울 판정 자체는 정확(계측 확인).

### Phase 2 — 분석 (사실)
- (A) index.html 정지-재생/워크인 조건 = `st.setPiece || st.pauseOnly`(#52). `foul`/`save`/`shot_off_target`/`offside`/`penalty` 는 buildStoppages CAUSE 맵(isGoal:false, setPiece/pauseOnly 아님) → 미발동. 독립 QA 실측: 파울@828 정지 1.1s 전원 정지 + 재개 시 32m 순간이동.
- (B) 독립 QA 실측 겉보기 속도: corner_148 24.5m/s, throw_231 24.1m/s 등(볼트 12m/s의 2배). 프레임간은 ≤0.23m(순간이동 아님). 원인 = 정지 tick수(10~14)를 hold.dur 고정 실시간에 압축.
- (C) tackD 계측: 전 파울 0.18~1.52m 접촉(t163=0.51m). tackleRange 2.0m. restartPenalty 같은 틱 스팟 이동 → 스냅샷은 그 후 → 접촉 은폐. 접촉 프레임 데이터 부재.

### Phase 3 — 진단 (root cause + 방향)
- (A) **CAUSE 정지 커버**: 정지-재생/워크인을 비-goal 데드볼 스토피지 전반으로 확장(파울→프리킥/페널티 taker 워크인 + 선수 정비 재생).
- (B) **정비 속도 현실화**: freezeSpan 을 hold.dur 에 압축하지 말고, (i) 재생 tick 상한(걷기 거리에 맞게) 또는 (ii) hold.dur 를 정지 tick 수 비례로 확대. 겉보기 ≤ ~7m/s(달리기) 목표.
- (C) **파울 접촉**: 접촉 프레임이 없어 순수 뷰어론 근사만 가능. (E) 엔진이 피해자 reposition 1틱 지연 → 접촉 프레임 확보(결정론 골든) 가 가장 정직. (V) 뷰어가 파울 틱에 피해자를 태클러 근처로 잠깐 렌더. (수용) 파울 정당하니 코스메틱. → hero 방향 선택.

---

## 2. 계획 (뷰어 전용, 결정론 무관)

### 방향
- **(A) CAUSE 정지 커버**: 정지-재생/워크인을 `st.setPiece || st.pauseOnly` 에서 **비-goal 데드볼 정지 전반**으로 확장. 단 정지-재생은 "공이 스팟 유지(freezeSpan)"가 있어야 의미 → foul→free_kick/penalty, save→코너 등 taker/공이 스팟에 놓이는 CAUSE 정지에 적용. 워크인은 그 taker(restart 소유자)에.
- **(B) 정비 속도 현실화**: freezeSpan 을 hold.dur 에 압축하지 않음. **정지 재생 tick 상한(walkable)** — 겉보기 ≤ ~7m/s 되도록 재생 tick 수를 제한(예: 최근 N tick만) 또는 hold.dur 확대. taker 워크인도 걷기 속도.
- **(C) 파울 접촉(뷰어 근사, 엔진 무관)**: foul→penalty/free_kick 의 taker(피해자) 워크인 **시작점을 태클러 근처(접촉점)로** → "접촉 → 스팟 이동" 이 보임. (엔진 reposition 지연(E)은 미채택 — 결정론 골든 회피. hero 가 E 원하면 전환.)

### E2E Goal
뷰어 재생에서 파울→프리킥/페널티에서도 선수 정비가 걷기 속도로 자연스럽게 재생되고 taker 가 (파울은 접촉점에서) 걸어오며, 코너/스로인 정비 속도가 사람 범위(≤~7m/s)로 보인다.

### Acceptance Criteria
- [x] **AC1** 파울→프리킥/페널티(CAUSE 정지)에서 정지-재생 발동(선수 정비 이동 렌더, 정적 홀드 아님). Evidence: 조건 `st.setPiece||st.pauseOnly||foul/penalty/offside` 로 확장(index.html). 실측 파울@828: 정지 중 cur().tick 진행 O + 비-taker 이동 O.
- [x] **AC2** CAUSE 정지 재개 시 순간이동 없음. Evidence: 파울@828 정지 구간 선수 최대점프 측정 — 재개 순간이동 해소(이전 QA 32m → 정지-재생으로 연속).
- [x] **AC3** 정비/워크인 속도 현실화. Evidence: **워크인 시작점 스팟에서 최대 12m 클램프**(index.html — 코너 taker 는 직전 위치가 원거리 포메이션 리셋 컷 30m+ 이라 그대로면 질주, QA iter2 지적). 실측: 코너 148/765/978/1314 taker 스팟최대거리 ≤10.2m·속도 5.0m/s(이전 10~24m/s), 페널티 3.1·스로인 5.2m/s. (644 는 직후 골 배너겹침 cruise 오염 = 별건 백로그.)
- [x] **AC4** 파울 taker 워크인이 태클러 접촉점에서 시작(접촉 표시). Evidence: 페널티@163 taker H9 시작(96,38=태클러 A2 근처)→스팟(94,34) 4.1m 워크인 실측. 파울→프리킥은 taker가 접촉=프리킥스팟(0.6m)이라 접촉 자체 표시.
- [x] **AC5** 회귀 0: #47/#49/#51/#52(코너·스로인)·#26·기계지표 유지. Evidence: `npx playwright test` **34 green** + `npx vitest run packages/engine` **57 green**. (server 5실패는 별 트랙 #32 의존성 누락, 무관.)
- [x] **AC6** 결정론/엔진 불변(뷰어 전용). Evidence: `git diff packages/engine/src` **비어있음** — #56 변경 = index.html 만.
- [x] **AC7** 실화면 + 독립 QA PASS (blocker 0). Evidence: 2회차 재판정 **PASS** — 코너 5건 전부 5.0m/s(origDist 24~31m→12m 클램프/2.4s, 결정론+프레임 교차검증), 파울@828/938·페널티@163 freeze-play+접촉 워크인 회귀 없음, 스로인 라이브 아웃 유지. Non-blocker(별건): save→corner 배너전환 시 단일프레임 8.37m 컷(기존 재배치틱 컷 설계) → 백로그 후보.

### Sub-goals
- SG1: E2E-TDD — 파울 정지-재생/워크인/속도/접촉점 계약 박제.
- SG2: 정지-재생/워크인 조건을 CAUSE 정지로 확장(freezeSpan 있는 경우).
- SG3: 속도 현실화(재생 tick 상한 or hold.dur 비례) + 파울 워크인 접촉점 시작.
- SG4: 회귀 게이트 + 실화면 + 독립 QA.

---

## 3. 진행 로그

| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-17 | 1~3 | #52 QA FAIL(파울 미커버·과속) + #54(접촉) 통합 분석. (A)CAUSE 제외 (B)압축 과속 (C)접촉 프레임 부재 확정. |
| 2026-07-17 | 4~6 | 문제정의·계획+AC hero 승인(C=뷰어 접촉점 워크인). GH #56(#54 흡수) → Phase 7. |
| 1 | 2026-07-17 | AC1·2·5·6 [x] | 정지-재생/워크인 조건을 파울/페널티/오프사이드(CAUSE)로 확장 + 속도 완화(hold.dur 걷기비례)+파울 접촉점 워크인 코드 추가. 파울@828 재개 순간이동 0m. 회귀 0(playwright34·engine57). AC3속도검증·AC4워크인정제(파울 taker 0m)·AC7 남음. |
| 2 | 2026-07-17 | AC3·4 [x] | 파울 프리킥 taker=접촉(0.6m, 워크 불요 정상), 페널티 taker H9 접촉(96,38)→스팟(94,34) 4.1m 3.1m/s 워크인 확인. 속도 순이동 기준 3~5m/s. e2e 파울 정지-재생 계약 추가(playwright35). AC7 독립QA 진행. |
| 3 | 2026-07-17 | AC7 QA FAIL → 코너 속도 재수정 | 독립 QA: blocker(파울 freeze/순간이동) 해결·접촉 워크인 정상 확인, 단 코너 속도 8~24m/s 재현(paceDur 3s캡이 거리 무한비례). 수정: 워크인 시작점 스팟서 최대 12m 클램프 → 코너 4/5 실측 5.0m/s·≤10.2m. 게이트 playwright35·engine57. AC7 재QA. |
| 4 | 2026-07-17 | AC7 [x] ✅ goal met | 독립 QA 재판정(2회차) PASS(blocker 0). 코너 5건 5.0m/s, 파울/PK/스로인 회귀 없음. 전체 AC1~AC7 완료. |

---

## 5. Learned

- **독립 QA 반복의 값**: #52 가 파울(CAUSE 경로)을 놓쳤고, 이번 QA 1회차가 코너 과속을 잡았다. 자기 e2e/실측은 계속 green 이었지만 독립 QA(실산출물 재생)가 blocker 를 2번 잡아 clean PASS 를 막았다. §2.2 실증.
- **hero "다 고쳐놔"의 함정**: "파울도 마찬가지"를 setPiece/pauseOnly 조건으로만 처리하고 CAUSE 분기(파울/페널티/오프사이드)를 놓쳤다. → 데드볼 전반 처리는 buildStoppages 의 **모든 분기(CAUSE/SETPIECE/PAUSE_BEAT)** 를 커버 목록으로 명시하고 각각 검증할 것.
- **속도 캡의 함정**: `paceDur = min(CAP, walkDist/SPEED*1000)` 은 walkDist 가 크면 CAP 에 눌려 **speed cap 이 아니라 duration cap** 이 된다. → 속도를 보장하려면 CAP 을 늘리거나(긴 freeze) **워크 거리를 클램프**(시작점 당기기)해야 한다. 코너 taker 의 "직전 위치"는 포메이션 리셋 컷(원거리)이라 실제 워크 origin 이 아님 — 거리 클램프가 정답.
- **다음 단축**: 데드볼 연출 작업은 전 stoppage 타입(코너/스로인/골킥/프리킥/파울/페널티/오프사이드/save/off_target) 표로 커버·속도·워크인·순서를 한 번에 검증.
