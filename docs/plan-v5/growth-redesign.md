# 성장·보상 개편 설계 (에픽 #405 — 요구 3·10·2)

> **게이트 1 산출물 — hero 컨펌 대상.** 처음 보는 사람 기준 풀맥락으로 씀.
> 세션 = hmb:growth · 브랜치 `growth/405-w0` · 기준 커밋 `80e25a8`(origin/main)
> 마이그레이션 번호 **V38**(main 배정 완료) · 열차 순서 E3 → E4 → **E2 성장** → E1/E5

---

## 0. 세 줄 요약

1. **이미 성장 시스템이 있다**(V10 "메이플 성장"). 요구 10은 신규 기능이 아니라 **기존 모델의 교체**다 — 스탯별 XP 자동 상승을 걷어내고 카드 레벨 + 3지선다로 바꾼다.
2. **성장 여백이 사실상 0인 게 근본 원인**이다. 원인이 둘(초기 스탯이 밴드 상단에 붙어 있음 + 1★ 천장이 밴드 폭의 25%뿐)이라 요구 3 하나만 고쳐선 안 풀린다.
3. 라이브 규모가 작아(**유저 189 · 완료 경기 66 · 성 승급 이력 1건**) 이관 부담이 거의 없다 — 무손실 백필보다 **하향 + 소급 지급**이 게임적으로 낫다.

---

## 1. W0 현황 분석 — 지금 어떻게 돼 있나

### 1.1 기존 성장 스키마 (전부 확인된 사실)

