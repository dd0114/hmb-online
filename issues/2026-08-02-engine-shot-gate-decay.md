# 슛 하드 게이트 → 결정단 거리 감쇠(N1) · hold EV 의 1대1 예외(N4)

- **세션**: hmb 엔진 #407 Phase 2-C (`~/spider14/hmb-online`, 브랜치 `engine/e407-n1-n4`)
- **SoT**: 에픽 **#407** (QA 상시 트랙 #25 산하) / 선행 = `research/e407-volume-diversity.md`(Phase 2-B) · `research/e407-volume-recalibration.md`(Phase 2-A) · `research/e407-goal-centrality.md`(요구 ⑨)
- **owned-glob**: `packages/engine/**`
- **엔진 버전**: engine@0.40.0 → **engine@0.41.0**
- **상태**: ⚠️ **기제 2건 착지 · 캘리브레이션 목표(팀당 슛 7.2–8.4) 미달성 — 무엇이 막는지 실측으로 확정**
  - **N4 = 켜서 출하**(설계 목적 달성, 60시드 검증)
  - **N1 = 기제 착지 + 기본 off**(축 B 하드 제약을 만족하는 설정이 **없다**는 것을 27지점 스윕으로 확정)

---

## 1. 한 문단 요약

슛 볼륨을 밴드로 되돌리는 일이 지금까지 막혀 온 이유는 `chain.ts` 의 **거리 하드 게이트**였다 — 볼륨을
내리면 박스 밖 슛이 통째로 사라져 박스 편중이 41%→90~100% 로 튀었다(Phase 2-A 기각). N1 은 그
게이트를 **결정단 감쇠**로 바꿔 그 결합을 실제로 끊는다(같은 볼륨대에서 박스 편중 **100% → 61.7%**).
그런데 게이트를 넓히는 순간 **ST 가 27m 에서 쏘기 시작해** 사슬이 미드필더에게 닿기 전에 끝난다 —
슛 top1 95.3%→**97.3~100%**, 1대1 6.08%→**0~4.3%**. hero 가 축 B(선수 다양성) 악화를 하드 제약으로
걸었으므로 **켤 수 없다.** N4 는 반대로 값싸게 성공했다: hold 를 볼륨 레버로 밀 때(`holdPenalty` −2.0)
1대1 이 **3.33% → 5.33%**(baseline 6.08 의 88%) 로 살아남고, 그 팔은 볼륨(7.66)·축 A(48.3%)·축 B
(HHI 0.868 · top1 93.0)를 **동시에** 만족한다. 남은 유일한 블로커는 **파울 4.67 → 15.87** 이고
그것은 이 웨이브의 AC 밖이다.

---

## 2. 무엇을 바꿨나

### N1 — 슛 후보의 거리 하드 게이트를 결정단 감쇠로 (`packages/engine/src/chain.ts`)

```ts
// before (0.40.0) — GEN_FN.shoot
if (g.distToGoalM > c.contest.shootRange || g.xgHere < c.contest.shootXgThreshold) return;

// after (0.41.0)
const genMaxM = sd.enabled ? sd.genMaxM : c.contest.shootRange;   // 생성 = 넓게(안전 상한만)
if (g.distToGoalM > genMaxM || g.xgHere < c.contest.shootXgThreshold) return;
```

억제는 `candidateEv` 의 shoot 분기에서만:

```ts
const gain = mulFrac(mulFrac(w.goalValueEv, xgFrac), shootDistanceFrac(ctx.config, distM));
let ev = gain + mulFrac(turnoverEv(ctx, here), FRAC_SCALE - xgFrac);
```

- 감쇠 계수 `f(d) = clamp(1 − perM × max(0, d − freeM), floor, 1)`.
- **골 항에만** 곱한다. 턴오버 항은 음수라 같이 곱하면 먼 슛의 EV 가 *덜 나쁜 쪽으로* 올라가
  부호가 뒤집힌 보정이 된다. 골 항만 깎으면 `perM` 이 **항상 같은 방향의 단조 레버**가 된다.
- ⚠️ **`xgAtPoint` 는 한 줄도 안 건드렸다.** Phase 2-A 는 `contest.shootDistanceFactor`(= xG 자체)를
  키워 같은 일을 하려다 슛당 xG 0.117 로 붕괴해 기각당했다. **결과 모델(xG)과 결정 모델(EV)의
  분리**가 이 설계의 전부다. 계약으로 박제(§4-①).
- ⚠️ **`contest.shootRange`·`shootXgThreshold` 는 은퇴하지 않았다.** `shootRange` 는 1대1 부스트 자격
  (`decision.oneOnOneShot`) · weighted 롤백 코어 · 1대1 진단(`realism/one-on-one.ts`)에서 계속 살아 있고,
  `shootXgThreshold` 는 **질 게이트로 생성기에 그대로 남는다**(거리와 다른 축이고 그 사다리가
  `shot-frequency.test.ts` 의 계약이다). 대체한 것은 **거리 컷 한 줄**뿐이다.
- `GENERATORS` 배열 순서 무변경. 노드 예산·성능은 §5.

### N4 — hold EV 의 "확실한 슛(1대1)" 예외 (`chain.ts`)

```ts
const stay = evaluateStateEv(ctx, here) - w.holdPenaltyEv - (ctx.oneOnOne ? w.oneOnOneHoldEv : 0);
```

- `ctx.oneOnOne` 은 **루트에서 이미 부른** `decision.oneOnOneShot` 의 결과다(`oo.detail === "one_on_one"`).
  기하를 재발명하지 않는다 — 정의가 갈라지면 #316 계약과 진단이 어긋난다. hold 후보는 루트에서만
  생성되므로(`INNER_GENERATORS` 가 제외) 가상 도착 지점에서 1v1 을 재는 일이 없다(#316 이 기각한 함정).
- **곱이 아니라 뺄셈**인 이유: 유지 항 `V(here) − holdPenalty` 는 음수가 될 수 있고, 음수에 계수(<1)를
  곱하면 0 쪽으로 **올라간다**. `holdPenalty` 와 같은 자에 놓인 가산 페널티여야 항상 같은 방향이다.
- ⚠️ **사실상 불리언이다.** 1대1 에서 hold 의 우위는 작아서 2.0 만 빼도 결정이 뒤집힌다 —
  2.0 / 6.0 / 20.0 의 20시드 집계가 **완전히 동일**했다. 그래서 dead-knobs 는 "0 으로 바꾸면 달라진다"로
  등록했고, 값을 키우는 튜닝은 의미가 없다.

### 새 노브 (전부 `EngineConfig`, 하드코딩 0)

| 경로 | 출하값 | 역할 |
|---|---|---|
| `chain.shootDistance.enabled` | **false** | 롤백 스위치. false = 0.40.0 하드 게이트 |
| `chain.shootDistance.genMaxM` | 24 | 후보 **생성** 안전 상한(노드 폭주 방지). 레버 아님 |
| `chain.shootDistance.freeM` | 16.5 | 이 거리까지 감쇠 없음 |
| `chain.shootDistance.perM` | 0.16 | **볼륨 레버**(값↑ → 슛↓). 사다리 계약 있음 |
| `chain.shootDistance.floor` | 0.15 | 감쇠 하한 — "먼 슛이 선택지에서 사라지지 않는다"를 지킨다 |
| `chain.hold.oneOnOnePenalty` | **4.0** | 1대1 일 때 hold 유지 항에서 추가 차감. 0 = 예외 없음 |

---

## 3. 캘리브레이션 — 60시드(팀-경기 120) 확정표

프로브 = `research/e407-probe/e407-diversity.ts`(Phase 2-B 와 **같은 자**). 카운트형 밴드는 45분 길이보정치.

| | **0.40.0 rollback** | **0.41.0 출하** | 0.41.0 +`hp−2.0`<br>(N4 시연) | 0.41.0 `N1 on`<br>(권장 출발점) | 밴드/제약 |
|---|---|---|---|---|---|
| **팀당 슛** | 17.27 | **17.48** | **7.66** ✅ | 18.42 | 7.2–8.4 |
| 팀당 골 | 3.23 | 3.22 | 1.59 | 3.39 | (관측) |
| 유효슛 | 6.54 | 6.42 | 3.02 | 6.78 | 2.9–3.5 |
| 슛당 xG | 0.182 | 0.182 | 0.187 | 0.179 | 0.18–0.24 |
| 전환% | 18.9 | 18.7 | 20.3 | 18.7 | 17–22 |
| **축 A 박스 안 슛%** | 41.2 | **41.5** ✅ | 48.3 ✅ | **36.1** ✅ | ≤ 51.2 |
| 슛 거리 p50 (m) | 17.5 | 17.4 | 17.3 | 17.9 | — |
| 와이드 슛% | 0.0 | 0.0 | 0.0 | 0.0 | (N3 소관) |
| **축 B 슛 HHI** | 0.910 | **0.905** ✅ | 0.868 ✅ | **0.960** ✗ | ≤ 0.910 |
| 슛 top1(ST)% | 95.3 | 95.0 ✅ | 93.0 ✅ | 98.0 ✗ | ≤ 95.3 |
| **비ST 슛/tm** | 0.81 | **0.87** ✅ | 0.54 ✗ | **0.37** ✗ | ≥ 0.81 |
| **비ST 박스수신/tm** | 0.54 | **0.71** ✅ | 0.44 ✗ | 0.38 ✗ | ≥ 0.54 |
| 슈터 수/tm | 1.57 | 1.59 | 1.46 | 1.36 | — |
| **1대1%** (#316) | 6.08 | 5.05 | **5.33** | 4.34 | 보존 |
| 패스 성공% | 82.6 | 82.8 ✅ | 81.2 ✅ | 82.3 ✅ | 78–85 |
| 팀 폭 (m) | 46.8 | 46.7 ✅ | 47.6 ✅ | 46.7 ✅ | 40–50 |
| 코너 | 5.96 | 5.89 | 2.98 | 6.03 | 4–6(길이보정 2–3) |
| 스로인 | 10.15 | 10.07 | 8.47 | 10.50 | 8.5–9.5 |
| **파울** | 4.67 ▼ | **4.83** | **15.87** ✗✗ | 4.58 | 5.5–6.0 (base 이미 미달) |
| 주행 (km) | 6.54 | 6.53 | 5.57 | 6.53 | — |

**출하(0.41.0) 판정**: 볼륨 미달(17.48 — 이 웨이브가 못 고친 것)과 **1대1 6.08 → 5.05(−17% 상대 ·
절대 126→106건 · 원인 미규명)** 두 가지를 빼면 **모든 하드 제약을 만족하거나 개선**했다.
축 A 41.2→41.5(중립) · 축 B **세 지표 전부 개선**(HHI 0.910→0.905 · 비ST 슛 0.81→0.87 ·
비ST 박스수신 0.54→0.71) · 파울 4.67→4.83(밴드 쪽으로 이동, 악화 아님) · 그 밖 구조 밴드 전부 유지.

> ⚠️ **1대1 예외(#407 독립 검증 major-1)**: hero AC 원문의 구조 밴드 목록에 **1대1(#316)이 명시**돼
> 있으므로 이 감소는 "밴드 전부 유지"에 포함되지 않는다. N4 가 `hp−2.0` 팔에서 1대1 을 **살린**
> 것(3.33→5.33)과 출하 팔에서 **깎은** 것(6.08→5.05)은 방향이 반대이고, 후자의 기전은 아직
> 규명되지 않았다(N4 는 20시드에서 7.17→7.11 = 중립으로 보였다 — 60시드에서만 드러난다).
> 감시 = 60시드 프로브(§8 재현 커맨드) + `shot-distance-decay.test.ts` 중립 계약의 매-실행 로그.
> 소시드(≤12)로는 이 크기의 이동을 못 잡는다(12시드 실측 5.69→5.77, 부호가 반대 — 노이즈 1 SE
> 안이다). 원인 규명·복구는 **#407 후속(N2 웨이브)** 소관.

### 3-1. N4 의 목적 달성 증거 (60시드 · 짝 대조)

| `chain.holdPenalty` = −2.0 | N4 **off**(`oneOnOnePenalty=0`) | N4 **on**(4.0) |
|---|---|---|
| **1대1%** | **3.33** | **5.33** (+60%, base 6.08 의 88%) |
| 팀당 슛 | 7.50 ✅ | 7.66 ✅ |
| 박스 안 슛% | 49.6 ✅ | 48.3 ✅ |
| 슛 HHI | 0.870 ✅ | 0.868 ✅ |
| 파울 | 16.15 ✗ | 15.87 ✗ |

→ Phase 2-A 안 A 가 죽은 자리(1대1 이 팀-경기 95.8%에서 0건)가 **닫혔다**. hold 축은 이제
볼륨·축 A·축 B 를 동시에 만족하는 **유일한 측정된 팔**이고, 남은 블로커는 파울 하나다.

### 3-2. N1 의 프론티어 — 왜 못 켜나 (20시드 스윕 27지점 중 대표)

**축 A 는 이긴다** — 같은 볼륨대에서 하드 게이트 축보다 박스 편중이 훨씬 낮다:

| 팔 | 팀당 슛 | 박스 안 슛% |
|---|---|---|
| HARD `shootRange` 16 | 13.63 | **91.4** |
| HARD `shootRange` 15.5 | 12.03 | **93.1** |
| HARD `shootRange` 14 | 9.13 | **98.6** |
| DECAY `g24 u.45` | 19.07 | 34.6 |
| DECAY `g24 u.40` | 16.20 | 44.9 |
| **DECAY `g24 u.36`** | **11.75** | **60.2** |

**축 B 는 진다** — 게이트를 넓히면 ST 가 27m 에서 쏘기 시작하고, 그 결과 사슬이 미드필더에게 닿기 전에 끝난다:

| 팔 | 팀당 슛 | 슛 top1% | 슛 HHI | 1대1% | 박스수신/tm |
|---|---|---|---|---|---|
| base(하드 게이트) | 17.43 | 95.8 | 0.920 | 7.17 | 5.58 |
| N1 게이트만 열기(`perM 0`, g34) | 31.20 | **99.0** | 0.981 | **1.20** | 1.23 |
| 가장 부드러운 가장자리(`g24 f16.5 p.16`) | 18.88 | **98.5** | 0.971 | **3.84** | 4.95 |
| `g26 f18 p.20` | 18.77 | 97.6 | 0.953 | 3.20 | 4.25 |
| 볼륨 밴드 근처(`f0 p.05`) | 6.90 | **100.0** | 1.000 | **0.00** | 10.63 |

**그리고 볼륨 밴드에 닿으면 축 A 도 같이 무너진다**(감쇠는 여전히 EV 축이라 §7-2 벽 3 을 완전히
벗어나지는 못한다): `f0 p.04` → 슛 10.85 / 박스 **98.8%** · `uniform .35` → 슛 9.45 / 박스 **62.4%** ·
`g24 u.36` → 슛 11.75 / 박스 60.2%. **볼륨 7.2–8.4 + 박스 ≤51.2 를 동시에 만족하는 감쇠 설정은 없다.**

> **결론**: N1 은 *약속한 것(축 A 와 볼륨의 결합 해제)* 을 실제로 해내지만, 그 대가로 **축 B 를
> 판다**. Phase 2-B §8-2 가 N1 에 붙였던 예상치("슛 7.2–8.4 · 박스슛 30~45% · 밴드 유지",
> 명시적으로 **미측정**)는 **실측으로 반증됐다**. 이 노브를 켜는 것은 **N2(조건부 박스 도착런,
> 규모 M)와 같은 웨이브**여야 한다 — 축 B 를 실제로 여는 유일한 측정된 기제가 그것이기 때문이다.

### 3-3. 시도했으나 못 쓴 조합 (기록)

- `hp −0.25 ~ −1.5` + 감쇠: 감쇠가 축 B 를 죽여 top1 100%·1대1 0~1% (파울도 6.1~8.2 로 밴드 초과).
- `hp −0.5` 단독: 슛 13.53 · 박스 40.3 · HHI 0.908 — 좋지만 볼륨 미달이고 파울 7.67(밴드 초과).
- `hp −0.25` 단독: 슛 15.43 · 박스 45.4 · HHI 0.910 · 1대1 6.48 · **파울 6.15**(밴드 5.5–6.0 바로 위).
  → **hold 축의 실제 한계는 파울이다**(Phase 2-B §6-3 ⑤ 재확인).

---

## 4. 계약 (테스트로 박제한 것)

**신규** `packages/engine/src/realism/shot-distance-decay.test.ts` (9 계약, 소시드 ≤12):

1. **생성 게이트가 감쇠로 바뀌었다** — 하드 게이트에서 `shootRange` 밖 슛 **정확히 0** / 감쇠를 켜면 **>0**.
   ⚠️ 이벤트 거리는 생성 게이트가 본 거리보다 최대 `contest.controlRange`(5.0m) 크다 — 소유 중 공이
   발밑이 아니라 **접촉점**에 놓이기 때문(#407 ④). 실측 최댓값 23.66m = 19 + 4.7. 계약은 이 슬랙을
   **명시적으로** 더해 센다.
2. **`genMaxM` 안에서만 생성된다** — 상한이 배선돼 있다는 증명(오타면 조용히 무제한 생성 + 노드 예산 이동).
3. **`xgAtPoint` bit-identical** — 감쇠 노브를 극단으로 돌려도 같은 지점의 xG·distM 이 한 비트도 안 바뀐다.
   (Phase 2-A 의 기각 사유를 코드로 못 하게 막는 줄.)
4. **감쇠는 단조 볼륨 레버** — floor .45→.36 에서 팀당 슛 감소.
5. **회귀 가드(이 웨이브의 존재 이유)** — 같은 볼륨대에서 **감쇠 축의 박스 편중이 하드 게이트 축보다
   20%p 이상 낮다**(측정: 하드 sr14 100.0% @8.63 vs 감쇠 61.7% @11.75). 절대치가 아니라 **두 축의 차이**를
   박았다 — 절대치는 다른 노브 재보정에 딸려 움직이지만 이 부등식은 기제의 성질이다.
6. **N4 — `holdPenalty` 를 볼륨 레버로 밀어도 1대1 이 살아남는다**(12시드: off 2.78% → on 6.28%, 임계 1.5배).
7. **N4 는 출하 기본에서 중립** — 슛 Δ<1.0 · 박스 편중 Δ<5%p. **+ `oneOnOnePct` 를 같이 본다**
   (독립 검증 major-1 수습): 짝 대조 1대1 을 **매 실행 로그로 뱉고**, base 대비 상대 −25% 하한을
   단언한다. ⚠️ 이 하한은 **밴드 재판정이 아니라 붕괴(−50%, 2-A 안 A 가 죽은 방식) 바닥 가드**다 —
   12시드에서 60시드의 −17% 는 재현되지 않는다(실측 5.69→5.77, 이항 SE ±19% 안). 근거·한계는
   테스트 파일 주석에 정량으로 박아 뒀다.
8. **롤백** — `shootDistance.enabled=false` + `hold.oneOnOnePenalty=0` → **0.40.0 해시와 bit-identical**
   (`f9d9d778 · 756ec350 · f7031974 · e5b0e30b`).

**레지스트리** `dead-knobs.test.ts`:
- LIVE: `chain.shootDistance.enabled` · `chain.hold.oneOnOnePenalty`(0 으로만 잰다 — §2 의 포화 때문).
- **조건부 LIVE**(신규 describe): `genMaxM`·`freeM`·`perM`·`floor` 4종 — 스위치를 켜야 레버이고,
  출하 기본(off)에서는 넷 다 비트 동일임을 **같이** 박제했다(오프사이드 트랩·1대1 계열과 같은 처방).
- 노브 경로 스냅샷 갱신(+6 경로).

**사다리** `shot-frequency.test.ts`(HMB_LADDER): `chain.shootDistance.perM` 0.05→0.03→0.02 엄격 단조 추가.
판정식(비율 1.35 · 절대 `SPAN_FLOOR`)은 **한 자리도 안 건드렸다**. `gate.ts` 의 `LADDER_SUITES` 설명 갱신.

---

## 5. 성능 / 노드 예산 (브리프 요구)

출하 기본은 `enabled:false` 라 **생성 후보 수·노드 수·시뮬 시간이 0.40.0 과 동일**하다(롤백 해시가
bit-identical 인 것이 그 증명이다). 감쇠를 켰을 때의 비용은 60시드 프로브 실행 시간으로 관측했다:
`0.40.0 rollback` 11s · `0.41.0 출하` 10s · `N1 on(g24)` 10s — **측정 가능한 차이 없음**(genMaxM 24 는
`shootRange` 19 대비 후보를 결정당 최대 1개 늘릴 뿐이고, `chain.search.maxNodes` 512 는 실측 결정당
평균 70 노드에 대해 여전히 **비구속**이다). `chain-search.test.ts` 의 beamClipped/recurseClipped/budgetHit
= 0 계약도 전량 green.

---

## 6. 게이트 결과 (콜드 재실행)

| 게이트 | 결과 |
|---|---|
| `npm run typecheck` | ✅ pass |
| `npm test` (T1, 콜드) | **2885 passed / 6 failed / 67 skipped** (총 2958) — 6건 **전부 선행 실패**(§6-1) |
| `npm run test:ladder` | **360 passed / 7 failed** — 6건은 위와 동일 + `shootXgThreshold` 사다리 1건(선행, §6-1) |
| `npm run e2e` (playwright) | ✅ **74/74** |
| `node tools/qa-match.mjs` | ✅ 상황-데이터 정합성 문제 없음 (engine@0.41.0-showcase) |
| `node tools/perceptibility.mjs` | ✅ **6/6** |
| 결정론 | ✅ desync 0 × 80 · resume 동일 · hygiene grep 0 (T1 안에 포함, 전량 green) |
| 골든 갱신 | 스냅샷 6 + 해시 상수 6곳(§6-2) |

> **수치 정정 이력(독립 검증 minor-1·minor-3)**
> - 최초 기록은 `npm test` **7 failed / 2897 passed** 였으나 **오기**다. 7번째
>   (`shootXgThreshold` 사다리)는 **`HMB_LADDER=1` 에서만** 도는데 §6-1 "선행 실패" 표에서
>   `npm test` 행으로 이월됐다. 검증자 콜드 재실행 = **6 failed / 2898 passed / 54 skipped**(2958).
> - 그 뒤 **미추적 프로브 2건**(`e407-deadball-probe` · `e407-offside-probe`, 13 tests)에
>   `HMB_E407DEADBALL`·`HMB_E407OFFSIDE` **env 가드**를 부여했다(minor-3 수습). 그래서 지금 트리의
>   콜드 값은 **6 failed / 2885 passed / 67 skipped** — 총수 2958 과 실패 6 은 그대로이고
>   passed 13 이 skipped 로 옮겨간 것이 전부다(2898−13=2885 · 54+13=67). 같은 이유로 ladder 도
>   콜드 재실행 **7 failed / 360 passed / 51 skipped**(418, 239.5s) — 373−13=360 · 실패 집합 불변.

### 6-1. 선행 실패 7건 — **전부 main(0.40.0)에서 이미 red**

⚠️ 이 7건은 **`npm test` 6건 + ladder 전용 1건**(`shootXgThreshold`)의 합이다 — `npm test`
한 판에서 7건이 나는 것이 아니다(위 정정 이력).

`chain.hold.oneOnOnePenalty=0`(= 0.40.0 bit-identical)으로 되돌려 같은 파일을 돌려 귀속을 확정했다:

| 실패 | 0.40.0 | 0.41.0 | 판정 |
|---|---|---|---|
| `shot-frequency` 팀당 슛 ≤8.4 | 17.27 | 17.48 | 선행(이 에픽의 과제 그 자체) |
| `shot-frequency` 경기당 골 ≤3.7 | 6.46 | 6.43 | 선행 |
| `shot-frequency` 팀당 골 ≤1.85 | 3.23 | 3.22 | 선행 |
| `shot-frequency` 유효슛 ≤3.5 | 6.54 | 6.43 | 선행 |
| `ball-physics` 무소유 급정지 ≤25 | **27.0** | **26.9** | 선행 (미세 개선) |
| `foul-opportunity` 파울 ≥5.8 | **4.67** | **4.83** | 선행 (밴드 쪽으로 이동) |
| `shootXgThreshold` 사다리 비율 >1.35 | **1.20** | 1.19 | 선행 |

즉 **이 웨이브가 새로 깬 게이트는 0건**이고, 선행 red 4건은 오히려 소폭 개선됐다.

### 6-2. 갱신한 골든 (전부 "롤백 스위치 **밖**의 전역 변경" — 기존 재기록 관례 그대로 주석 추가)

- 해시 상수: `vision.test.ts`(ROLLBACK_HASH만 — MARKED 는 **안 움직였다**) · `def-line.test.ts` L5 ·
  `rest-defence.test.ts` R6 · `hold-pressure.test.ts` GOLDEN(3개 중 **2개만** 이동) ·
  `press-unit.test.ts` A7 · `offside-trap.test.ts` T5(0.39.0 상수는 이력으로 **남기고** 0.41.0 상수 신설).
  움직인 시드가 전부가 아니라 **일부**인 것이 N4 의 사거리가 좁다는(1대1 이 실제로 난 매치에서만 발화)
  직접 증거다 — 8시드 중 shipping 4/8 · trap-on 5/8.
- 스냅샷 `-u`: `mark-jitter` · `movement-synchrony` · `def-line`(L3 관측 기록) · `offside-trap`(T3/T4 3건) ·
  `dead-knobs`(노브 경로).
- `evidence/S1/*.log` = 엔진 웨이브마다 재생성되는 증적(관례대로 포함).

### 6-3. 조건부 계약 1건의 조건을 넓혔다 (약화 아님)

`dead-knobs.test.ts` 의 `movement.restDefence.playerOverrideWeight` 조건부 LIVE 시나리오(CB 2명만
`forwardRunFreq` 0.95)가 0.41.0 궤적에서 **3시드 중 한 번도 순위를 안 뒤집는다**. 가중치를 3→20 으로
키워도 전부 bit-identical 이므로 "가중치가 작아서"가 아니라 **비교가 애초에 안 갈리는** 상태다.
수비 4명 전원 0.99 로 넓히면 다시 발화한다 → **판정 기준은 그대로 두고 조건만** 넓혔다(주석에 근거 명시).

---

## 7. 잔여 리스크 / 다음 웨이브 블로커

1. **볼륨 밴드(7.2–8.4)는 여전히 미달**(17.48). 이 웨이브가 만든 것은 *레버 두 개*지 캘리브레이션이 아니다.
   → 다음 웨이브의 본체는 **N2(조건부 박스 도착런, 규모 M)** 이고, 그 위에서만 N1 을 켤 수 있다.
2. **hold 축의 유일한 블로커 = 파울**(hp−2.0 에서 15.87 vs base 4.67, 밴드 5.5–6.0). hero AC 는 "파울을
   더 악화시키지 않는 것"까지였으므로 출하는 그 축을 안 썼다. **파울 기제(`rules.foul.base` 로 되돌리면
   축 B 개선분이 통째로 사라진다 — Phase 2-B §6-3 ⑤)를 분리하는 것이 다음 웨이브의 선결 조건**이다.
3. **와이드 슛은 여전히 0.0%.** N1 이 거리 게이트를 풀어도 남는 구속은 `shootXgThreshold` × `shootAngleFactor`
   기하다(횡오프셋 20.4m 에서 xG ≥0.07 이려면 골에서 ~23m 안이어야 하고, 와이드 선수는 거기까지 공을
   갖고 가지 않는다 — 캐리 방향이 골 중앙 1개뿐이라서). **N3 는 B3(캐리 방향 후보화)·B1(크로스) 없이는
   실효가 0** 이라는 Phase 2-B 의 판단이 실측으로 재확인됐다.
4. **`shot-frequency`·`foul-opportunity`·`ball-physics` 3개 파일이 main 에서 이미 red** — 밸런스 회귀
   게이트가 성립하지 않는 상태가 이어진다(#25 에 기록된 교차 발견 그대로). 밴드 재도출/소관 배정은
   이 웨이브 밖(#10 / #377 / #189).
5. **이슈 레이즈 필요(#57 원칙)**: `apps/web/e2e/fixtures/p388-half1.json` 이 **engine@0.34.0** 로 굳어
   있다(엔진 6개 버전 드리프트). 엔진 테스트를 돌리면 재생성되지만 owned-glob 밖이라 **되돌려 두었다**.
   web 모듈이 재생성 정책(생성물을 커밋할지 gitignore 할지)을 정해야 한다.

---

## 8. 재현 커맨드

```bash
cd ~/spider14/hmb-online && git checkout engine/e407-n1-n4

npm run typecheck && npm test && npm run test:ladder && npm run e2e
node tools/qa-match.mjs && node tools/perceptibility.mjs

# 60시드 확정표(§3)
HMB_SEEDS=60 HMB_COMBOS='[
 {"label":"0.40.0 rollback","ov":{"chain.hold.oneOnOnePenalty":0}},
 {"label":"0.41.0 SHIPPED","ov":{}},
 {"label":"0.41.0 +hp-2.0","ov":{"chain.holdPenalty":-2.0}},
 {"label":"0.41.0 N1 on","ov":{"chain.shootDistance.enabled":true}}
]' node tools/run-gate.mjs --label e407 -- npx tsx research/e407-probe/e407-diversity.ts

# 분석 전용 프로브(전부 env 가드 — 없으면 `npm test` 에서 skip, 독립 검증 minor-3)
HMB_E407GOAL=1     node tools/run-gate.mjs --label e407-goal     -- npx vitest run packages/engine/src/realism/e407-goal-probe.test.ts
HMB_E407DEADBALL=1 node tools/run-gate.mjs --label e407-deadball -- npx vitest run packages/engine/src/realism/e407-deadball-probe.test.ts
HMB_E407OFFSIDE=1  node tools/run-gate.mjs --label e407-offside  -- npx vitest run packages/engine/src/realism/e407-offside-probe.test.ts

# N1 프론티어 재현(§3-2) — floor 를 균일 계수로 쓰는 팔
HMB_SEEDS=20 HMB_COMBOS='[
 {"label":"HARD sr14","ov":{"contest.shootRange":14}},
 {"label":"DECAY g24 u.36","ov":{"chain.shootDistance.enabled":true,"chain.shootDistance.genMaxM":24,
   "chain.shootDistance.freeM":0,"chain.shootDistance.perM":10,"chain.shootDistance.floor":0.36}}
]' node tools/run-gate.mjs --label e407 -- npx tsx research/e407-probe/e407-diversity.ts
```

---

## 독립 검증 (별도 컨텍스트 module-verifier · 2026-08-02)

> 위 §1~§8 은 **구현자 서술**이고, 이 절은 **분리된 컨텍스트의 검증자**가 적대적으로 재검증한
> 결과다(자기검수 금지 원칙, 루트 CLAUDE.md §2-2). 검증자는 리포 파일을 못 고치는 역할이라
> 이 절의 **기록과 수습은 구현 세션이 대행**했다(수습 목록 = 아래 §V-8).

**판정 = PASS** · **blocker 0 · major 2 · minor 5**.

### V-1. 최우선 감사 3건 — 전부 무혐의

"볼륨 미달을 게이트에서 숨기려 한 흔적"을 먼저 팠고, 셋 다 아니었다.

| 감사 대상 | 확인 방법 | 결과 |
|---|---|---|
| `shot-frequency.test.ts` 밴드 완화? | `git diff 80e25a8..07163c6` | **38줄 순수 추가 · 삭제 0**. 밴드 상수(7.2/8.4 · 2.8/3.7 · 1.4/1.85 · 2.9/3.5 · 0.18/0.24 · 17/22) · `SPAN_FLOOR` · 비율 1.35 **불변**. 밴드는 여전히 **red**(17.48 > 8.4) |
| `gate.ts` 로 red 은닉? | 레지스트리 diff | `LADDER_SUITES[0].what/issue` **설명 문자열 2줄**뿐. 등록 스위트 3개 유지 · **은닉 0**. 신설 `shot-distance-decay.test.ts` 는 게이트 레지스트리를 안 쓰므로 **항상 돈다** |
| `one-on-one.ts` 표본 정의 변조? | 파일 diff | **주석 전용**. 표본 정의 코드 **무변경** |

### V-2. 절대 제약 3건 — PASS

- **`xgAtPoint` 무수정** — diff 빈 값. 그 위에 계약이 실제로 문다는 것도 변이체 M3 로 확인(아래).
- **봉인 노브 2종 의미 보존** — `decision.ts:137` · `decision.ts:753` · `one-on-one.ts:180` 무변경
  (`shootRange` = 1대1 자격 · weighted 롤백 코어 · 진단 / `shootXgThreshold` = 생성기 질 게이트).
- **`GENERATORS` 배열 무변경** — diff 빈 값(생성기 순서 = 결정론 표면).

### V-3. N1 off 정합성 — PASS

**base 워크트리에서 4시드 최종 스냅샷 해시를 독립 재계산**했고
`["f9d9d778","756ec350","f7031974","e5b0e30b"]` 가 계약의 `GOLDEN_040` 과 **완전 일치**했다
(구현자가 상수를 손으로 적어 넣은 것이 아니라는 증거).
`dead-knobs` 등록도 정직하다 — `enabled` = LIVE + 하위 4종(`genMaxM`·`freeM`·`perM`·`floor`) =
"조건부 LIVE"이고, **출하 기본(off)에서 넷 다 비트 동일**이라는 사실을 *같이* 박제했다.
어느 쪽도 숨기지 않는다.

### V-4. 변이체 킬 4/4 — 계약이 실제로 문다

| 변이체 | 주입 | 결과 |
|---|---|---|
| M1 | 감쇠를 no-op 로 | **FAIL 2건**(단조 레버 · 박스 편중 가드) ✅ |
| M2 | `ctx.oneOnOne = false` 고정 | **N4 계약 FAIL** ✅ |
| M3 | `xgAtPoint` 에 감쇠 주입 | **xG bit-identical 계약 FAIL** ✅ |
| M4/M5 | 구 `cbForward` 복원 | 3시드 **해시 동일** — 구현자 §6-3 주장(비교가 애초에 안 갈린다)이 **참** ✅ |

### V-5. 선행 red 독립 대조 — 신규 red 0건

**별도 worktree 에 base 를 체크아웃**해 대조했다(공유 트리 미교란 · `git stash` 금지 규율 준수).
실패 집합이 **정확히 일치**하고 신규 0건. base→head 로 4건은 오히려 **개선**됐다:

| 지표 | base(0.40.0) | head(0.41.0) |
|---|---|---|
| 경기당 골 | 6.45 | **6.43** |
| 팀당 골 | 3.23 | **3.22** |
| 유효슛 | 6.54 | **6.43** |
| 무소유 급정지 | 27.0 | **26.875** |
| 파울 | 4.675 | **4.833**(밴드 쪽) |

### V-6. 게이트 콜드 재실행 (검증자 실행)

| 게이트 | 검증자 실측 |
|---|---|
| `npm run typecheck` | ✅ |
| `npm test` | **6 failed / 2898 passed** (207.6s) |
| `npm run test:ladder` | 7 failed / 373 passed (225.7s) |
| `npm run e2e` | ✅ **74/74** |
| `node tools/qa-match.mjs` | ✅ |
| `node tools/perceptibility.mjs` | ✅ **6/6** |
| 결정론 | ✅ desync 0 × 80 · resume 동일 · hygiene green |

> (수습 후 이 트리의 콜드 값 = **6 failed / 2885 passed / 67 skipped** — 프로브 env 가드로
> passed 13 이 skipped 로 옮겨간 것뿐, 총수 2958 과 실패 6 은 동일. §6 정정 이력 참조.)
>
> ⚠️ 구현자 §6 표의 `npm test` 행이 **7 failed / 2897** 이었던 것은 오기다(minor-1) — 7번째
> (`shootXgThreshold` 사다리)는 **`HMB_LADDER=1` 에서만** 도는데 "선행 실패 7건" 표에서 `npm test`
> 행으로 이월됐다. `test:ladder` 행(7 failed / 373)은 정확하다. §6 은 수습에서 정정했다.

또한 **§3 의 60시드 표는 전 셀이 소수점까지 재현 일치**했고, **골든 갱신 6곳은 전부 정당**하다
(구 값을 주석에 남기고 동반 단언이 생존 · 8시드 중 **4~5개만** 이동 = N4 사거리가 좁다는 직접 증거).

### V-7. 경계 — PASS

코드 변경은 전부 `packages/engine/**`(owned-glob) 안. `packages/shared/**` **무변경**.
검증자 흔적 0(검증용 worktree·변이체는 전부 되돌림).

### V-8. major 2 · minor 5 와 수습 결과

| # | 등급 | 내용 | 수습 |
|---|---|---|---|
| major-1 | major | **출하 config 1대1 6.08 → 5.05**(−17% 상대 · 126→106건). AC 원문의 구조 밴드 목록에 1대1(#316)이 **명시**돼 있는데 §3 판정문이 "볼륨 미달을 빼면 전부 만족"으로 뭉갰다. 게다가 중립 계약(`shot-distance-decay.test.ts`)이 `shots`·`inBoxPct` 만 재서 **정작 움직인 지표를 안 본다** | ✅ 수습 — §3 판정문에 예외 명시 · CLAUDE.md 0.41.0 행에 병기 · `config.ts` 주석을 20시드(7.17→7.11) → **60시드(6.08→5.05)** 로 갱신 · 중립 계약에 `oneOnOnePct` **로그 + 상대 −25% 바닥 가드** 추가(한계는 정량 주석으로 박제) |
| major-2 | major | **볼륨 밴드 7.2–8.4 미달**(17.48) — 이 웨이브의 원 목표 | ⛔ **수습 대상 아님**(매니저 스코프 판정): 이 웨이브 = **레버 신설**, 볼륨 달성은 **N2 웨이브로 이월**. 노트 §7-1 에 이미 명시 |
| minor-1 | minor | §6 `npm test` 수치 오기(7/2897 → **6/2898**) | ✅ 정정(콜드 재실행으로 직접 확인) |
| minor-2 | minor | `shot-distance-decay.test.ts` 의 소시드(≤12) 규율상 60시드급 이동을 못 잡는다 | ✅ 한계를 테스트 주석·노트 §4-7 에 **정량으로** 기록(SE 계산 포함) |
| minor-3 | minor | 미추적 프로브 2건(`e407-deadball-probe` · `e407-offside-probe`)에 **env 가드가 없어** `npm test` 에 다시드 시뮬이 딸려간다 | ✅ `HMB_E407DEADBALL` · `HMB_E407OFFSIDE` 가드 부여(=`HMB_E407GOAL` 관용구) + 재현 커맨드 헤더 주석 + 커밋에 포함 |
| minor-4 | minor | `config.ts` 주석의 20시드 근거가 60시드로 갱신되지 않음 | ✅ 갱신(20시드 값은 이력으로 남김) |
| minor-5 | minor | `shot-distance-decay.test.ts` 의 `harsh.shots < hardGate.shots * 2` 여유가 얇다(실측 1.36배) | ✅ **관측 기록만** — 같은 describe 의 단조성 단언이 엄격 킬러라 이중 방어 성립(결함 아님). 주석으로 박제 |