| 마이그레이션 | 내용 | 현재 상태 |
|---|---|---|
| `V9__growth.sql` | `user_players` +6컬럼(`enhance_level`·`limit_break`·`match_xp`·`growth_level`·`growth_vec_json`·`copies_used`) + `growth_applied`(정산 멱등) | **모델 폐기**. `copies_used` 만 살아 있음(`GrowthService.java:565`) |
| `V10__maple_growth.sql` | `user_players` +`stat_levels_json`·`star`(1~4) · `card_potentials` · `user_dice` · `dice_rolls` | **현행 모델** |
| `V12__growth_report_snapshot.sql` | `growth_applied.report_json` = `{statXp, levelUps, ovrBefore, ovrAfter}` | 사용 중 |
| `V25__dice_purchase_removed.sql` | `user_dice` 잔량 소각(`dice_burned`), 테이블은 미드롭 | 다이스는 즉시결제로 전환(#247) |

V13~V37 에서 성장 계열 테이블을 ALTER 한 마이그레이션은 **0건**.

### 1.2 현행 유효스탯 계산 (`GrowthService.compute`, `GrowthService.java:233-285`)

```
band          = GRADE_BAND[grade]                       // Java 하드코딩 :59-65
cap_i         = base_i + starFrac[star] × (band.hi − base_i)
pre_i         = clamp(base_i + lv_i, band.lo, cap_i)     // lv = 스탯별 자동 레벨
eff_i         = (pre_i + Σ잠재flat) × (1 + Σ잠재pct/100)  // 잠재는 상한 클램프 없음
ovr           = Σ eff_i × baselineByPosition[pos][i]
```

- `base_i` = `players.attributes_json` (불변 원본). **`user_players` 는 스탯을 자체 보관하지 않는다** — `players` 를 매번 참조한다(`V1__init.sql:41-47`, `GrowthService.java:290-292`).
- 스탯 XP 는 **경기 이벤트에서 자동 산출·자동 레벨업**된다(`GrowthService.settleMatch:877-919`):
  `xp_i = xpBase × (포지션baseline_i + Σ eventStatMap[ev]_i × 횟수) × minutesMult × gradeXpMult[grade]`
- 정산 진입점은 **하나**다 — `MatchOrchestrator.finishMatch:738-806`. 리그·원정도 전부 여기를 탄다. 성장 훅은 `settleGrowth(match)`(:789), FINISHED CAS 통과 이후, try/catch 격리.

### 1.3 계수의 현재 위치 (⚠️ 무배포 관련 핵심)

| 값 | 지금 어디 |
|---|---|
| 등급 밴드(40-55…80-95) | **Java 하드코딩** `GrowthService.java:59-65` **+ data `generate.ts:294-300` 이중 복제** |
| xpBase·xpLv*·gradeXpMult·minutesMult·baselineByPosition·eventStatMap | `economy.growth`(`data/players/economy.v3.json`) |
| copies·starFrac | `economy.star` |
| 잠재 테이블·다이스 비용 | `economy.potential` · `economy.dice` |

`server-java/CLAUDE.md` 가 명시: **"gacha 확률·rewards·growth 등 나머지 economy 블록은 API 가 없다 — 볼륨 손편집 + 리로드만 가능"**. 즉 **성장 계수는 지금 무배포 튜닝이 안 된다.** 밴드는 코드 하드코딩이라 아예 배포가 필요하다.

### 1.4 근본 원인 — 왜 "성장 맛"이 없나 (실측)

`players.v2.4.json` 실측(node 계산, 182행):

| 등급 | 밴드 | 9종 평균 | 밴드 상한까지 여백 | **1★ 실제 성장 여백** |
|---|---|---|---|---|
| BRONZE | 40–55 | 49.57 | 5.4 | **1.4** |
| SILVER | 50–65 | 59.45 | 5.6 | **1.4** |
| GOLD | 60–75 | 69.36 | 5.6 | **1.4** |
| DIA | 70–85 | 79.52 | 5.5 | **1.4** |
| LEGEND | 80–95 | 89.88 | 5.1 | **1.3** |

원인이 **둘**이다:
- **(a) 초기 스탯이 밴드 상단에 붙어 있다.** 밴드 중앙(예 GOLD 67.5)이 아니라 69.4 — 포지션 주스탯 +5 · trait +6 바이어스가 상한에 클램프되기 때문(주스탯∩trait 스탯의 **79.4%가 밴드 상한에 박혀 있다**).
- **(b) 1★ 천장이 밴드 폭의 25%뿐이다**(`starFrac[1]=0.25`). 승급 없이는 밴드 여백의 1/4밖에 못 쓴다.

→ **요구 3(초기 하향)만으로는 부족하고, star 와 성장 천장의 결합도 같이 끊어야 "승급 없이도 성장 가능"이 성립한다.**

### 1.5 라이브 현황 (백업본 `pre-enginetrain2-20260801T124259Z.db` read-only 조회)

| 지표 | 값 |
|---|---|
| 유저 | 189 |
| `user_players` 행 | 3,103 (보유자 189명) |
| **완료된 경기** | **66** |
| `stat_levels_json` 이 있는 카드 | 451 |
| 그 451장의 **총 레벨 합** | p50 **1** · p90 15 · p99 43 · max **59** |
| 단일 스탯 최대 레벨 | 13 |
| **성 승급 이력(star>1)** | **1건** (star=4 는 0건) |
| **잠재(다이스) 이력** | **1건** |

**해석: 기존 성장 시스템은 사실상 안 쓰이고 있다.** 이관에서 지킬 자산이 거의 없다.

---

## 2. 신규 설계

### 2.1 모델 전환 한 장

| | 현행 (V10) | 신규 (V38) |
|---|---|---|
| XP 단위 | **스탯별** 9개 XP 풀 | **카드 1개** XP 풀 |
| 상승 방식 | 스탯별 자동 레벨업 → 자동 +1 | 카드 레벨업 → **3지선다에서 유저가 선택** |
| 상승폭 | 항상 +1 (정수) | **현재 스탯값에 따라 감쇠**(소수) |
| 성장 천장 | `base + starFrac[star]×(hi−base)` — 1★ = 25% | **`band.hi + starCeilBonus[star]`** — 승급 없이 밴드 전체 |
| star 역할 | 천장 게이트 + 잠재 해금 | **잠재 해금 + 소폭 천장 보너스**(천장 게이트 해제) |
| 후보 결정 | — | 포지션 + 그 경기 활약 + **AI behavior(프롬프트의 구조화 결과)** 가중 추첨 |
| 계수 튜닝 | economy 파일 손편집(API 없음) · 밴드는 코드 하드코딩 | **DB 리비전 오버레이 + admin API**(#383 준용) · 밴드도 계수화 |

### 2.2 초기 스탯 하향 + **천장 겹침** (요구 3) — **밴드 재설정** ✅hero 확정

**원칙 두 개.**
1. **시작 밴드를 내린다** — 성장 여백을 만든다.
2. **성장 천장을 등급 간에 겹친다** — 하위 등급일수록 여백을 크게 준다. 안 겹치면(천장 55/65/75/85/95) **하위 선수를 키울 이유가 없다**(hero 지적). 겹쳐야 "다 키운 브론즈가 방치된 골드보다 세다"가 성립한다.

| 등급 | 현행 시작 | **신규 시작** | **성장 천장** | 여백 | 시작 중앙 |
|---|---|---|---|---|---|
| BRONZE | 40–55 | **32–42** | **72** | **35** | 37 |
| SILVER | 50–65 | **41–51** | **78** | **32** | 46 |
| GOLD | 60–75 | **50–60** | **84** | **29** | 55 |
| DIA | 70–85 | **59–69** | **90** | **26** | 64 |
| LEGEND | 80–95 | **68–78** | **95** | **22** | 73 |

- **시작 격차 9 / 천장 격차 6** — 위로 갈수록 좁아진다. 등급 = "얼마나 빨리 쓸 수 있나"(시작값), 육성 = "어디까지 갈 수 있나"(천장). 등급이 즉시 전력을 주고, 저등급은 시간을 들이면 따라잡는다.
- **하위 등급을 키울 이유** (만렙·포지션 핵심 4스탯 집중 기준):

| 만렙 | 도달값 | 이기는 상대 |
|---|---|---|
| BRONZE | 57.0 | **미성장 GOLD(55) — 2단계 위** |
| SILVER | 65.0 | **미성장 DIA(64) — 2단계 위** |
| GOLD | 73.0 | 미성장 DIA(64) — 1단계 위 |
| DIA | 80.8 | 미성장 LEGEND(73) — 1단계 위 |
| LEGEND | 88.1 | — |

- **특화(몰빵) 저등급**: BRONZE 한 스탯을 천장까지 밀면 **70.3** = 오늘의 GOLD 평균(69.4) 수준. "브론즈 전문 스트라이커"가 실제로 성립한다. 대신 나머지 스탯은 37 근처라 종합력은 낮다.
- **만렙끼리의 순서는 여전히 등급순**(57 < 65 < 73 < 80.8 < 88.1) — 뽑기 가치는 보존된다.
- 바이어스(+5/+6)는 그대로 두되 **새 시작밴드 상한에 클램프** → 주스탯은 여전히 튀지만 성장 천장과는 분리된다.

⚠️ **트레이드오프 — 엔진 밸런스**: 엔진 공식 다수가 `(x−50)/50` 을 중립점으로 쓴다(`decision.ts`). 신규 BRONZE/SILVER 팀은 37~46 이라 **오늘보다 확실히 서툴게 플레이한다**(패스 실패↑ 등). 유저·봇이 같은 카탈로그를 쓰므로 상대 밸런스는 유지되지만, 리얼리즘 지표(슛·골·패스성공)는 움직일 수 있다.
→ **구현 웨이브의 게이트로 엔진 다시드 밸런스 스윕을 넣는다**(신규 밴드 로스터로 20~60시드, `research/engine-realism-gap.md` 밴드 대조). 이탈하면 밴드를 −8 안(아래 옵션 B)으로 완화한다.

**옵션 B(보수안, 하향폭 −8)**: BRONZE 36–46 / SILVER 45–55 / GOLD 54–64 / DIA 63–73 / LEGEND 72–82. 여백 14~18로 줄지만 엔진 리스크가 작다.

### 2.3 감쇠 곡선 (레벨업 1회당 상승폭)

```
r_i    = clamp((v_i − bandLo) / (ceiling_i − bandLo), 0, 1)      // v = 현재 pre-잠재 스탯
gain_i = max(gainMin, gainMax × (1 − r_i)^decayPow)
pre_i  = min(base_i + add_i, ceiling_i)                          // 하드 클램프
```

**계수: `gainMax = 4.0` · `decayPow = 1.4` · `gainMin = 0.3`** (전부 config)

- **레벨은 상승폭에 안 들어간다** — hero 방침 그대로. 상승폭은 오직 *그 스탯이 얼마나 높은가*로 결정된다. (레벨 페널티 노브 `levelPenaltyPerLv` 를 두되 **기본 0**.)
- 상승폭 실제 값(GOLD, 시작 55 · 천장 84, 한 스탯을 계속 찍을 때):
  `1픽 +3.20 → 58.2` · `2픽 +2.72 → 60.9` · `5픽 +1.74 → 67.0` · `10픽 +0.93 → 73.0` · `20픽 +0.35 → 78.4` · `40픽 천장 84.0`
- **몰빵 비효율**(GOLD, 만렙 40픽 총 상승 합계):

| 분산 | 총 상승 | 스탯당 | 효율비 |
|---|---|---|---|
| 1스탯 몰빵 | +29.0 | +29.0 | **29%** |
| 3스탯 | +61.2 | +20.4 | 62% |
| 5스탯 | +80.1 | +16.0 | 81% |
| 9스탯 균등 | +99.2 | +11.0 | 100% |

→ 몰빵의 총 효율은 균등 분산의 **29%**. 의도대로 "한 스탯 몰빵은 비효율" — 다만 천장이 높아져(84) 몰빵으로 **한 스탯을 오늘의 상위 등급 수준까지** 밀 수 있다는 보상이 생겼다(§2.2 특화 저등급).
- **천장에 닿은 스탯은 후보에서 제외**한다(+0 을 뽑는 죽은 선택지 방지).

### 2.4 경험치 곡선 (판수) ✅hero 확정 — 만렙 40

```
matchXp = xpMatchBase × minutesMult × resultMult × gradeXpMult × (1 + perfBonus)
xpToNext(level) = round(xpLvBase × level^xpLvPow)
```

| 계수 | 값 | 비고 |
|---|---|---|
| `xpMatchBase` | 100 | |
| `minutesMult` | starter 1.0 / partial 0.5 / bench 0 | 현행 재사용 |
| `resultMult` | WIN 1.2 · DRAW 1.0 · LOSS 0.85 | 신규 |
| `gradeXpMult` | BRONZE 1.3 · SILVER 1.2 · GOLD 1.0 · DIA 0.85 · LEGEND 0.7 | **현행(0.4~3.0)을 뒤집는다** — 지금은 레전드가 3배 빨리 컸다 |
| `perfBonus` | 0 ~ 0.5 (이벤트 기반, 상한 캡) | 신규 |
| `xpLvBase` / `xpLvPow` | 100 / **0.5** | |
| `maxLevel` | 40 | |

**소요 판수(선발·무승부·GOLD 기준):**

| 도달 | L2 | L4 | L6 | L11 | L16 | L21 | L31 | L40 |
|---|---|---|---|---|---|---|---|---|
| 누적 경기 | **1** | 4 | 8 | 22 | 40 | 62 | 112 | **165** |

등급 배수 반영 만렙: BRONZE 132 · SILVER 143 · GOLD 172 · DIA 202 · **LEGEND 245경기**.
첫 레벨업은 **1경기 이내**(레전드 1.4경기) — "경기 끝나고 렙업 → 찍는 재미"가 즉시 성립한다.

**만렙 도달 시 스탯값 (§2.2 천장 반영):**

| 등급 | 신규 시작 | **4스탯 집중** | 6스탯 | 9스탯 균등 | 몰빵 1스탯 | *현행 평균* | 천장 |
|---|---|---|---|---|---|---|---|
| BRONZE | 37 | **57.0** | 53.2 | 49.9 | 70.3 | *49.6* | 72 |
| SILVER | 46 | **65.0** | 61.6 | 58.5 | 77.4 | *59.5* | 78 |
| GOLD | 55 | **73.0** | 69.8 | 67.0 | 84.0 | *69.4* | 84 |
| DIA | 64 | **80.8** | 78.0 | 75.4 | 90.0 | *79.5* | 90 |
| LEGEND | 73 | **88.1** | 85.8 | 83.6 | 95.0 | *89.9* | 95 |

- **9스탯 균등 만렙 ≈ 오늘의 카드**(BRONZE 49.9/49.6 · SILVER 58.5/59.5 · GOLD 67.0/69.4) — 골고루 키우면 오늘 수준으로 되돌아온다.
- **4스탯 집중 만렙 > 오늘의 카드**(GOLD 73.0 vs 69.4) — 특화하면 오늘을 넘는다. 이게 "육성의 보상"이자 §2.2 의 2단계 역전을 만드는 값이다.
- 그 경로가 165~245경기짜리 여정이 된다.

### 2.5 3지선다 후보 결정 (요구 10)

레벨업 시점에 9스탯 중 **3개를 가중 비복원 추첨**한다.

```
w_i = wBase
    + wPosition × baselineByPosition[pos][i]        // 맡은 포지션
    + wEvents   × eventScore_i                       // 그 경기에서 실제로 한 일
    + wBehavior × behaviorScore_i                    // 그 경기에서 맡은 역할(= 프롬프트)
    + wResult   × (WIN ? resultTilt_i : 0)
seed = sha256(matchId + userId + playerId + ":" + level)      // 결정론
```

**핵심 설계 판단 — 프롬프트를 키워드 매칭하지 않는다.**
프롬프트는 AI 가 이미 `PlayerBehavior` 9개 파라미터(0..1)로 변환해 놓았고, 그 값이 `match_halves.home_input_json / away_input_json` 에 하프별로 박제돼 있다(`V1__init.sql:131-142`). 이걸 쓰면
① "맡은 역할에 따라 성장 스탯이 다르다"는 컨셉이 **문자열이 아니라 실제 시뮬 입력**으로 성립하고
② 한국어/영어/오타/장난 프롬프트에 안 흔들리며
③ 결정론이 유지된다.

`behaviorStatMap`(config, 기본값):

| behavior | → 스탯(가중) |
|---|---|
| `shootTendency` | shooting .6 / positioning .2 |
| `passRisk`, `passDirectness` | passing .5 / technical .3 |
| `dribbleTendency` | technical .5 / pace .3 |
| `pressAggression` | tackling .5 / stamina .3 |
| `forwardRunFreq` | pace .4 / stamina .3 / positioning .2 |
| `widthTendency` | pace .4 / stamina .3 |
| `supportDepth` | positioning .4 / mental .3 |
| `positioningFreedom` | mental .4 / positioning .3 |

`eventScore_i` 는 현행 `eventStatMap` 을 그대로 재사용하되 **죽은 키 `dribble` 을 정리**하고(`MatchEventType` 에 없음) `clearance`·`foul`·`card`·`save` 를 추가한다.

**가중치 기본값**: `wBase 1.0 · wPosition 2.5 · wEvents 2.0 · wBehavior 2.0 · wResult 0.5` (전부 config).
→ 어떤 스탯도 확률 0 이 아니고(`wBase`), 역할·활약이 뚜렷하면 그쪽이 확실히 잘 나온다.

**후보 박제 (hero 명시 요구)**
레벨업 순간 `growth_level_choices` 행을 만들고 `candidates_json` 에 **스탯 3개 + 각각의 상승폭(gain)까지** 박제한다.
- 선택을 미뤄도 선택지가 안 바뀐다 ✔
- 상승폭도 박제하는 이유: 미루는 동안 다른 픽으로 스탯이 오르면 gain 이 달라져 "화면에 +2.9 라고 써 있었는데 +2.1 이 들어왔다"가 된다.
- 한 경기에 여러 레벨업이 나면 레벨마다 별도 행(시드에 level 포함).

### 2.6 star(승급)의 새 역할

```
ceiling_i = growCeil[grade] + starCeilBonus[star]    // growCeil = §2.2 천장 72/78/84/90/95
                                                     // starCeilBonus = {1:0, 2:+1, 3:+2, 4:+3}
```
- **승급 없이(1★) 성장 천장까지 전부 성장 가능** — 요구 충족.
- 승급은 ① 잠재(potential) 티어 해금(현행 그대로) ② **소폭 추가 천장**으로 가치를 유지.
- 전역 하드 상한 `attrHardCap = 99`(잠재 포함 최종 클램프). 지금은 잠재에 상한 클램프가 없어 100 초과가 가능한 **선존 결함**이라 이참에 막는다.

### 2.7 라이브 이관 전략 ✅hero 확정 — "하향 + 소급 지급"

**결론: 하향을 적용하고, 그동안 쌓인 성장을 신규 시스템의 선택권으로 소급 지급한다(안 C).**

검토한 3안:

| 안 | 내용 | 라이브 영향 | 판정 |
|---|---|---|---|
| A 무손실 백필 | 하향분 Δ 를 `add` 로 백필 → 유효스탯 무변동 | 손실 0. 그러나 라이브 유저는 **감쇠 때문에 앞으로 gain ≈ 0.3** — 성장의 재미를 영원히 못 느낀다 | ✕ |
| B 리셋 + 재화 보상 | 전 카드 신규 밴드로, 재화로 사과 | 공평하나 66경기치 성장이 그냥 사라짐 | △ |
| **C 하향 + 소급 지급** | 신규 밴드 적용 + **기존 스탯레벨 합 = 신규 선택 대기 수**로 환산 지급 | 신규 시스템을 즉시 체험, 리스펙 기회까지 제공 | **✔ 권장** |

- 실제 부담: 소급 대상 **451장**, 지급될 선택권 p50 **1개** · p90 15개 · max 59개(→ `maxLevel−1` 로 클램프).
- 소급된 선택권의 후보는 매치 컨텍스트가 없으므로 **포지션 baseline + 그 카드에 쌓여 있던 스탯 XP 분포**로 가중한다(그 카드가 실제로 한 일의 이력이라 정합적).
- `star`(승급 이력 1건)·`card_potentials`(1건)는 **무변경 승계**.

**구현 순서 (⚠️ `players` 부팅 임포트가 기존 행을 덮어쓴다 — `PlayerCatalogService.java:131-146`)**
1. **DB 백업**(`infra/` 백업 경로, `docs/deploy-log.md` 기록) ← 필수
2. `V38` 이 **하향 전 `players.attributes_json` 을 `growth_legacy_base` 로 스냅샷** + 신규 컬럼 추가
3. 새 `players.v2.5.json` 발행(신규 시작 밴드) — data 모듈, append-only 규칙 준수, 소비 경로 **2곳**(`application.yml` + `Dockerfile` `HMB_DATA_PLAYERSFILE`) 동시 스위치
4. 부팅 임포트 후 `GrowthLegacyBackfillService` 가 멱등 1회 실행 — 스냅샷과 대조해 소급 선택권 생성, 완료 플래그 박제
5. 롤백 = 백업 복원 + 구 `players.v2.4.json` 경로 복귀

### 2.8 무배포 계수 — **하드 AC** (hero AC 승격 2026-08-02)

> **AC-G0: 이 개편이 새로 만드는 계수 중 admin API 로 조정 불가한 것이 0개여야 한다.**
> 하드코딩 잔존 = module-verifier FAIL. 엔진 dead-knobs 레지스트리처럼 **계수 전수 목록을 코드에 두고, 그 목록의 모든 항목이 실제로 오버레이되는지 계약 테스트로 박는다.**

#### 2.8.1 계수 전수 레지스트리 (`GrowthTuning` — #412 승계 인터페이스)

`GrowthTuning` 이 성장 계수의 **유일한 SoT**다. 아래가 전수 목록이며, 레지스트리(`GrowthTuning.KNOBS`)가 이 경로들을 열거한다.

| # | 경로 | 타입 | 기본값 | 무엇 |
|---|---|---|---|---|
| 1 | `bands.<GRADE>.startLo` | int | 32/41/50/59/68 | 시작 밴드 하한 (§2.2) |
| 2 | `bands.<GRADE>.startHi` | int | 42/51/60/69/78 | 시작 밴드 상한 |
| 3 | `bands.<GRADE>.growCeil` | int | 72/78/84/90/95 | **성장 천장** |
| 4 | `bands.primaryBias` | int | 5 | 포지션 주스탯 가산 |
| 5 | `bands.traitBias` | int | 6 | trait 가산 |
| 6 | `attrHardCap` | int | 99 | 잠재 포함 최종 상한 |
| 7 | `decay.gainMax` | double | 4.0 | 감쇠 최대 상승폭 |
| 8 | `decay.decayPow` | double | 1.4 | 감쇠 지수 |
| 9 | `decay.gainMin` | double | 0.3 | 감쇠 하한 |
| 10 | `decay.levelPenaltyPerLv` | double | **0** | 레벨당 상승폭 페널티(hero 방침: 기본 0) |
| 11 | `xp.matchBase` | int | 100 | 경기당 기본 XP |
| 12 | `xp.minutesMult.{starter,partial,bench}` | double | 1.0/0.5/0 | 출전 배율 |
| 13 | `xp.resultMult.{WIN,DRAW,LOSS}` | double | 1.2/1.0/0.85 | 결과 배율 |
| 14 | `xp.gradeMult.<GRADE>` | double | 1.3/1.2/1.0/0.85/0.7 | 등급 배율 |
| 15 | `xp.perfBonusCap` | double | 0.5 | 활약 보너스 상한 |
| 16 | `xp.perfEventWeight.<eventType>` | double | (표) | 활약 보너스 이벤트 가중 |
| 17 | `xp.lvBase` | int | 100 | `xpToNext` 계수 |
| 18 | `xp.lvPow` | double | 0.5 | `xpToNext` 지수 |
| 19 | `xp.maxLevel` | int | 40 | 만렙 |
| 20 | `candidate.count` | int | 3 | 후보 개수(3지선다) |
| 21 | `candidate.wBase` | double | 1.0 | 균등 바닥 가중 |
| 22 | `candidate.wPosition` | double | 2.5 | 포지션 가중 |
| 23 | `candidate.wEvents` | double | 2.0 | 그 경기 활약 가중 |
| 24 | `candidate.wBehavior` | double | 2.0 | AI behavior(프롬프트) 가중 |
| 25 | `candidate.wResult` | double | 0.5 | 승패 가중 |
| 26 | `candidate.behaviorStatMap.<behavior>.<stat>` | double | (표 §2.5) | behavior→스탯 매핑 |
| 27 | `candidate.eventStatMap.<eventType>.<stat>` | double | (표) | 이벤트→스탯 매핑 |
| 28 | `candidate.excludeAtCeiling` | bool | true | 천장 도달 스탯 후보 제외 |
| 29 | `positionBaseline.<POS>.<stat>` | double | (현행 승계) | 포지션 baseline(OVR·후보 공용) |
| 30 | `star.ceilBonus.<star>` | int | 0/1/2/3 | 승급 천장 보너스 |
| 31 | `star.copies.<star>` | int | 2/3/5 | 승급 필요 중복(현행 승계) |
| 32 | `legacy.levelGrantCap` | int | 39 | 소급 지급 선택권 상한 (§2.7) |

⚠️ **현행 하드코딩 2곳을 반드시 없앤다** — `GrowthService.java:59-65`(`GRADE_BAND`) 와 `data/players/generate.ts:294-300`(`GRADE_BANDS`). data 쪽은 **발행 시점 롤 전용**으로만 남기고(발행물은 이미 구운 값이라 성질상 배포 필요), **런타임 SoT 는 `GrowthTuning.bands`** 로 단일화한다.

#### 2.8.2 계약 테스트 (AC-G0 집행)

1. `GrowthTuningRegistryTest.everyKnobIsOverridable` — `KNOBS` 의 **모든 경로**에 대해 오버레이를 넣고 `effective()` 가 실제로 바뀌는지 확인. 한 경로라도 안 바뀌면 FAIL.
2. `GrowthTuningRegistryTest.noKnobEscapesRegistry` — `GrowthTuning` 레코드의 리플렉션 필드 트리를 훑어 `KNOBS` 에 없는 잎 노드가 있으면 FAIL(**새 계수를 추가하고 레지스트리에 안 넣는 것**을 막는다).
3. `GrowthHardcodeGuardTest` — `GrowthService` · 정산 · 후보 생성 경로의 소스에 숫자 리터럴 화이트리스트 밖 상수가 없는지 grep 계약(엔진 hygiene 게이트 방식).
4. **변이체 킬**: 오버레이로 `decay.gainMax` 를 0 으로 만들면 레벨업 상승폭이 실제로 0 이 되고, `xp.maxLevel` 을 1 로 만들면 레벨업이 안 나는지 — "API 가 200 을 주는데 반영은 안 됨"을 잡는다.

#### 2.8.3 오버레이 인프라 (V37 동형)

**전 계수를 `GrowthTuning` 하나로 모으고, V37 패턴의 DB 리비전 오버레이를 얹는다.**

- 신규 테이블 `growth_config_revisions`(V38) — `seq AUTOINCREMENT` append-only · `overrides_json` **전체 스냅샷**(델타 아님) · `reason` 필수 · `idem_key` 부분 유니크 + `request_hash` 409 · 성공·실패 **양쪽** `admin_ops_audit` 기록. (전부 V37 `engine_config_overrides.sql` 과 동형)
- 유효값 = `economy.growth`(발행물 기본) **⊕** 최신 리비전(경로 단위 병합). 빈 리비전 = 기본값 복귀.
- API: `GET/PUT /api/admin/growth-config` · `GET /api/admin/growth-config/history` · `POST /api/admin/growth-config/validate`
- 검증은 **서버 내부**(경로 화이트리스트 + 타입 + 범위). #383 은 러너에 위임했지만 성장 계수는 서버가 소비하므로 위임할 대상이 없다.
- **밴드 표도 계수로 옮긴다** — 지금 `GrowthService.java:59-65` 와 `generate.ts:294-300` 에 **이중 하드코딩**돼 있어 배포 없이는 못 만진다. 서버 측 SoT 를 `GrowthTuning.bands` 로 단일화한다(data 는 발행 시점 롤 전용).
- 매치 pin 은 **하지 않는다**(정산 시점 값 사용). 대신 정산에 쓴 `revisionId` 를 `growth_applied.report_json` 에 박제해 사후 추적을 보장한다.

**무배포로 되는 것 / 안 되는 것 (과장 금지)**
- 되는 것: **§2.8.1 전수 목록 32항 전부** — XP 곡선·감쇠·후보 가중치·등급 배수·star 천장 보너스·**시작 밴드·성장 천장**(→ 이미 발행된 카드의 성장 천장과 유효스탯 클램프가 즉시 바뀜)
- **안 되는 것: 이미 발행된 카드의 `base` 스탯 원본값** — 그건 `players.v2.x.json` 발행물이라 배포가 필요하다. (이 갭을 메우는 것이 후속 에픽 **#412** 의 스코프다 — 어드민 선수 등록·기본 스탯 API. 이 에픽은 스코프를 늘리지 않고 §2.8.1 레지스트리와 오버레이 API 형태를 **승계 인터페이스**로 남긴다.)

### 2.9 요구 2 — 보상 탭 구조 (확장 가능한 공용 구조)

hero 요구: *"앞으로 모든 보상이 이 탭 구조를 쓴다."* → 매치 전용이 아니라 **보상 봉투(RewardBundle)** 를 공용 계약으로 만든다. E5(데일리 미션)·리그·우편이 그대로 재사용한다.

```
RewardBundle {
  bundleId, source: "MATCH"|"MISSION"|"LEAGUE"|"MAIL", sourceRef, acknowledgedAt,
  sections: [
    { kind:"CURRENCY", entries:[{ code, amount }] },
    { kind:"GROWTH",   entries:[{ playerId, name, position, grade,
                                  xpGained, levelBefore, levelAfter,
                                  pendingChoices:[{ choiceId, level,
                                                    candidates:[{ stat, gain }] }] }] },
    { kind:"ITEM",     entries:[…] }        // 미래 확장 자리
  ]
}
POST /api/rewards/{bundleId}/ack
POST /api/growth/choices/{choiceId}   { stat }
```

**화면 흐름**: 경기 종료 → **보상 오버레이**(탭: 재화 / 성장) → `[확인]` → 결과 화면.
- 성장 탭 = **11명 한 페이지 + 스크롤**(선발 11 + 투입된 교체). 행마다 XP 바 · 레벨업 뱃지 · "선택 대기" 표시.
- 선택은 **여기서 바로** 하거나 **미루고 나중에 선수 강화탭에서**. 미룬 것은 홈/선수탭에 뱃지로 남는다.
- 기존 `ResultPanel` 의 성장 리포트 섹션(`GrowthReportSection`)은 이 구조로 대체된다.

⚠️ 웹 제약(이미 확인): 금액은 **반드시 `<Amount code=… />`**(재화 하드코딩 금지 e2e 계약) · 스테이지 셸은 **문서 스크롤 0**(스크롤은 패널 내부에만, `svh` 사용) · 카드 아트 노출은 **DIA 이상**(`icon-policy`, 화면에서 등급 비교 금지).

#### 2.9.1 소유 경계 — 다른 에픽이 이 탭에 섹션을 얹는 법 (#408 질의 회신)

**셸은 #405 소유, 섹션 내부는 각 기능 소유.** 레지스트리 방식으로 간다.

```ts
// apps/web/src/rewards/registry.ts   ← #405 소유
export type RewardSectionDef = {
  kind: string;                     // "CURRENCY" | "GROWTH" | "MISSION" | …
  order: number;                    // 탭/섹션 정렬
  title: string;
  isPresent: (bundle: RewardBundle) => boolean;   // 없으면 섹션 자체를 안 그린다
  render: (ctx: { bundle: RewardBundle; matchId?: string }) => ReactNode;
};
export const REWARD_SECTIONS: RewardSectionDef[] = [ … ];
```

- **#405 가 소유**: `rewards/RewardSheet.tsx`(셸·탭 순서·스크롤·[확인] 진행·ack 호출) · `rewards/registry.ts` · `match/stage/ResultPanel.tsx` · `match/stage/StageShell.tsx` · `match/stage/stage-state.ts` · `match/GrowthReportSection.tsx`(대체) · `rewards/sections/CurrencySection.tsx` · `rewards/sections/GrowthSection.tsx`
- **다른 에픽이 소유**: 자기 섹션 컴포넌트 파일 하나(예 `#408 → rewards/sections/MissionRewardSection.tsx`)와 그 하위. 셸·registry 배열은 건드리지 않는다 — **등록 한 줄은 #405 가 넣는다**(머지 순서 충돌 최소화).
- **서버 계약**: `GET /api/matches/{id}/result` 에 **additive 블록**(#368 선례). 구 클라는 무시하면 그만이라 배포 순서 결합이 없다. 각 기능은 자기 `sections[]` 엔트리만 추가한다.
- **머지 순서: #405 먼저.** 셸이 없으면 섹션이 붙을 자리가 없다.
- ⚠️ **Flyway: V38 = #405(growth).** #408 은 V39+ 를 쓴다(main 배정).

### 2.10 강화탭 UX

기존 `CardGrowthDetail`(모달, 725줄, 진입점 2개 = 선수탭·덱편성)에 얹는다. 새 탭을 만들지 않는다.
- 헤더에 **레벨 + XP 바** 추가(★ 4칸 옆).
- **선택 대기 N** 이 있으면 최상단에 3장 후보 카드 → 하나 탭하면 즉시 반영 + 축하 연출(`CelebrationOverlay` 재사용).
- 능력치 막대에 `base | 성장분(add) | 천장` 3층 마커(현행 `base/cap/현재` 마커 확장).
- 경기 중에는 기존대로 잠금(`MatchLockService`, `growth.choice` 액션 추가 — 후반 스탯만 오르는 버그 차단).

---

## 3. 인터페이스 공유 (다른 에픽)

- **E1 선수 정보 탭(#403)**: `card_level`·`card_xp`·`xpToNext`·`pendingChoices` 를 `GET /api/growth/card/{playerId}` 응답에 additive 로 추가 → 스키마 확정 시 #403 에 코멘트.
- **E5 데일리 미션**: §2.9 `RewardBundle` 을 `source:"MISSION"` 으로 재사용 → 구조 확정 시 E5 에 코멘트.
- **파일 경계(apps/web 공유)**: 이 에픽이 소유 = `match/stage/ResultPanel.tsx` · `match/GrowthReportSection.tsx`(대체) · 신규 `rewards/**` · `codex/CardGrowthDetail.tsx`(레벨/선택 영역). E1 과 `CardGrowthDetail` 이 최대 충돌 지점 → main 에 머지 순서 배정 요청.

---

## 4. 결정 기록 (hero, 2026-08-02) ✅

| # | 항목 | **확정** | 기각한 대안 |
|---|---|---|---|
| Q1 | 시작 밴드 + 성장 천장 | **시작 32–42…68–78 / 천장 72·78·84·90·95 ("중" 겹침)** — 만렙 저등급이 **2단계 위 미성장**을 이긴다 | "약"(1단계만 — hero: *"하위 선수 키울 이유가 없다"*) · "강"(몰빵이 상위 만렙을 이김 — 뽑기 가치 훼손) |
| Q2 | 만렙 | **40** (GOLD 172경기 · LEGEND 245경기, 첫 렙업 1경기 이내) | 30(2단계 역전이 깨짐) · 60(후반 픽이 천장에 걸려 무의미) |
| Q3 | 라이브 이관 | **하향 + 소급 지급** — 451장, 기존 스탯레벨 합 = 선택권. star·잠재 무변경 승계 | 무손실 백필(기존 유저만 성장 정지) · 리셋+재화 |
| Q4 | star 의 성장 역할 | **천장 게이트 해제 + `star.ceilBonus{0,1,2,3}`** — 승급 없이도 천장까지 성장 | (미제기) |
| Q5 | 등급 XP 배수 | **레전드가 느리게**(1.3/1.2/1.0/0.85/0.7) — *hero 미응답, 권장 기본값 채택.* §2.8.1 #14 로 **무배포 조정 가능**하므로 실플레이 후 언제든 변경 | 현행 유지(레전드 7.5배 빠름) |

**추가 하드 AC (hero 2026-08-02)**: §2.8 — 새 계수 중 admin API 로 조정 불가한 것 **0개**. 전수 레지스트리 + 계약 테스트로 집행, 하드코딩 잔존 = FAIL.

---

## 5. 다음 단계

1. ~~설계 문서 hero 컨펌~~ ✅ (**게이트 1 통과**, §4)
2. 보상 화면 HTML 목업 — 로컬 파일만 (**게이트 2**)
3. 승인 후 구현: data(밴드 발행) → server-java(V38 + `GrowthTuning` + 정산 + admin API) → web(보상 탭 + 강화탭)
   각 웨이브 = module-implementer → **module-verifier 독립 검증 PASS** → 커밋
4. 구현 게이트: `npm test` · server-java `--rerun-tasks` · apps/web build + e2e · **§2.8.2 계수 레지스트리 계약** · **엔진 다시드 밸런스 스윕**(§2.2 리스크)
5. merge-ready SHA 를 main 에 보고 (main 직접 push 금지)

### 승계 인터페이스 (#412 — 어드민 선수 등록·기본 스탯 API)

이 에픽은 스코프를 늘리지 않는다. #412 가 이어받을 산출물은 넷:
1. **`GrowthTuning` 레지스트리** (§2.8.1 전수 32항 + `KNOBS` 열거) — 새 계수를 추가하는 방법의 정본
2. **오버레이 인프라** `growth_config_revisions`(V38) + `GET/PUT /api/admin/growth-config{,/history,/validate}` (§2.8.3) — #412 의 선수 스탯 API 가 그대로 얹힐 축
3. **초기 스탯 스키마** — `bands.<GRADE>.{startLo,startHi,growCeil}` 가 런타임 SoT. `players.attributes_json` 은 발행물이라 여전히 배포 필요 ← **#412 가 메울 갭**
4. **`GrowthLegacyBackfillService`** (§2.7) — `players` 부팅 임포트가 기존 행을 덮는 문제를 다루는 멱등 백필 선례
